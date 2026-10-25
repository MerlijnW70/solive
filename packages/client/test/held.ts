import type { Address, KeyPairSigner } from "@solana/kit";
import { Kind } from "@intent-engine/core";
import { findIntentPda, signMessageBytes, splitFee, splitN } from "@intent-engine/core/internal";
import { createClient } from "../src/index.js";
import { FEE_BPS, world } from "./svm.js";
import { ata22, mint22, requireMemos, tokens22 } from "./token22.js";
import { announced, fundedSigner, LOCAL, sha, specHash } from "./work.js";

export const PAY = 1_000_000n;
export const WEIGHTS = [6_000, 4_000];
export const NET = PAY - splitFee(PAY, FEE_BPS).fee;
export const SHARES = splitN(NET, WEIGHTS);

export type HeldWorld = Awaited<ReturnType<typeof heldWorld>>;

export async function heldWorld() {
  const w = await world();
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const mint = await mint22(w);
  await tokens22(w, w.owner.address, mint, PAY * 10n);
  const [announcer, blocked, judge] = await Promise.all([fundedSigner(w), fundedSigner(w), fundedSigner(w)]);
  const release = async (block: (account: Address) => Promise<void> = async () => undefined, tag = "held") => {
    const { nonce } = await client.createIntent({
      signer: w.owner,
      params: { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: specHash(tag), judgeFee: 0n },
      inputMint: mint,
      outputMint: w.outputMint,
    });
    const [intent] = await findIntentPda({ owner: w.owner.address, nonce });
    const delivered = await announced(client, announcer, intent, sha(tag));
    await announced(client, blocked, intent, sha(tag));
    await block(await ata22(blocked.address, mint));
    const recipients = [
      { wallet: announcer.address, weight: WEIGHTS[0] ?? 0 },
      { wallet: blocked.address, weight: WEIGHTS[1] ?? 0 },
    ];
    const target = { intent: { owner: w.owner.address, nonce }, ...delivered, result: 1n, recipients };
    const ballot = await client.splitBallot(target);
    const signatures = await Promise.all([announcer, blocked].map(async (coauthor: KeyPairSigner) => ({ wallet: coauthor.address, signature: await signMessageBytes(coauthor, ballot.message) })));
    const signature = await client.settleSplit({ ...target, judge, signatures });
    return { intent, nonce, announcement: delivered.announcement, signature };
  };
  const memoRequired = async (account: Address) => {
    await tokens22(w, blocked.address, mint, 0n);
    await requireMemos(w, blocked, account);
  };
  const treasuryMemos = async () => {
    await requireMemos(w, w.feeRecipient, await tokens22(w, w.feeRecipient.address, mint, 0n));
  };
  return { w, client, mint, announcer, blocked, judge, release, memoRequired, treasuryMemos };
}
