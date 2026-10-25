import { type Address, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getMintEncoder, getMintSize } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT as TEST, NATIVE_MINT as WSOL, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { connect } from "../../src/index.js";
import { funded, world, type World } from "../svm.js";
import { keyed, sha, workUrl } from "../work.js";

const WORK = sha("the padded receipt work");
const SPEC = sha("the padded receipt spec");
const PADDING = 101;

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

async function releasedThenPadded() {
  const w = await world();
  preset(w, WSOL);
  preset(w, TEST);
  const owner = await funded(w.chain);
  const judge = await keyed(w);
  const at = (signer: KeyPairSigner) => connect({ cluster: "devnet", signer, transport: w.chain.transport });
  const buyer = await at(owner);
  const reviewer = await at(judge.signer);
  const made = await buyer.payForWork({ amount: "0.01", judge: judge.signer.address, specHash: SPEC });
  const escrow = made.intent as Address;
  const worker = await funded(w.chain);
  await (await at(worker)).deliver({ escrow, sha256: WORK, url: workUrl() });
  const released = await reviewer.release({ escrow, to: worker.address, deliveredSha256: WORK, keypair: judge.keypair });
  const before = await buyer.receipt({ escrow });
  const stranger = await funded(w.chain);
  for (let i = 1; i <= PADDING; i++) {
    await w.chain.transport.send([getTransferSolInstruction({ source: stranger, destination: escrow, amount: BigInt(i) })], stranger);
  }
  return { buyer, escrow, worker, released, before, after: await buyer.receipt({ escrow }) };
}

describe("a receipt read after a stranger pads the escrow's history", () => {
  it("RP-4 still names the payee and the release the chain holds after a stranger sends small transfers to the escrow", async () => {
    const { worker, released, before, after } = await releasedThenPadded();
    expect(before).toMatchObject({ released: true, signature: released.signature, payee: worker.address, deliveredSha256: WORK, complete: true });
    expect(after).toMatchObject({ released: true, signature: released.signature, payee: worker.address, deliveredSha256: WORK });
  });

  it("RP-3 does not call the receipt complete when the release lies beyond the transactions it read", async () => {
    const { after } = await releasedThenPadded();
    expect(after.released === true || after.complete === false).toBe(true);
  });
});
