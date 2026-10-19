import { type Address, getAddressDecoder } from "@solana/kit";
import { findIntentPda, formatAmount } from "@intent-engine/core";
import {
  announcements,
  createClient,
  deliveryInstructions,
  deliveryRecord,
  loadConfig,
  mintOf,
  type Transport,
} from "@intent-engine/client";
import { escrowReceipt, recordingOf } from "./agent/wallet.js";
import type { Command } from "./command-types.js";
import type { Runtime } from "./runtime.js";
import { previewed } from "./admin-commands.js";
import { artifactSha256 } from "./artifact.js";
import { pricedJobs } from "./job-filters.js";
import { transactionSigner } from "./ledger-keys.js";

export const NOT_RELEASED = "no release of this escrow is among its recent transactions; show intent says whether it is still open, and --release with the release's signature reads a release directly";

const TOKEN_ACCOUNT_HEAD = 64;

async function receiptOf(transport: Transport, url: string, intent: Address, wanted: string | undefined): Promise<object> {
  const events = await createClient({ url, transport }).history(intent);
  const created = events.find((event) => event.name === "IntentCreated");
  let mint = created?.name === "IntentCreated" ? created.fields.inputMint : undefined;
  const release = events.find((event) => event.name === "IntentAttested" || event.name === "IntentSplit");
  if (release === undefined || (release.name !== "IntentAttested" && release.name !== "IntentSplit")) {
    return { intent, released: false, next: NOT_RELEASED };
  }
  const recorded = release.deliveredSha256;
  const common = {
    intent,
    released: true,
    attestor: release.fields.attestor,
    result: release.fields.result,
    signature: release.signature,
    ...(recorded === undefined ? {} : { delivered_sha256: recorded }),
    ...(wanted === undefined ? {} : { matches: wanted === recorded }),
  };
  const paid = async (net: bigint) => formatAmount(net, mint === undefined ? undefined : (await mintOf(transport, mint)).decimals);
  if (release.name === "IntentSplit") {
    return { ...common, paid: await paid(release.fields.net), recipients: BigInt(release.fields.recipients) };
  }
  const payee = release.fields.payee;
  const held = await transport.getAccount(payee);
  const head = held === null || held.data.length < TOKEN_ACCOUNT_HEAD ? null : held.data;
  mint ??= head === null ? undefined : getAddressDecoder().decode(head.subarray(0, 32));
  return {
    ...common,
    ...(head === null ? {} : { paid_to: getAddressDecoder().decode(head.subarray(32, TOKEN_ACCOUNT_HEAD)) }),
    payee,
    paid: await paid(release.fields.net),
  };
}

type JobCommand = Extract<Command, { name: "jobs" | "deliver" | "receipt" | "record-delivery" | "deliveries" }>;

export async function jobCommand(command: JobCommand, runtime: Runtime, transport: Transport): Promise<object> {
  switch (command.name) {
    case "jobs":
      return {
        jobs: (await pricedJobs(transport, command, (await loadConfig(transport)).config)).map(({ netPay, payable, ...job }) => ({
          ...job,
          net_pay: netPay,
          payable,
        })),
      };
    case "deliver": {
      const worker = await transactionSigner(runtime, command.keypair);
      const { intent, workUrl } = command;
      const sha256 = "sha256" in command ? command.sha256 : await artifactSha256(command.artifact);
      const { attestor, instructions } = await deliveryInstructions(transport, { worker, intent, sha256, url: workUrl });
      const shown = {
        intent,
        attestor,
        summary: [
          `Announces: the work with sha256 ${sha256} at ${workUrl}, for the proof escrow ${intent}`,
          `Notifies: its judge ${attestor}, with a transfer of 0 lamports from ${worker.address}, which signs and pays the fee`,
        ],
      };
      return previewed(transport, instructions, worker, shown, command.yes);
    }
    case "receipt": {
      if (command.release !== undefined) {
        return escrowReceipt(transport, command.owner, command.nonce, command.sha256, command.release);
      }
      const [intent] = await findIntentPda({ owner: command.owner, nonce: command.nonce });
      return receiptOf(transport, command.url, intent, command.sha256);
    }
    case "record-delivery": {
      const judge = await runtime.loadSigner(command.keypair);
      const recording = await recordingOf(transport, judge, command.owner, command.nonce, command.sha256, command.release);
      const { intent, release, sha256, memo, summary, instructions } = recording;
      return previewed(transport, instructions, judge, { intent, release, sha256, memo, summary }, command.yes);
    }
    case "deliveries": {
      const record = await deliveryRecord(transport, command.attestor, command.intent, command.maxPages);
      return {
        intent: command.intent,
        complete: record.complete,
        deliveries: announcements(record.deliveries).map(({ sha256, first, copies }) => ({
          sha256,
          worker: first.worker,
          url: first.url,
          signature: first.signature,
          slot: first.slot,
          copies,
        })),
      };
    }
  }
}
