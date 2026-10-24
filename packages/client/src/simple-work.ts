import { type Address, isMessagePartialSigner } from "@solana/kit";
import { formatAmount } from "@intent-engine/core";
import { NotSettleable } from "./client-errors.js";
import { intentAt } from "./jobs.js";
import { outcome, type SimpleContext } from "./simple-orders.js";
import { firstOpened, sha256Given, workReads } from "./simple-reads.js";
import { nameOfMint, wholeTokens } from "./simple-tokens.js";
import type { CancelInput, DeliverWorkInput, OpenWork, ReleaseInput } from "./simple-types.js";
import { type MissingKey, unopenedOf } from "./unopened.js";

export const RELEASE_NEEDS_KEY_PAIR = "release signs the judge's verdict, so connect with a signer that also signs messages";

export const recordIncomplete = (sha256: string): string =>
  `has a delivery record too long to read in full, so the first worker who announced the work ${sha256} cannot be known; nothing was sent`;

export const nothingOpens = (sha256: string): string =>
  `has no announcement that opens to the work ${sha256}: the worker announces it with deliver, then opens it with client.openDelivery, or the judge passes keypair to open the announcements sealed to it; nothing was sent`;

export const notFirstAnnouncer = (worker: Address, announcement: string, sha256: string, to: Address): string =>
  `pays ${worker}, who announced the work ${sha256} first, in ${announcement}, not ${to}; nothing was sent`;

export const sealedEarlier = ({ delivery, key }: MissingKey): string =>
  `has an earlier announcement ${delivery.signature} by ${delivery.worker} sealed to ${
    key.kind === "wallet" ? "the key derived from the judge's wallet" : `the encryption key ${key.key} the judge's profile named`
  }, which none of the keys given opens, so the first worker who announced the work cannot be known; pass keypair with that key; nothing was sent`;

export function workSends(ctx: SimpleContext) {
  const { recordOf, deliveries, receipt } = workReads(ctx);

  const held = async (address: Address) => {
    const intent = await intentAt(ctx.client.transport, address);
    if (intent === null) {
      throw new NotSettleable(address, "is not an intent account of the engine");
    }
    return { intent, mint: await ctx.client.mint(intent.inputMint) };
  };

  const findWork = async (filter: { judge?: Address } = {}): Promise<OpenWork[]> => {
    const jobs = await ctx.client.jobs(filter.judge === undefined ? {} : { attestor: filter.judge });
    return Promise.all(
      jobs.map(async (job) => {
        const { decimals } = await ctx.client.mint(job.inputMint);
        return { ...job, amount: formatAmount(job.sells, decimals), fee: formatAmount(job.judgeFee, decimals), token: nameOfMint(job.inputMint) };
      }),
    );
  };

  const deliver = async (input: DeliverWorkInput) => {
    const sha256 = sha256Given(input.sha256, "sha256");
    const summary = `Deliver work ${sha256} at ${input.url} for escrow ${input.escrow}`;
    return outcome(ctx, input.preview, summary, async (client) => ({
      signature: await client.deliver({ worker: ctx.signer, intent: input.escrow, sha256, url: input.url }),
    }));
  };

  const release = async (input: ReleaseInput) => {
    const judge = ctx.signer;
    if (!isMessagePartialSigner(judge)) {
      throw new TypeError(RELEASE_NEEDS_KEY_PAIR);
    }
    const sha256 = sha256Given(input.deliveredSha256, "deliveredSha256");
    const { intent, mint } = await held(input.escrow);
    const record = await recordOf(input.escrow, input.keypair);
    if (!record.complete) {
      throw new NotSettleable(input.escrow, recordIncomplete(sha256));
    }
    const first = firstOpened(record, sha256);
    if (first === null) {
      throw new NotSettleable(input.escrow, nothingOpens(sha256));
    }
    const { missing } = await unopenedOf(ctx.client.transport, { judge: judge.address, recipients: [judge.address], deliveries: record.deliveries, first, openers: input.keypair });
    if (missing !== null) {
      throw new NotSettleable(input.escrow, sealedEarlier(missing));
    }
    if (input.to !== undefined && input.to !== first.worker) {
      throw new NotSettleable(input.escrow, notFirstAnnouncer(first.worker, first.signature, sha256, input.to));
    }
    const result = BigInt(input.result ?? 1n);
    const summary = `Release escrow ${input.escrow} holding ${wholeTokens(intent.escrowed - intent.filled, mint.decimals, intent.inputMint)} to ${first.worker} for work ${sha256}, announced first in ${first.signature}`;
    return outcome(ctx, input.preview, summary, async (client) => ({
      signature: await client.settleProof({
        judge,
        owner: intent.owner,
        nonce: intent.nonce,
        payTo: first.worker,
        result,
        deliveredSha256: sha256,
        deliveredSalt: first.salt,
      }),
      intent: input.escrow,
      nonce: intent.nonce,
    }));
  };

  const cancel = async (input: CancelInput) => {
    const address = input.escrow ?? input.intent;
    const { intent, mint } = await held(address);
    if (intent.owner !== ctx.signer.address) {
      throw new RangeError(`intent ${address} belongs to ${intent.owner}, not to ${ctx.signer.address}`);
    }
    const summary = `Cancel ${address} and return ${wholeTokens(intent.escrowed - intent.filled, mint.decimals, intent.inputMint)} to ${ctx.signer.address}`;
    return outcome(ctx, input.preview, summary, async (client) => ({
      signature: await client.cancel(ctx.signer, intent.nonce),
      intent: address,
      nonce: intent.nonce,
    }));
  };

  return { findWork, deliver, release, cancel, deliveries, receipt };
}
