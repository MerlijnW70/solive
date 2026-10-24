import { type Address, isMessagePartialSigner } from "@solana/kit";
import { formatAmount } from "@intent-engine/core";
import { NotSettleable } from "./client-errors.js";
import { intentAt } from "./jobs.js";
import { outcome, type SimpleContext } from "./simple-orders.js";
import { sha256Given, workReads } from "./simple-reads.js";
import { nameOfMint, wholeTokens } from "./simple-tokens.js";
import type { CancelInput, DeliveredWork, DeliverWorkInput, OpenWork, Preview, ReleaseInput } from "./simple-types.js";

export const RELEASE_NEEDS_KEY_PAIR = "release signs the judge's verdict, so connect with a signer that also signs messages";

export const notFirstAnnouncer = (worker: Address, announcement: Address, sha256: string, to: Address): string =>
  `pays ${worker}, who announced the work ${sha256} first, in ${announcement}, not ${to}; nothing was sent`;

export function workSends(ctx: SimpleContext) {
  const { deliveries, receipt } = workReads(ctx);

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

  const deliver = async (input: DeliverWorkInput): Promise<DeliveredWork | Preview> => {
    const sha256 = sha256Given(input.sha256, "sha256");
    const summary = `Deliver work ${sha256} at ${input.url} for escrow ${input.escrow}`;
    const work = { worker: ctx.signer, intent: input.escrow, sha256, url: input.url };
    if (input.preview === true) {
      const plan = await ctx.client.prepareAnnouncement(work);
      return { summary, instructions: plan.existing === null ? [...plan.setup, ...plan.instructions] : [] };
    }
    const { signature, announcement, seq } = await ctx.client.announce(work);
    return { signature, announcement, seq, summary };
  };

  const release = async (input: ReleaseInput) => {
    const judge = ctx.signer;
    if (!isMessagePartialSigner(judge)) {
      throw new TypeError(RELEASE_NEEDS_KEY_PAIR);
    }
    const sha256 = sha256Given(input.deliveredSha256, "deliveredSha256");
    const { intent, mint } = await held(input.escrow);
    const first = await ctx.client.firstOpening({ intent: input.escrow, sha256, keypair: input.keypair });
    if (input.to !== undefined && input.to !== first.worker) {
      throw new NotSettleable(input.escrow, notFirstAnnouncer(first.worker, first.announcement, sha256, input.to));
    }
    const result = BigInt(input.result ?? 1n);
    const summary = `Release escrow ${input.escrow} holding ${wholeTokens(intent.escrowed - intent.filled, mint.decimals, intent.inputMint)} to ${first.worker} for work ${sha256}, announced first in ${first.announcement}`;
    return outcome(ctx, input.preview, summary, async (client) => ({
      signature: await client.settleProof({
        judge,
        owner: intent.owner,
        nonce: intent.nonce,
        announcement: first.announcement,
        opening: first,
        result,
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
