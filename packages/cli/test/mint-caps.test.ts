import { type Address, getBase64Encoder, getTransactionDecoder, type KeyPairSigner, partiallySignTransaction } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import { decodeMintCapData, findConfigPda, findMintCapAddress, getConfigDecoder, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core";
import { AUTHORITY_NEXT } from "../src/commands.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { balance, cli, h, NOW, setNow, type World, world } from "./harness.js";

type Json = Record<string, any>;

async function signAndSend(transaction: string, signer: KeyPairSigner): Promise<void> {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
  const result = h.svm.sendTransaction(await partiallySignTransaction([signer.keyPair], tx));
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(result.toString());
  }
}

const capsRequired = async () => {
  const view = h.svm.getAccount((await findConfigPda())[0]);
  return view.exists ? getConfigDecoder().decode(view.data).capsRequired : -1;
};

const capOf = (address: Address) => {
  const view = h.svm.getAccount(address);
  return view.exists ? decodeMintCapData(Uint8Array.from(view.data)) : null;
};

describe("mint caps on the command line", () => {
  let w: World;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    w = await world();
    keys = { "owner.json": w.owner, "admin.json": w.authority };
  });

  const limits = (max: string, window: string, secs: string) => ["--mint", w.inputMint, "--max-per-order", max, "--window-cap", window, "--window-secs", secs];

  const swap = (amount: string) => [
    "create",
    "swap",
    "--keypair",
    "owner.json",
    "--input-mint",
    w.inputMint,
    "--output-mint",
    w.outputMint,
    "--expires-in",
    "3600",
    "--units",
    "raw",
    "--amount-in",
    amount,
    "--min-out",
    "1",
    "--yes",
  ];

  it("set mint cap prints unsigned instructions for a multisig authority", async () => {
    const cap = await findMintCapAddress(w.inputMint);
    const printed = (await cli(["set-mint-cap", "--authority", w.authority.address, ...limits("300", "500", "3600")], {})).json() as Json;
    const tx = printed["unsigned"];
    expect(tx["signers"]).toEqual([w.authority.address]);
    expect(tx["next"]).toBe(AUTHORITY_NEXT);
    expect(tx["instructions"]).toHaveLength(1);
    const ix = tx["instructions"][0];
    expect(ix["program"]).toBe(INTENT_ENGINE_PROGRAM_ADDRESS);
    expect(ix["accounts"].slice(0, 2)).toEqual([
      { address: w.authority.address, signer: true, writable: false },
      { address: w.authority.address, signer: true, writable: true },
    ]);
    expect(ix["accounts"]).toContainEqual({ address: cap, signer: false, writable: true });
    expect(printed["mintCap"]).toBe(cap);
    expect(printed["summary"]).toEqual([
      `Creates the mint cap ${cap} for ${w.inputMint}, paid by ${w.authority.address}: at most 300 raw units per intent and 500 per 3600 second window`,
    ]);
    expect(capOf(cap)).toBeNull();
    await signAndSend(tx["transaction"], w.authority);
    expect(capOf(cap)).toMatchObject({ mint: w.inputMint, maxPerOrder: 300n, windowCap: 500n, windowSecs: 3600, windowUsed: 0n });

    const required = (await cli(["set-caps-required", "on", "--authority", w.authority.address], {})).json() as Json;
    expect(required["unsigned"]["signers"]).toEqual([w.authority.address]);
    expect(required["summary"]).toEqual([
      "Caps required: off -> on",
      "Every create must then pass the input mint's cap, and a mint without a cap takes no new intents",
    ]);
    expect(await capsRequired()).toBe(0);
    await signAndSend(required["unsigned"]["transaction"], w.authority);
    expect(await capsRequired()).toBe(1);

    expect((await cli(swap("300"), keys)).code).toBe(EXIT_OK);
    expect(balance(w.ownerInput)).toBe(700n);
    expect(capOf(cap)?.windowUsed).toBe(300n);
    const refused = await cli(swap("301"), keys);
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.err).toContain("MintCapPerOrder");

    const update = (await cli(["set-mint-cap", "--authority", w.authority.address, ...limits("400", "800", "60")], {})).json() as Json;
    expect(update["summary"]).toEqual([
      `Mint cap of ${w.inputMint}: at most 300 raw units per intent and 500 per 3600 second window -> at most 400 raw units per intent and 800 per 60 second window`,
      `Keeps the current window: 300 used since ${NOW}`,
    ]);
    const off = (await cli(["set-caps-required", "off", "--keypair", "admin.json"], keys)).json() as Json;
    expect(off).toMatchObject({ sent: false, summary: ["Caps required: on -> off", "Creates then ignore mint caps"] });

    const usage = [
      ["set-mint-cap", "--keypair", "admin.json", ...limits("300", "500", "59")],
      ["set-mint-cap", "--keypair", "admin.json", ...limits("0", "500", "60")],
      ["set-mint-cap", "--keypair", "admin.json", ...limits("300", "299", "60")],
      ["set-caps-required", "maybe", "--keypair", "admin.json"],
      ["set-caps-required", "--keypair", "admin.json"],
    ];
    for (const args of usage) {
      expect([args.join(" "), (await cli(args, keys)).code]).toEqual([args.join(" "), EXIT_USAGE]);
    }
  });

  it("show mint cap prints the cap and its window", async () => {
    const cap = await findMintCapAddress(w.inputMint);
    const missing = await cli(["show", "mint-cap", "--mint", w.inputMint], {});
    expect(missing.code).toBe(EXIT_FAILED);
    expect(missing.err).toContain(cap);
    expect((await cli(["set-mint-cap", "--keypair", "admin.json", "--yes", ...limits("300", "500", "3600")], keys)).code).toBe(EXIT_OK);
    expect((await cli(["set-caps-required", "on", "--keypair", "admin.json", "--yes"], keys)).code).toBe(EXIT_OK);
    expect((await cli(swap("200"), keys)).code).toBe(EXIT_OK);
    const shown = (await cli(["show", "mint-cap", "--mint", w.inputMint], {})).json() as Json;
    expect(shown).toMatchObject({
      address: cap,
      mint: w.inputMint,
      maxPerOrder: "300",
      windowCap: "500",
      windowSecs: 3600,
      window: { start: NOW.toString(), ends: (NOW + 3600n).toString(), used: "200", left: "300" },
      capsRequired: true,
    });
    expect(shown["summary"]).toEqual([
      `Intents selling ${w.inputMint} escrow at most 300 raw units per intent and 500 per 3600 second window`,
      `This window: 200 used, 300 left, until ${NOW + 3600n}`,
      "Caps are required: every create must pass this cap",
    ]);
    setNow(NOW + 3600n);
    const rolled = (await cli(["show", "mint-cap", "--mint", w.inputMint], {})).json() as Json;
    expect(rolled["window"]).toEqual({ start: (NOW + 3600n).toString(), ends: (NOW + 7200n).toString(), used: "0", left: "500" });
  });
});
