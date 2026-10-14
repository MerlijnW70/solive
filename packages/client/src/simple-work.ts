import { type Address, isKeyPairSigner } from "@solana/kit";
import { formatAmount, isSha256Hex } from "@intent-engine/core";
import { NotSettleable } from "./client-errors.js";
import { intentAt } from "./jobs.js";
import { outcome, type SimpleContext } from "./simple-orders.js";
import { nameOfMint, wholeTokens } from "./simple-tokens.js";
import type { CancelInput, DeliverWorkInput, OpenWork, ReleaseInput } from "./simple-types.js";

export const RELEASE_NEEDS_KEY_PAIR = "release signs the judge's verdict, so connect with a key pair signer";

export function workSends(ctx: SimpleContext) {
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
    if (!isSha256Hex(input.sha256.trim().toLowerCase())) {
      throw new RangeError("sha256 must be 64 hex digits");
    }
    const sha256 = input.sha256.trim().toLowerCase();
    const summary = `Deliver work ${sha256} at ${input.url} for escrow ${input.escrow}`;
    return outcome(ctx, input.preview, summary, async (client) => ({
      signature: await client.deliver({ worker: ctx.signer, intent: input.escrow, sha256, url: input.url }),
    }));
  };

  const release = async (input: ReleaseInput) => {
    const judge = ctx.signer;
    if (!isKeyPairSigner(judge)) {
      throw new TypeError(RELEASE_NEEDS_KEY_PAIR);
    }
    const { intent, mint } = await held(input.escrow);
    const result = BigInt(input.result ?? 1n);
    const summary = `Release escrow ${input.escrow} holding ${wholeTokens(intent.escrowed - intent.filled, mint.decimals, intent.inputMint)} to ${input.to} for work ${input.deliveredSha256.toLowerCase()}`;
    return outcome(ctx, input.preview, summary, async (client) => ({
      signature: await client.settleProof({
        judge,
        owner: intent.owner,
        nonce: intent.nonce,
        payTo: input.to,
        result,
        deliveredSha256: input.deliveredSha256,
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

  return { findWork, deliver, release, cancel };
}
