import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports, none, some } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync, getMintEncoder, getMintSize, getMintToInstruction } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import {
  DEVNET_TEST_MINT as TEST,
  feeBpsFor,
  findAssociatedTokenAddress,
  IntentStatus,
  Kind,
  NATIVE_MINT as WSOL,
  splitFees,
  TOKEN_PROGRAM_ADDRESS,
} from "@intent-engine/core";
import {
  CLUSTER_URLS,
  connect,
  DEVNET_GENESIS_HASH,
  MAINNET_GENESIS_HASH,
  MainnetNotAllowed,
  mintOfToken,
  tokenAmount,
  type Transport,
} from "../src/index.js";
import { funded, world, type World } from "./svm.js";
import { keyed } from "./work.js";

function preset(w: World, at: Address, mintAuthority: Address | null): void {
  const space = BigInt(getMintSize());
  w.chain.svm.setAccount({
    address: at,
    data: Uint8Array.from(
      getMintEncoder().encode({
        mintAuthority: mintAuthority === null ? none() : some(mintAuthority),
        supply: 0n,
        decimals: 9,
        isInitialized: true,
        freezeAuthority: none(),
      }),
    ),
    executable: false,
    lamports: lamports(w.chain.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

async function devnet(): Promise<World> {
  const w = await world();
  preset(w, WSOL, null);
  preset(w, TEST, w.authority.address);
  return w;
}

const ata = (owner: Address, mint: Address) => findAssociatedTokenAddress({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });

function tokens(w: World, account: Address): bigint | null {
  const found = w.chain.svm.getAccount(account);
  return found.exists ? new DataView(found.data.buffer, found.data.byteOffset).getBigUint64(64, true) : null;
}

async function mintTest(w: World, owner: KeyPairSigner, amount: bigint): Promise<void> {
  await w.chain.transport.send(
    [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: w.authority, owner: owner.address, mint: TEST }),
      getMintToInstruction({ mint: TEST, token: await ata(owner.address, TEST), mintAuthority: w.authority, amount }),
    ],
    w.authority,
  );
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("the simple sdk layer", () => {
  it("connect then swap fills on the test engine", async () => {
    const w = await devnet();
    const signer = await funded(w.chain);
    const solive = await connect({ cluster: "devnet", signer, transport: w.chain.transport });
    expect(solive.url).toBe(CLUSTER_URLS.devnet);
    const swapped = await solive.swap({ sell: "SOL", amount: "0.05", buy: "TEST", minReceive: "5" });
    expect(swapped.summary).toBe("Swap 0.05 SOL for at least 5 TEST, open for 3600 seconds");
    expect(swapped.nonce).toBe(0n);
    expect(w.chain.sent).toContain(swapped.signature);
    const solver = await funded(w.chain);
    await mintTest(w, solver, 5_000_000_000n);
    await solive.client.fill({ solver, owner: signer.address, nonce: 0n });
    expect((await solive.client.intent(signer.address, 0n))?.intent.status).toBe(IntentStatus.Filled);
    const { tokens: held, summary } = await solive.balance();
    expect(held.map(({ token, amount }) => [token, amount])).toEqual([
      ["SOL", "0"],
      ["TEST", "5"],
    ]);
    expect(summary).toContain("5 TEST");
  });

  it("pay for work then release pays the worker", async () => {
    const w = await devnet();
    const [owner, worker, { signer: judge, keypair }] = [await funded(w.chain), await funded(w.chain), await keyed(w)];
    const at = (signer: KeyPairSigner) => connect({ cluster: "devnet", signer, transport: w.chain.transport });
    const [buyer, seller, reviewer] = await Promise.all([at(owner), at(worker), at(judge)]);
    const specHash = sha("the acceptance spec");
    const escrow = await buyer.payForWork({ amount: "0.01", judge: judge.address, specHash, judgeFee: "0.001" });
    expect(escrow.summary).toBe(`Pay 0.01 SOL for work judged by ${judge.address} against spec ${specHash}, judge fee 0.001 SOL, open for 86400 seconds`);
    const escrowAddress = escrow.intent as Address;
    const listed = (await seller.findWork({ judge: judge.address })).find(({ intent }) => intent === escrowAddress);
    expect(listed).toMatchObject({ amount: "0.01", fee: "0.001", token: "SOL", specHash });
    const work = sha("the delivered work");
    const delivered = await seller.deliver({ escrow: escrowAddress, sha256: work, url: "https://example.org/work.tar" });
    expect(w.chain.sent).toContain(delivered.signature);
    const released = await reviewer.release({ escrow: escrowAddress, to: worker.address, deliveredSha256: work, keypair });
    expect(released.summary).toBe(`Release escrow ${escrowAddress} holding 0.01 SOL to ${worker.address} for work ${work}, announced first in ${delivered.announcement}`);
    expect(w.chain.sent).toContain(released.signature);
    expect((await buyer.client.intent(owner.address, escrow.nonce ?? 0n))?.intent.status).toBe(IntentStatus.Filled);
    const pay = 10_000_000n;
    const judgeFee = 1_000_000n;
    const { net } = splitFees(pay - judgeFee, feeBpsFor(await buyer.client.config(), Kind.AttestedResult), 0, 0);
    expect(tokens(w, await ata(worker.address, WSOL))).toBe(net);
    expect(tokens(w, await ata(judge.address, WSOL))).toBe(judgeFee);
  });

  it("amounts are whole tokens with the mint decimals", async () => {
    expect(tokenAmount("0.05", 9)).toBe(50_000_000n);
    expect(tokenAmount("1.5", 6)).toBe(1_500_000n);
    expect(tokenAmount("12", 0)).toBe(12n);
    for (const bad of ["0.0000001", "-1", "1e3", "0", "", " ", "1.", ".5", "0x10"]) {
      expect(() => tokenAmount(bad, 6), bad).toThrow(RangeError);
    }
    expect(() => tokenAmount("0.0000001", 6)).toThrow("more than the token's 6 decimal places");
    expect(mintOfToken("SOL", CLUSTER_URLS.localnet)).toBe(WSOL);
    expect(mintOfToken("test", CLUSTER_URLS.devnet)).toBe(TEST);
    expect(() => mintOfToken("TEST", CLUSTER_URLS.localnet)).toThrow(RangeError);
    expect(() => mintOfToken("DOGE", CLUSTER_URLS.devnet)).toThrow(RangeError);

    const w = await devnet();
    const solive = await connect({ url: "http://127.0.0.1:8899", signer: w.owner, transport: w.chain.transport });
    const order = await solive.limit({ sell: w.inputMint, amount: "0.0005", buy: w.outputMint, price: "2.5", preview: true });
    expect(order.summary).toBe(`Limit order: sell 0.0005 ${w.inputMint} for at least 0.00125 ${w.outputMint} (2.5 ${w.outputMint} per ${w.inputMint}), open for 3600 seconds`);
    await expect(solive.swap({ sell: w.inputMint, amount: "0.0000001", buy: w.outputMint, minReceive: "1" })).rejects.toThrow("amount:");
    await expect(solive.swap({ sell: w.inputMint, amount: "0.001", buy: w.outputMint, minReceive: "-1" })).rejects.toThrow("minReceive:");
    const placed = await solive.swap({ sell: w.inputMint, amount: "0.000999", buy: w.outputMint, minReceive: "0.000001" });
    const { intent } = (await solive.client.intent(w.owner.address, placed.nonce ?? 0n)) ?? {};
    expect([intent?.escrowed, intent?.kind]).toEqual([999n, Kind.SwapExactIn]);
    const held = await solive.balance([w.inputMint]);
    expect(held.tokens).toEqual([{ token: w.inputMint, mint: w.inputMint, account: await ata(w.owner.address, w.inputMint), amount: "0.000001" }]);
    const cancelled = await solive.cancel({ intent: placed.intent as Address });
    expect(cancelled.summary).toBe(`Cancel ${placed.intent} and return 0.000999 ${w.inputMint} to ${w.owner.address}`);
    expect((await solive.balance([w.inputMint])).tokens[0]?.amount).toBe("0.001");
  });

  it("preview returns a summary and sends nothing", async () => {
    const w = await devnet();
    const signer = await funded(w.chain);
    const solive = await connect({ cluster: "devnet", signer, transport: w.chain.transport });
    const before = [...w.chain.sent];
    const balance = w.chain.svm.getBalance(signer.address);
    const swap = await solive.swap({ sell: "SOL", amount: "0.05", buy: "TEST", minReceive: "5", preview: true });
    expect(swap.summary).toBe("Swap 0.05 SOL for at least 5 TEST, open for 3600 seconds");
    expect(swap.nonce).toBe(0n);
    expect(swap.instructions.length).toBeGreaterThan(0);
    expect("signature" in swap).toBe(false);
    const judge = await generateKeyPairSigner();
    const work = await solive.payForWork({ amount: "0.01", judge: judge.address, specHash: sha("spec"), preview: true });
    expect(work.summary).toContain("Pay 0.01 SOL for work judged by");
    expect(work.instructions.length).toBeGreaterThan(0);
    expect(w.chain.sent).toEqual(before);
    expect(w.chain.svm.getBalance(signer.address)).toBe(balance);
    expect(tokens(w, await ata(signer.address, WSOL))).toBeNull();
    expect(await solive.client.intent(signer.address, 0n)).toBeNull();
    const sent = await solive.swap({ sell: "SOL", amount: "0.05", buy: "TEST", minReceive: "5" });
    expect(sent.nonce).toBe(0n);
    expect(w.chain.sent).toHaveLength(before.length + 1);
    const cancel = await solive.cancel({ intent: sent.intent as Address, preview: true });
    expect(cancel.summary).toBe(`Cancel ${sent.intent} and return 0.05 SOL to ${signer.address}`);
    expect(w.chain.sent).toHaveLength(before.length + 1);
    expect((await solive.client.intent(signer.address, 0n))?.intent.status).toBe(IntentStatus.Open);
  });

  it("connect refuses mainnet unless allowed", async () => {
    const w = await world();
    const on = (genesis: string): Transport => ({ ...w.chain.transport, genesisHash: async () => genesis });
    const signer = w.owner;
    await expect(connect({ cluster: "mainnet", signer, transport: on(MAINNET_GENESIS_HASH) })).rejects.toBeInstanceOf(MainnetNotAllowed);
    await expect(connect({ url: CLUSTER_URLS.devnet, signer, transport: on(MAINNET_GENESIS_HASH) })).rejects.toThrow("allowMainnet");
    const allowed = await connect({ cluster: "mainnet", signer, transport: on(MAINNET_GENESIS_HASH), allowMainnet: true });
    expect(allowed.url).toBe(CLUSTER_URLS.mainnet);
    const testing = await connect({ cluster: "devnet", signer, transport: on(DEVNET_GENESIS_HASH) });
    expect(testing.url).toBe(CLUSTER_URLS.devnet);
  });
});
