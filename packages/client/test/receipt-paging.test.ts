import { type Address, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getMintEncoder, getMintSize } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT as TEST, NATIVE_MINT as WSOL, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { connect, type Transport } from "../src/index.js";
import { INTENT_HISTORY_PAGES } from "../src/release-reads.js";
import { funded, world, type World } from "./svm.js";
import { keyed, sha, workUrl } from "./work.js";

const WORK = sha("the paged receipt work");
const SPEC = sha("the paged receipt spec");

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

async function escrowed() {
  const w = await world();
  preset(w, WSOL);
  preset(w, TEST);
  const owner = await funded(w.chain);
  const judge = await keyed(w);
  const at = (signer: KeyPairSigner, transport: Transport = w.chain.transport) => connect({ cluster: "devnet", signer, transport });
  const made = await (await at(owner)).payForWork({ amount: "0.01", judge: judge.signer.address, specHash: SPEC });
  const escrow = made.intent as Address;
  const pad = async (count: number) => {
    const stranger = await funded(w.chain);
    for (let i = 1; i <= count; i++) {
      await w.chain.transport.send([getTransferSolInstruction({ source: stranger, destination: escrow, amount: BigInt(i) })], stranger);
    }
  };
  const release = async () => {
    const worker = await funded(w.chain);
    await (await at(worker)).deliver({ escrow, sha256: WORK, url: workUrl() });
    const released = await (await at(judge.signer)).release({ escrow, to: worker.address, deliveredSha256: WORK, keypair: judge.keypair });
    return { worker, signature: released.signature };
  };
  return { w, owner, at, escrow, pad, release };
}

describe("a receipt pages the escrow's history", () => {
  it("finds a release that lies more than one history page behind the newest transactions", async () => {
    const { owner, at, escrow, pad, release } = await escrowed();
    const { worker, signature } = await release();
    await pad(150);
    expect(await (await at(owner)).receipt({ escrow })).toMatchObject({ released: true, signature, payee: worker.address, deliveredSha256: WORK, valid: true, complete: true });
  });

  it("reports a filled escrow as released, not complete, when its release lies beyond what the transport could read", async () => {
    const { w, owner, at, escrow, pad, release } = await escrowed();
    await release();
    await pad(101);
    const { signaturesOf: _, transactionsOf: __, ...single } = w.chain.transport;
    const read = await (await at(owner, single)).receipt({ escrow });
    expect(read).toMatchObject({ released: true, signature: null, payee: null, complete: false });
    expect(read.summary).toContain("is filled on chain, but its release lies beyond the 100 most recent transactions");
  });

  it("says a receipt is not complete when paging stops at its limit before the escrow's first transaction", async () => {
    const { w, owner, at, escrow } = await escrowed();
    let listed = 0;
    const endless: Transport = {
      ...w.chain.transport,
      signaturesOf: async (_of, limit) =>
        Array.from({ length: limit }, () => ({ signature: `unlisted-${++listed}`, slot: 1n, blockTime: null, failed: false, memo: null })),
      transactionsOf: async () => [],
    };
    const read = await (await at(owner, endless)).receipt({ escrow });
    expect(read).toMatchObject({ released: false, complete: false });
    expect(read.summary).toContain("an older release is not ruled out");
    expect(listed).toBe(INTENT_HISTORY_PAGES * 100);
  });

  it("calls an unreleased escrow's receipt complete once paging reaches the escrow's creation", async () => {
    const { owner, at, escrow, pad } = await escrowed();
    await pad(120);
    expect(await (await at(owner)).receipt({ escrow })).toMatchObject({ released: false, complete: true, summary: `Escrow ${escrow} is not released yet` });
  });
});
