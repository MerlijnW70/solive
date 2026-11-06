import { inspect } from "node:util";
import type { Address, TransactionSigner } from "@solana/kit";
import { U64_MAX } from "@intent-engine/core/internal";
import { type Transport, TransportLacks } from "@intent-engine/client";
import type { DeliveryOpener } from "@intent-engine/core";
import { isLedgerPath, memoized, PLAIN_HTTP_ON_PUBLIC, plainHttpOnPublic } from "@intent-engine/client/internal";
import { claimsOf } from "./agent/claims.js";
import { relayOf } from "./agent/relay.js";
import type { Command } from "./command-types.js";
import { messageSigner, transactionSigner } from "./ledger-keys.js";
import type { Runtime } from "./runtime.js";
import type { AgentContext } from "./agent/actions.js";
import { createThenUpload } from "./agent/create.js";
import { readerLines, specTextProblem, uploadFailed, uploadLine, uploadPlan, uploadsAfterSend, withUploadHint } from "./agent/spec-upload.js";
import { malformedRun, specPreflight } from "./agent/wallet/escrow-terms.js";
import { runProblem } from "./judge-run.js";
import { FETCH_CAPS, fetchBytes } from "./delivery-fetch.js";
import { loadEncryptionKeys } from "./sealed-commands.js";
import { getMandate, loadMandate, prepareAgentCreate, prepareMandate, prepareRevokeMandate } from "./agent/mandate.js";
import { listIntents } from "./agent/read.js";
import { prepareSignedIntent, previewSignedIntent, submitSignedIntent } from "./agent/signed.js";
import { approval, ask, finish, FlowRefused, hasTokens, inRaw, NOT_SENT, perform, signMessage } from "./flows.js";
import { MAX_EXPIRES_IN } from "./agent/create.js";
import { unfundedPreview, unfundedRefused } from "./wallet.js";

const SIGNED_FILE_VERSION = 1;

function relayAnything(signer: TransactionSigner, mint: Address) {
  return relayOf(signer, {
    maxLamports: U64_MAX,
    maxTtl: BigInt(MAX_EXPIRES_IN),
    perHour: Number.MAX_SAFE_INTEGER,
    hourlyLamports: U64_MAX,
    fees: new Map([[mint, 0n]]),
  });
}

async function rawFlowInput(
  transport: Transport,
  flow: string,
  input: Record<string, unknown>,
  signer: Address,
): Promise<Record<string, unknown>> {
  if (flow === "approve" || flow === "revoke-approval") {
    const mint = input["mint"] as Address;
    return inRaw(transport, input, mint, mint);
  }
  if (flow === "mandate-use") {
    if (!hasTokens(input)) {
      return input;
    }
    const owner = input["owner"] as Address;
    const id = input["id"] === undefined ? 0n : BigInt(input["id"] as string);
    const { mandate } = await loadMandate(transport, owner, signer, id);
    return inRaw(transport, input, mandate.inputMint, mandate.outputMint);
  }
  if (flow === "mandate-revoke") {
    return input;
  }
  return inRaw(transport, input, input["input_mint"] as Address, input["output_mint"] as Address);
}

export const WRONG_SPEC_REFUSED = (line: string): string => `${line}; nothing was sent; fix --spec-hash or the file at --spec-url, or pass --allow-wrong-spec to send anyway`;

async function createWithUpload(runtime: Runtime, url: string, ctx: AgentContext, raw: Record<string, unknown>, yes: boolean, openers: readonly DeliveryOpener[]) {
  const { spec_file: specFile, publish_spec: publish, allow_wrong_spec: allowed, encryption_keypair: _keys, ...terms } = raw as { spec_file?: string; publish_spec?: false; allow_wrong_spec?: true; encryption_keypair?: string[] } & Record<string, unknown>;
  const specHash = (terms["order"] as { spec_hash?: string } | undefined)?.spec_hash;
  if (specHash === undefined) {
    return { terms };
  }
  const specText = specFile === undefined ? undefined : await runtime.readText(specFile).catch(() => {
    throw new FlowRefused(`${specFile} could not be read; nothing was sent`);
  });
  const wrong = specText === undefined ? undefined : specTextProblem(specText, specHash);
  if (wrong !== undefined) {
    throw new FlowRefused(`--spec-file ${specFile} ${wrong}`);
  }
  const unrunnable = specText === undefined ? undefined : runProblem(new TextEncoder().encode(specText));
  if (unrunnable !== undefined) {
    throw new FlowRefused(`--spec-file ${specFile}: ${malformedRun(unrunnable)}`);
  }
  const specUrl = terms["spec_url"] as string | undefined;
  const found = specUrl === undefined ? undefined : await fetchBytes(runtime.specFetch, ctx.transport, specUrl, runtime.lookup, FETCH_CAPS.tools);
  const reach: AgentContext = { ...ctx, url, fetch: runtime.specFetch, lookup: runtime.lookup };
  const plan = await uploadPlan(reach, { specHash, specText, found, publish });
  const attestor = (terms["order"] as { attestor?: Address } | undefined)?.attestor;
  const checked = found === undefined || attestor === undefined ? undefined : await specPreflight(reach, found, specHash, attestor, openers);
  if (checked?.malformed !== undefined) {
    throw new FlowRefused(`--spec-url ${specUrl ?? ""}: ${malformedRun(checked.malformed)}`);
  }
  if (yes && checked?.wrong === true && allowed !== true) {
    throw new FlowRefused(WRONG_SPEC_REFUSED(checked.lines.at(-1) ?? ""));
  }
  return { terms, reach, plan, hasUrl: specUrl !== undefined, warnings: [...(checked?.lines ?? []), ...readerLines(plan, specUrl !== undefined)] };
}

function context(transport: Transport, relay: AgentContext["relay"] = undefined): AgentContext {
  return { transport, relay, agent: undefined, claims: claimsOf() };
}

type FlowCommand = Extract<Command, { name: "flow" | "lookup" | "signed-prepare" | "signed-submit" }>;

export async function flowCommand(command: FlowCommand, runtime: Runtime, transport: Transport): Promise<object> {
  switch (command.name) {
    case "flow": {
      const signer = await transactionSigner(runtime, command.keypair);
      const reading = memoized(transport);
      const ctx = context(reading);
      const raw = await rawFlowInput(reading, command.flow, command.input, signer.address);
      switch (command.flow) {
        case "create": {
          const specUrl = raw["spec_url"];
          if (typeof specUrl === "string" && (await plainHttpOnPublic(reading, specUrl))) {
            throw new FlowRefused(`--spec-url ${specUrl} ${PLAIN_HTTP_ON_PUBLIC}`);
          }
          const own = isLedgerPath(command.keypair) ? [] : await runtime.loadKeypair(command.keypair).then((key) => [key], () => []);
          const openers = [...own, ...(await loadEncryptionKeys(runtime, raw["encryption_keypair"] as string[] | undefined))];
          const upload = await createWithUpload(runtime, command.url, ctx, raw, command.yes, openers);
          const warned = (shown: object) => {
            const lines = upload.warnings ?? [];
            return lines.length === 0 ? shown : { ...shown, warnings: [...((shown as { warnings?: string[] }).warnings ?? []), ...lines] };
          };
          const previewed = (shown: object) => warned(upload.plan === undefined ? shown : { ...shown, summary: [...(shown as { summary: string[] }).summary, uploadLine(upload.plan, "--no-publish-spec")] });
          const held = (await reading.getAccount(signer.address))?.lamports ?? 0n;
          if (held > 0n) {
            const made = (await perform(createThenUpload, ctx, { owner: signer.address, ...upload.terms }, signer, command.yes)) as Record<string, unknown>;
            if (!command.yes || upload.plan === undefined) {
              return previewed(made);
            }
            const { fields, failed } = await uploadsAfterSend(upload.reach, [upload.plan]);
            return { ...warned(made), ...fields[0], ...(failed ? { next: withUploadHint(made["next"], uploadFailed(upload.hasUrl)) } : {}) };
          }
          if (command.yes) {
            throw new FlowRefused(unfundedRefused(signer.address, command.url));
          }
          const shown = await perform(createThenUpload, { ...ctx, skipSimulation: true }, { owner: signer.address, ...upload.terms }, signer, false);
          return { ...previewed(shown), simulated: false, next: unfundedPreview(signer.address, command.url) };
        }
        case "mandate-grant":
          return perform(prepareMandate, ctx, { owner: signer.address, ...raw }, signer, command.yes);
        case "mandate-revoke":
          return perform(prepareRevokeMandate, ctx, { owner: signer.address, ...raw }, signer, command.yes);
        case "mandate-use":
          return perform(prepareAgentCreate, ctx, { agent: signer.address, ...raw }, signer, command.yes);
        case "approve":
        case "revoke-approval": {
          const input = raw as { mint: Address; amount?: string };
          return approval(
            transport,
            signer,
            input.mint,
            input.amount === undefined ? undefined : BigInt(input.amount),
            command.yes,
          );
        }
      }
      throw new FlowRefused(`unknown flow ${String(command.flow)}`);
    }
    case "lookup": {
      const owner =
        (command.input["owner"] as Address | undefined) ??
        (command.keypair === undefined ? undefined : (await runtime.loadSigner(command.keypair)).address);
      if (owner === undefined) {
        throw new FlowRefused("name the owner with --owner or --keypair");
      }
      const action = command.lookup === "list" ? listIntents : getMandate;
      return ask(action, context(transport), { ...command.input, owner });
    }
    case "signed-prepare": {
      const owner = await messageSigner(runtime, command.keypair);
      const input = await inRaw(
        transport,
        command.input,
        command.input["input_mint"] as Address,
        command.input["output_mint"] as Address,
      );
      if (command.yes && (await runtime.readText(command.out).then(() => true, () => false))) {
        throw new FlowRefused(`${command.out} already exists; choose another --out`);
      }
      const value = await ask(prepareSignedIntent, context(transport), { owner: owner.address, ...input });
      if (!command.yes) {
        return finish(transport, value, owner, false);
      }
      const signature = await signMessage(owner, value["message"] as string);
      const shown = await finish(transport, value, owner, true);
      await runtime.writeText(
        command.out,
        `${JSON.stringify({ version: SIGNED_FILE_VERSION, submit: value["submit"], signature }, null, 2)}\n`,
      );
      return { ...shown, saved: command.out };
    }
    case "signed-submit": {
      const relayer = await runtime.loadSigner(command.keypair);
      let saved: { version?: unknown; submit?: Record<string, unknown>; signature?: unknown };
      try {
        saved = JSON.parse(await runtime.readText(command.file)) as typeof saved;
      } catch {
        throw new FlowRefused(`${command.file} is not a signed intent file`);
      }
      if (saved.version !== SIGNED_FILE_VERSION || saved.submit === undefined || typeof saved.signature !== "string") {
        throw new FlowRefused(`${command.file} is not a signed intent file`);
      }
      const signed = { ...saved.submit, signature: saved.signature };
      if (!command.yes) {
        return { ...(await ask(previewSignedIntent, context(transport), signed)), sent: false, next: NOT_SENT };
      }
      return { ...(await ask(submitSignedIntent, context(transport, relayAnything(relayer, String(saved.submit["input_mint"]) as Address)), signed)), sent: true };
    }
  }
}

export async function signatureLookup(transport: Transport, signature: string, validUntil: bigint | undefined): Promise<object> {
  if (transport.sendStatus === undefined) {
    throw new TransportLacks("sendStatus");
  }
  const found = await transport.sendStatus(signature, validUntil);
  if (found.status !== "failed") {
    return found;
  }
  return {
    status: found.status,
    signature: found.signature,
    program: found.program,
    ...(found.engine === undefined ? {} : { engine_error: found.engine.name }),
    error: inspect(found.err, { depth: null, breakLength: Infinity }),
    ...(found.logs === undefined ? {} : { logs: found.logs }),
  };
}
