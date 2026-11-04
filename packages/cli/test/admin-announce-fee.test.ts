import { getBase64Encoder, getTransactionDecoder, type KeyPairSigner, partiallySignTransaction } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import { findConfigPda, getConfigDecoder, MAX_CREATE_FEE } from "@intent-engine/core/internal";
import { AUTHORITY_NEXT } from "../src/commands.js";
import { EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { cli, h, type World, world } from "./harness.js";

type Json = Record<string, any>;

async function signAndSend(transaction: string, signer: KeyPairSigner): Promise<void> {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
  const result = h.svm.sendTransaction(await partiallySignTransaction([signer.keyPair], tx));
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(result.toString());
  }
}

const feeOnChain = async () => {
  const view = h.svm.getAccount((await findConfigPda())[0]);
  return view.exists ? getConfigDecoder().decode(view.data).announceFee : -1;
};

describe("set-announce-fee on the command line", () => {
  let w: World;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    w = await world();
    keys = { "admin.json": w.authority };
  });

  it("previews with the old and new fee and sends nothing without --yes", async () => {
    const before = await feeOnChain();
    const preview = await cli(["set-announce-fee", "--keypair", "admin.json", "--fee", "5000"], keys);
    expect(preview.code).toBe(EXIT_OK);
    expect(preview.json()).toMatchObject({
      sent: false,
      summary: [`Announce fee: ${before} -> 5000 lamports per delivery announcement`, expect.stringContaining("pays 5000 lamports to the fee recipient")],
    });
    expect(await feeOnChain()).toBe(before);
  });

  it("sends the instruction with --yes, shows the change on the next run and lifts the fee with zero", async () => {
    const sent = (await cli(["set-announce-fee", "--keypair", "admin.json", "--fee", "5000", "--yes"], keys)).json() as Json;
    expect(sent).toMatchObject({ sent: true });
    expect(typeof sent["signature"]).toBe("string");
    expect(await feeOnChain()).toBe(5000);
    const lifted = (await cli(["set-announce-fee", "--keypair", "admin.json", "--fee", "0"], keys)).json() as Json;
    expect(lifted["summary"]).toEqual(["Announce fee: 5000 -> 0 lamports per delivery announcement", "Announcing a delivery then costs the worker no fee"]);
    await cli(["set-announce-fee", "--keypair", "admin.json", "--fee", "0", "--yes"], keys);
    expect(await feeOnChain()).toBe(0);
  });

  it("proposes through the multisig path as an unsigned transaction the authority signs", async () => {
    const printed = (await cli(["set-announce-fee", "--authority", w.authority.address, "--fee", String(MAX_CREATE_FEE)], {})).json() as Json;
    const tx = printed["unsigned"];
    expect(tx["signers"]).toEqual([w.authority.address]);
    expect(tx["next"]).toBe(AUTHORITY_NEXT);
    expect(tx["instructions"]).toHaveLength(1);
    expect(tx["instructions"][0]["accounts"]).toContainEqual({ address: w.authority.address, signer: true, writable: false });
    expect(await feeOnChain()).toBe(0);
    await signAndSend(tx["transaction"], w.authority);
    expect(await feeOnChain()).toBe(MAX_CREATE_FEE);
  });

  it("refuses a missing, negative, fractional or too large fee and a stray word as a usage error", async () => {
    const usage = [
      ["set-announce-fee", "--keypair", "admin.json"],
      ["set-announce-fee", "--keypair", "admin.json", "--fee", "-1"],
      ["set-announce-fee", "--keypair", "admin.json", "--fee", "1.5"],
      ["set-announce-fee", "--keypair", "admin.json", "--fee", String(MAX_CREATE_FEE + 1)],
      ["set-announce-fee", "extra", "--keypair", "admin.json", "--fee", "5"],
    ];
    for (const args of usage) {
      expect([args.join(" "), (await cli(args, keys)).code]).toEqual([args.join(" "), EXIT_USAGE]);
    }
    expect(await feeOnChain()).toBe(0);
  });
});
