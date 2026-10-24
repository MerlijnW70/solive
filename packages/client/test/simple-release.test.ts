import { createHash, generateKeyPairSync } from "node:crypto";
import { type Address, createKeyPairSignerFromBytes, type KeyPairSigner, lamports, none, type Signature } from "@solana/kit";
import { getMintEncoder, getMintSize } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT as TEST, feeBpsFor, findAssociatedTokenAddress, IntentStatus, Kind, NATIVE_MINT as WSOL, splitFees, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { connect, nothingOpens, notFirstAnnouncer, NotSettleable, releaseStandingOf, type SimpleClient } from "../src/index.js";
import { funded, world, type World } from "./svm.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const WORK = sha("the delivered work");
const SPEC = sha("the acceptance spec");
const WORK_URL = "https://" + "example.org/work.tar";
const PAY = 10_000_000n;

function preset(w: World, at: Address): void {
  const space = BigInt(getMintSize());
  w.chain.svm.setAccount({
    address: at,
    data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() })),
    executable: false,
    lamports: lamports(w.chain.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

async function devnet(): Promise<World> {
  const w = await world();
  preset(w, WSOL);
  preset(w, TEST);
  return w;
}

async function keyed(w: World): Promise<{ signer: KeyPairSigner; keypair: Uint8Array }> {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const keypair = Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
  const signer = await createKeyPairSignerFromBytes(keypair);
  w.chain.svm.airdrop(signer.address, lamports(10_000_000_000n));
  return { signer, keypair };
}

const nextSlot = (w: World) => w.chain.svm.warpToSlot(w.chain.svm.getClock().slot + 1n);

function tokens(w: World, account: Address): bigint | null {
  const found = w.chain.svm.getAccount(account);
  return found.exists ? new DataView(found.data.buffer, found.data.byteOffset).getBigUint64(64, true) : null;
}

async function job() {
  const w = await devnet();
  const owner = await funded(w.chain);
  const judge = await keyed(w);
  const at = (signer: KeyPairSigner) => connect({ cluster: "devnet", signer, transport: w.chain.transport });
  const buyer = await at(owner);
  const reviewer = await at(judge.signer);
  const made = await buyer.payForWork({ amount: "0.01", judge: judge.signer.address, specHash: SPEC });
  return { w, owner, judge, buyer, reviewer, at, escrow: made.intent as Address, nonce: made.nonce ?? 0n };
}

async function announced(seller: SimpleClient, escrow: Address, judge: Address, open: boolean): Promise<Signature> {
  const { signature } = await seller.deliver({ escrow, sha256: WORK, url: WORK_URL });
  if (open) {
    await seller.client.openDelivery({ worker: seller.signer, intent: escrow, attestor: judge, sha256: WORK, announcement: signature });
  }
  return signature;
}

describe("the simple release credits the first worker who announced and opened the work", () => {
  it("pays the opened announcement with its salt, so the release is valid and the worker gains reputation", async () => {
    const { w, judge, buyer, reviewer, at, escrow, nonce } = await job();
    const worker = await funded(w.chain);
    const seller = await at(worker);
    const announcement = await announced(seller, escrow, judge.signer.address, true);

    const preview = await reviewer.release({ escrow, deliveredSha256: WORK.toUpperCase(), preview: true });
    expect(preview.summary).toBe(`Release escrow ${escrow} holding 0.01 SOL to ${worker.address} for work ${WORK}, announced first in ${announcement}`);
    expect(preview.instructions.length).toBeGreaterThan(0);
    expect((await buyer.client.intent(buyer.signer.address, nonce))?.intent.status).toBe(IntentStatus.Open);

    const released = await reviewer.release({ escrow, to: worker.address, deliveredSha256: WORK });
    expect(w.chain.sent).toContain(released.signature);
    const { net } = splitFees(PAY, feeBpsFor(await buyer.client.config(), Kind.AttestedResult), 0, 0);
    expect(tokens(w, await findAssociatedTokenAddress({ owner: worker.address, mint: WSOL, tokenProgram: TOKEN_PROGRAM_ADDRESS }))).toBe(net);

    const history = await buyer.client.history(escrow);
    const event = history.find(({ name }) => name === "IntentAttested");
    const created = history.find(({ name }) => name === "IntentCreated");
    expect(event).toMatchObject({ signature: released.signature, deliveredSha256: WORK, deliveredSalt: expect.stringMatching(/^[0-9a-f]{32}$/) });
    const standing = await releaseStandingOf(w.chain.transport, {
      intent: escrow,
      attestor: judge.signer.address,
      release: { slot: event?.slot ?? 0n },
      recorded: { sha256: WORK, salt: event?.deliveredSalt ?? "" },
      payees: [worker.address],
      createdAt: created?.blockTime ?? null,
      from: created?.slot ?? null,
    });
    expect(standing).toEqual({ valid: true, refutedBy: null, complete: true });
    expect(await buyer.client.reputation(worker.address)).toMatchObject({ paid: 1, refuted: 0 });

    expect(await buyer.receipt({ escrow })).toMatchObject({
      escrow,
      released: true,
      signature: released.signature,
      payee: worker.address,
      deliveredSha256: WORK,
      valid: true,
      refutedBy: null,
      complete: true,
    });
    expect(await buyer.deliveries({ escrow })).toEqual([{ worker: worker.address, sha256: WORK, url: null, opened: true, signature: announcement }]);
  });

  it("refuses a to that is not the first announcer and names the worker who announced first", async () => {
    const { w, judge, reviewer, at, escrow } = await job();
    const [first, later] = [await funded(w.chain), await funded(w.chain)];
    const before = await announced(await at(first), escrow, judge.signer.address, true);
    nextSlot(w);
    await announced(await at(later), escrow, judge.signer.address, true);
    const sent = w.chain.sent.length;
    const refused = reviewer.release({ escrow, to: later.address, deliveredSha256: WORK });
    await expect(refused).rejects.toThrow(NotSettleable);
    await expect(refused).rejects.toThrow(notFirstAnnouncer(first.address, before, WORK, later.address));
    expect(w.chain.sent.length).toBe(sent);
    const listed = await reviewer.deliveries({ escrow, sha256: WORK });
    expect(listed.map(({ worker, opened }) => [worker, opened])).toEqual([
      [first.address, true],
      [later.address, true],
    ]);
  });

  it("refuses when no announcement opens to the work, and pays once the judge's key opens it", async () => {
    const { w, judge, reviewer, at, escrow } = await job();
    const worker = await funded(w.chain);
    const announcement = await announced(await at(worker), escrow, judge.signer.address, false);
    const sent = w.chain.sent.length;
    const refused = reviewer.release({ escrow, deliveredSha256: WORK });
    await expect(refused).rejects.toThrow(NotSettleable);
    await expect(refused).rejects.toThrow(nothingOpens(WORK));
    await expect(reviewer.release({ escrow, deliveredSha256: sha("other work"), keypair: judge.keypair })).rejects.toThrow(nothingOpens(sha("other work")));
    expect(w.chain.sent.length).toBe(sent);
    expect(await reviewer.deliveries({ escrow, sha256: WORK })).toEqual([{ worker: worker.address, sha256: null, url: null, opened: false, signature: announcement }]);
    expect(await reviewer.deliveries({ escrow, sha256: WORK, keypair: judge.keypair })).toEqual([
      { worker: worker.address, sha256: WORK, url: WORK_URL, opened: true, signature: announcement },
    ]);
    const released = await reviewer.release({ escrow, deliveredSha256: WORK, keypair: judge.keypair });
    expect(w.chain.sent).toContain(released.signature);
    expect(await reviewer.receipt({ escrow })).toMatchObject({ released: true, payee: worker.address, deliveredSha256: WORK, valid: true });
  });

  it("refuses when an earlier announcement does not open with the keys given, and pays that earlier worker once it opens", async () => {
    const { w, judge, reviewer, at, escrow } = await job();
    const [sealed, copier] = [await funded(w.chain), await funded(w.chain)];
    const first = await announced(await at(sealed), escrow, judge.signer.address, false);
    nextSlot(w);
    await announced(await at(copier), escrow, judge.signer.address, true);
    const sent = w.chain.sent.length;
    const refused = reviewer.release({ escrow, deliveredSha256: WORK });
    await expect(refused).rejects.toThrow(NotSettleable);
    await expect(refused).rejects.toThrow(`has an earlier announcement ${first} by ${sealed.address} sealed to the key derived from the judge's wallet`);
    expect(w.chain.sent.length).toBe(sent);
    await expect(reviewer.release({ escrow, to: copier.address, deliveredSha256: WORK, keypair: judge.keypair })).rejects.toThrow(notFirstAnnouncer(sealed.address, first, WORK, copier.address));
    const released = await reviewer.release({ escrow, deliveredSha256: WORK, keypair: judge.keypair });
    expect(w.chain.sent).toContain(released.signature);
    expect(await reviewer.receipt({ escrow })).toMatchObject({ released: true, payee: sealed.address, deliveredSha256: WORK, valid: true });
  });

  it("reads an escrow nobody released yet", async () => {
    const { buyer, escrow } = await job();
    expect(await buyer.receipt({ escrow })).toEqual({
      escrow,
      released: false,
      signature: null,
      payee: null,
      payees: [],
      deliveredSha256: null,
      valid: false,
      refutedBy: null,
      complete: true,
      summary: `Escrow ${escrow} is not released yet`,
    });
    expect(await buyer.deliveries({ escrow })).toEqual([]);
  });
});
