import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Address, getBase58Decoder, type KeyPairSigner, type Signature } from "@solana/kit";
import { decodeParams, IntentStatus, Kind } from "@intent-engine/core";
import { chainTime, createClient, deliveryRecord, firstDelivery, loadIntent, SIGNATURE_PAGE, type Transport } from "@intent-engine/client";
import type { Command } from "./args.js";
import { NOT_SENT } from "./flows.js";
import type { Runtime } from "./commands.js";
import { type InterruptSignal, JudgeInterrupted, JudgeRefused, SIGNAL_EXIT } from "./judge-errors.js";
import { type Artifact, copyOf, readArtifact, removeCopy } from "./artifact.js";
import { type Check, checkEnv, type HeldSignals, holdSignals, runCheck } from "./check-process.js";

export { type InterruptSignal, JudgeInterrupted, JudgeRefused, SIGNAL_EXIT } from "./judge-errors.js";
export { artifactSha256, CLEANUP_RETRIES, removeCopy, SKIPPED, SPEC_COPY } from "./artifact.js";
export {
  type Check,
  CHECK_ENV,
  checkEnv,
  type CheckOptions,
  claim,
  ENV_ARTIFACT_PATH,
  ENV_ARTIFACT_SHA256,
  ENV_SPEC_PATH,
  leftRunning,
  type Recorded,
  runCheck,
  type Running,
  stillRunning,
} from "./check-process.js";

const FORCED_EXIT_MS = 200;

export type JudgeCommand = Extract<Command, { name: "judge" }>;

export type Verdict = {
  intent: Address;
  specHash: string;
  artifactSha256: string;
  command: string;
  exitCode: number | null;
  verdict: "pass" | "fail";
  payTo: Address;
  signature: Signature | null;
  next?: string;
  cleanup?: string;
};

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const pagesRead = (pages: number): string =>
  `It read ${pages} ${pages === 1 ? "page" : "pages"} of ${SIGNATURE_PAGE} signatures; a higher --max-pages reads further, but does not help when the RPC node's ledger does not reach back to the escrow's creation or the node cannot page signatures or report its first available slot`;

export const resultOutside = (result: bigint, intent: Address, min: bigint, max: bigint): string =>
  `--result ${result} lies outside the results intent ${intent} accepts, ${min} to ${max}; nothing was run or paid`;

async function escrowFor(transport: Transport, judge: Address, owner: Address, nonce: bigint) {
  const { address, intent } = await loadIntent(transport, owner, nonce);
  const params = decodeParams(intent.kind, Uint8Array.from(intent.params));
  if (params.kind !== Kind.AttestedResult || params.specHash.every((b) => b === 0)) {
    throw new JudgeRefused(`intent ${address} is not a proof escrow: an AttestedResult intent that commits a spec hash`);
  }
  if (intent.status !== IntentStatus.Open || intent.expiresAt <= (await chainTime(transport))) {
    throw new JudgeRefused(`intent ${address} is no longer open`);
  }
  if (params.attestor !== judge) {
    throw new JudgeRefused(`intent ${address} names ${params.attestor} as its judge, not ${judge}`);
  }
  return { address, specHash: hex(params.specHash), minResult: params.minResult, maxResult: params.maxResult };
}

export async function judge(command: JudgeCommand, runtime: Runtime, transport: Transport): Promise<Verdict> {
  if (command.verdict !== undefined) {
    await rm(command.verdict, { force: true });
  }
  const signer = await runtime.loadSigner(command.keypair);
  const { address, specHash, minResult, maxResult } = await escrowFor(transport, signer.address, command.owner, command.nonce);
  const result = command.result ?? minResult;
  if (result < minResult || result > maxResult) {
    throw new JudgeRefused(resultOutside(result, address, minResult, maxResult));
  }
  const specBytes = await readFile(resolve(command.spec));
  const specSha256 = createHash("sha256").update(specBytes).digest("hex");
  if (specSha256 !== specHash) {
    throw new JudgeRefused(`--spec ${command.spec} has sha256 ${specSha256}, but intent ${address} commits ${specHash}`);
  }
  const artifact = resolve(command.artifact);
  const read = await readArtifact(artifact);
  const sha256 = read.sha256;
  const record = await deliveryRecord(transport, signer.address, address, command.maxPages);
  if (!record.complete) {
    throw new JudgeRefused(
      `the delivery record is incomplete because the judge's history is too long to read in full or the RPC node cannot serve all of it, so the earliest announcer of the artifact with sha256 ${sha256} for intent ${address} cannot be known; nothing was run or paid. ${pagesRead(record.pages)}`,
    );
  }
  const first = firstDelivery(record.deliveries, sha256);
  const payTo = command.payTo ?? first?.worker;
  if (payTo === undefined) {
    throw new JudgeRefused(`nobody announced the artifact with sha256 ${sha256} for intent ${address}; pass --pay-to to pay a worker who did not announce it`);
  }
  if (first !== null && first.worker !== payTo) {
    throw new JudgeRefused(`${first.worker} announced the artifact with sha256 ${sha256} first, in ${first.signature}; it is paid, not --pay-to ${payTo}`);
  }
  const signals = holdSignals();
  try {
    return await checkAndSettle(command, transport, signer, signals, { address, specHash, sha256, payTo, result, read, specBytes });
  } finally {
    signals.release();
  }
}

export const notSent = (signal: InterruptSignal): string =>
  `the check passed, but ${signal} arrived before the release was sent; nothing was paid and no verdict was written`;

export const mayHaveLanded = (signal: InterruptSignal, address: Address, signature: Signature | undefined): string =>
  `the check passed and the release was sent${signature === undefined ? "" : ` in ${signature}`}; a second ${signal} stopped the judge before the send was confirmed, so the release may have landed. Read intent ${address} before judging it again; no verdict was written`;

type Release = { address: Address; payTo: Address; result: bigint; sha256: string };

function sendRelease(command: JudgeCommand, transport: Transport, signer: KeyPairSigner, signals: HeldSignals, release: Release): Promise<Signature> {
  return new Promise((done, failed) => {
    let sent = false;
    let signature: Signature | undefined;
    let after = 0;
    const signTransactions: KeyPairSigner["signTransactions"] = async (transactions, config) => {
      const caught = signals.caught();
      if (caught !== undefined) {
        throw new JudgeInterrupted(caught, notSent(caught));
      }
      sent = true;
      const signed = await signer.signTransactions(transactions, config);
      const own = signed[0]?.[signer.address];
      signature = own === undefined ? signature : (getBase58Decoder().decode(own) as Signature);
      return signed;
    };
    signals.listen((signal) => {
      if (!sent) {
        failed(new JudgeInterrupted(signal, notSent(signal)));
        return;
      }
      after += 1;
      if (after > 1) {
        failed(new JudgeInterrupted(signal, mayHaveLanded(signal, release.address, signature)));
        setTimeout(() => process.exit(SIGNAL_EXIT[signal]), FORCED_EXIT_MS).unref();
      }
    });
    createClient({ url: command.url, transport })
      .settleProof({
        judge: Object.freeze({ ...signer, signTransactions }),
        owner: command.owner,
        nonce: command.nonce,
        payTo: release.payTo,
        result: release.result,
        deliveredSha256: release.sha256,
      })
      .then((confirmed) => {
        signals.listen(() => undefined);
        done(confirmed);
      }, failed);
  });
}

type Judged = { address: Address; specHash: string; sha256: string; payTo: Address; result: bigint; read: Artifact; specBytes: Uint8Array };

async function checkAndSettle(
  command: JudgeCommand,
  transport: Transport,
  signer: KeyPairSigner,
  signals: HeldSignals,
  { address, specHash, sha256, payTo, result, read, specBytes }: Judged,
): Promise<Verdict> {
  const copy = await copyOf(read, specBytes);
  let check: Check = { exitCode: null, timedOut: false };
  let cleanup: string | undefined;
  try {
    if (signals.caught() === undefined) {
      check = await runCheck(command.run, checkEnv(process.env, copy.spec, copy.path, sha256), command.timeout, { cwd: copy.root });
    }
  } finally {
    cleanup = await removeCopy(copy.root);
  }
  const interrupted = check.interrupted ?? signals.caught();
  if (interrupted !== undefined) {
    throw new JudgeInterrupted(interrupted);
  }
  const passed = check.exitCode === 0;
  let signature: Signature | null = null;
  if (passed && command.yes) {
    try {
      signature = await sendRelease(command, transport, signer, signals, { address, payTo, result, sha256 });
    } catch (error) {
      if (error instanceof JudgeInterrupted) {
        throw error;
      }
      const during = signals.caught();
      if (during !== undefined) {
        throw new JudgeInterrupted(
          during,
          `the check passed and ${during} arrived while the release was being sent; the send failed, but the release may have landed: ${reasonOf(error)}. Read intent ${address} before judging it again; no verdict was written`,
        );
      }
      throw error;
    }
  }
  const verdict: Verdict = {
    intent: address,
    specHash,
    artifactSha256: sha256,
    command: command.run,
    exitCode: check.exitCode,
    verdict: passed ? "pass" : "fail",
    payTo,
    signature,
    ...(passed && !command.yes ? { next: NOT_SENT } : {}),
    ...(cleanup !== undefined ? { cleanup } : {}),
  };
  if (command.verdict !== undefined) {
    await writeFile(command.verdict, `${JSON.stringify(verdict, null, 2)}\n`);
  }
  const during = signals.caught();
  if (signature !== null && during !== undefined) {
    throw new JudgeInterrupted(
      during,
      `the check passed and ${during} arrived while the release was being sent; it was sent in ${signature}${command.verdict !== undefined ? ` and the verdict was written to ${command.verdict}` : ""}`,
    );
  }
  return verdict;
}
