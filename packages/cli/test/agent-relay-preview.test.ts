import { getBase58Decoder, getBase64Encoder, signBytes } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { relayCost, rentFor, rentRate, SIGNATURE_FEE, TOKEN_ACCOUNT_RENT_BYTES } from "../src/agent/budget.js";
import { ata, cli, funded, transport, type World } from "./harness.js";
import { connect, exists, execute, fail, type Json, ok, served, swapOf } from "./agent-kit.js";

describe("relay preview against the deployed engine", () => {
  let w: World;
  let client: Client;
  const economics = { createFee: 4_000, crankBounty: 6_000 };
  const swap = (over: object = {}) => swapOf(w, over);

  beforeEach(async () => {
    ({ w, client } = await served());
    await cli(["set-economics", "--keypair", "a.json", "--yes", "--bounty", "6000", "--create-fee", "4000"], { "a.json": w.authority });
  });

  const signed = async (server: Client, over: object = {}) => {
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const p = await ok(server, "prepare_signed_intent", swap({ owner: owner.address, ...over }));
    await execute(p["setup"], owner);
    const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(p["message"])));
    return { owner, prepared: p, terms: { ...p["submit"], signature } as Json };
  };

  it("relays with the documented flags on a config with a crank bounty", async () => {
    const relayer = await funded();
    const relaying = await connect(relayer, ["--relay-fee", `${w.inputMint}=0`]);
    const { prepared, terms } = await signed(relaying);
    expect(await ok(relaying, "submit_signed_intent", terms)).toMatchObject({ intent: prepared["intent"], signature: expect.any(String) });
    expect(exists(prepared["intent"])).toBe(true);
  });

  it("still refuses a relay above an explicit lamport cap, in prepare, preview and submit", async () => {
    const relayer = await funded();
    const capped = await connect(relayer, ["--relay-fee", `${w.inputMint}=0`, "--relay-max-lamports", "9999"]);
    const hint =
      "relaying this intent costs at least 10000 lamports in create fee and crank bounty before any priority fee; this relayer pays at most 9999";
    expect(await fail(capped, "prepare_signed_intent", swap({ owner: (await funded()).address }))).toEqual({
      code: "RelayTooCostly",
      retryable: false,
      hint,
    });
    const open = await connect(relayer, ["--relay-fee", `${w.inputMint}=0`]);
    const { terms } = await signed(open);
    const refusal = {
      code: "RelayTooCostly",
      retryable: false,
      hint: "relaying this intent costs 10000 lamports in create fee, crank bounty and priority fee; this relayer pays at most 9999",
    };
    expect(await fail(capped, "preview_signed_intent", terms)).toEqual(refusal);
    expect(await fail(capped, "submit_signed_intent", terms)).toEqual(refusal);
  });

  it("refuses in the preview what submit refuses", async () => {
    const relayer = await funded();
    const priced = await connect(relayer, ["--relay-fee", `${w.inputMint}=25`]);
    const { terms } = await signed(priced);
    const refusals: [string[], object][] = [
      [["--relay-fee", `${w.outputMint}=0`], { code: "RelayMintNotAccepted" }],
      [["--relay-fee", `${w.inputMint}=26`], { code: "RelayFeeTooLow" }],
      [["--relay-fee", `${w.inputMint}=25`, "--relay-max-ttl", "60"], { code: "RelayTooLong" }],
      [["--relay-fee", `${w.inputMint}=25`, "--relay-hourly-lamports", "1"], { code: "BudgetExhausted" }],
    ];
    for (const [flags, expected] of refusals) {
      const strict = await connect(relayer, flags);
      const previewed = await fail(strict, "preview_signed_intent", terms);
      expect(previewed).toMatchObject(expected);
      expect(await fail(strict, "submit_signed_intent", terms)).toEqual(previewed);
    }
  });

  it("refuses in the preview a nonce another intent took and a relay over the per-owner rate", async () => {
    const relayer = await funded();
    const relaying = await connect(relayer, ["--relay-fee", `${w.inputMint}=0`, "--relay-per-hour", "1"]);
    const first = await signed(relaying);
    const owner = first.owner;
    const elsewhere = await connect(await funded(), ["--relay-fee", `${w.inputMint}=0`]);
    const rival = await ok(elsewhere, "prepare_signed_intent", swap({ owner: owner.address, nonce: first.prepared["nonce"], order: { kind: "swap", amount_in: "100", min_out: "1" } }));
    const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(rival["message"])));
    await ok(relaying, "submit_signed_intent", first.terms);
    expect(await fail(relaying, "preview_signed_intent", { ...rival["submit"], signature })).toMatchObject({ code: "NonceTaken" });
    const next = await ok(relaying, "prepare_signed_intent", swap({ owner: owner.address }));
    await execute(next["setup"], owner);
    const again = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(next["message"])));
    expect(await fail(relaying, "preview_signed_intent", { ...next["submit"], signature: again })).toMatchObject({ code: "RelayRateLimited" });
  });

  it("refuses in the preview terms its relayer could not fit in one transaction", async () => {
    const relayer = await funded();
    const fee = ["--relay-fee", `${w.inputMint}=25`];
    const unpriced = await connect(relayer, fee);
    const partner = { account: w.feeRecipient.address, bps: 50 };
    const { terms } = await signed(unpriced, { partner });
    const priced = await connect(relayer, [...fee, "--priority-fee", "1000"]);
    const refusal = await fail(priced, "preview_signed_intent", terms);
    expect(refusal).toMatchObject({ code: "RelayTooLarge" });
    expect(await fail(priced, "submit_signed_intent", terms)).toEqual(refusal);
  });

  it("shows the cost submit reserves and reserves nothing itself", async () => {
    const rate = await rentRate(transport);
    const cost = relayCost(economics, rate);
    const base = cost + rentFor(TOKEN_ACCOUNT_RENT_BYTES, rate);
    const cases: [boolean, bigint][] = [
      [true, cost],
      [false, base + SIGNATURE_FEE],
    ];
    for (const [holding, total] of cases) {
      const relayer = await funded();
      if (holding) {
        await ata(w.authority, relayer.address, w.inputMint, 0n);
      }
      const fee = ["--relay-fee", `${w.inputMint}=25`];
      const relaying = await connect(relayer, [...fee, "--relay-per-hour", "1", "--relay-hourly-lamports", total.toString()]);
      const { prepared, terms } = await signed(relaying);
      for (let i = 0; i < 3; i += 1) {
        const preview = await ok(relaying, "preview_signed_intent", terms);
        expect((preview["summary"] as string[]).join(" ")).toContain(`Relaying costs you ${total} lamports`);
      }
      const tight = await connect(relayer, [...fee, "--relay-hourly-lamports", (total - 1n).toString()]);
      expect(await fail(tight, "preview_signed_intent", terms)).toEqual({
        code: "BudgetExhausted",
        retryable: true,
        hint: `this key may spend ${total - 1n} lamports per hour and has ${total - 1n} left; this needs ${total}`,
      });
      expect(exists(prepared["intent"])).toBe(false);
      expect(await ok(relaying, "submit_signed_intent", terms)).toMatchObject({ intent: prepared["intent"] });
      expect(exists(prepared["intent"])).toBe(true);
    }
  });
});
