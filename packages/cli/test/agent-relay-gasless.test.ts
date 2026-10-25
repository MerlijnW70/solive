import { generateKeyPairSigner, getBase58Decoder, getBase64Decoder, getBase64Encoder, signBytes } from "@solana/kit";
import { getApproveInstruction, getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { fromNow, withFromNow } from "../src/agent/expiry.js";
import { type IntentParams, findAssociatedTokenAddress, Kind, formatAmount } from "@intent-engine/core";
import {
  createExt,
  describeSignedIntent,
  encodeParams,
  type SignedIntentFields,
  signedIntentMessage,
  findConfigPda,
  getConfigDecoder,
} from "@intent-engine/core/internal";
import { ata, balance, ESCROW, funded, h, NOW, send, setNow, type World } from "./harness.js";
import { connect, exists, execute, fail, type Json, ok, served, swapOf } from "./agent-kit.js";

describe("agent server against the deployed engine", () => {
  let w: World;
  const free = () => ["--relay-fee", `${w.inputMint}=0`];
  let client: Client;

  const swap = (over: object = {}) => swapOf(w, over);

  beforeEach(async () => {
    ({ w, client } = await served());
  });

  it("relays a gasless signed intent after a one-time setup and allows several pending at once", async () => {
    const relayer = await funded();
    const relaying = await connect(relayer, free());
    const owner = await funded();
    const ownerInput = await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const terms = { ...swap({ owner: owner.address }), submit_within: 600 };
    const first = await ok(relaying, "prepare_signed_intent", terms);
    expect(first).toMatchObject({ nonce: "0", escrow: ESCROW.toString(), warnings: [] });
    expect(first["submit"]).toEqual({
      owner: owner.address,
      input_mint: w.inputMint,
      output_mint: w.outputMint,
      order: { kind: "swap", amount_in: ESCROW.toString(), min_out: "300" },
      expires_at: (NOW + 3_600n).toString(),
      nonce: "0",
      submit_by: (NOW + 600n).toString(),
      epoch: "0",
      relayer_fee: "0",
    });
    expect(first["summary"]).toContain(`Sell: exactly 0.0004 of ${w.inputMint}`);
    expect(first["summary"]).toContain(`Digest (must match your wallet): ${first["digest"]}`);
    expect(first["summary"].slice(-3)).toEqual([
      "Setup: registers you with the engine (a one-time account you pay rent for)",
      `Setup: creates your token account for ${w.outputMint} (you pay its rent)`,
      `Setup: sets the engine's spending allowance on ${ownerInput} to 0.0004 (now 0)`,
    ]);
    await execute(first["setup"], owner);
    const allowance = () => getTokenDecoder().decode((h.svm.getAccount(ownerInput) as { data: Uint8Array }).data).delegatedAmount;
    expect(allowance()).toBe(ESCROW);
    const second = await ok(relaying, "prepare_signed_intent", { ...terms, order: { kind: "swap", amount_in: "100", min_out: "50" } });
    expect(second["nonce"]).toBe("1");
    expect(second["summary"].at(-1)).toBe(`Setup: sets the engine's spending allowance on ${ownerInput} to 0.0005 (now 0.0004)`);
    expect(await fail(relaying, "prepare_signed_intent", { ...terms, nonce: "1" })).toMatchObject({ code: "NoncePromised", retryable: true });
    const third = await ok(relaying, "prepare_signed_intent", { ...terms, order: { kind: "swap", amount_in: "100", min_out: "50" } });
    expect(third["nonce"]).toBe("2");
    await execute(third["setup"], owner);
    expect(allowance()).toBe(ESCROW + 100n);
    const sign = async (message: string) =>
      getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(message)));
    const signature = await sign(first["message"]);
    const submitted = await ok(relaying, "submit_signed_intent", { ...first["submit"], signature });
    expect(submitted["intent"]).toBe(first["intent"]);
    expect(typeof submitted["signature"]).toBe("string");
    expect(balance(ownerInput)).toBe(1_000n - ESCROW);
    expect(await ok(relaying, "submit_signed_intent", { ...first["submit"], signature })).toEqual({
      intent: first["intent"],
      signature: null,
    });
    await ok(relaying, "submit_signed_intent", { ...third["submit"], signature: await sign(third["message"]) });
    expect(balance(ownerInput)).toBe(1_000n - ESCROW - 100n);
    expect(allowance()).toBe(0n);
    expect(await fail(client, "submit_signed_intent", { ...third["submit"], signature })).toMatchObject({
      code: "RelayerNotConfigured",
    });
    const fourth = await ok(relaying, "prepare_signed_intent", terms);
    await execute(fourth["setup"], owner);
    expect(await fail(relaying, "submit_signed_intent", { ...fourth["submit"], signature })).toMatchObject({
      code: "SignatureInvalid",
    });
    for (const bad of ["abc", "0".repeat(88), getBase58Decoder().decode(new Uint8Array(63).fill(9))]) {
      expect(await fail(relaying, "submit_signed_intent", { ...fourth["submit"], signature: bad })).toEqual({
        code: "SignatureMalformed",
        retryable: false,
        hint: "the signature must be 64 bytes written in base58",
      });
    }
    setNow(NOW + 601n);
    expect(
      await fail(relaying, "submit_signed_intent", { ...fourth["submit"], signature: await sign(fourth["message"]) }),
    ).toMatchObject({ code: "SignatureExpired" });
  });

  it("shows, asks to sign and creates exactly the same terms for random signed intents", async () => {
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const relayer = await funded();
    const relaying = await connect(relayer, [...free(), "--relay-hourly-lamports", "10000000000", "--relay-max-ttl", "604800"]);
    const [configAddress] = await findConfigPda();
    const configView = h.svm.getAccount(configAddress);
    if (!configView.exists) {
      throw new Error("config missing");
    }
    const domain = Uint8Array.from(getConfigDecoder().decode(configView.data).domain);
    const toParams = (order: Json): IntentParams => {
      switch (order["kind"]) {
        case "swap":
          return { kind: Kind.SwapExactIn, amountIn: BigInt(order["amount_in"]), minOut: BigInt(order["min_out"]) };
        case "limit":
          return { kind: Kind.LimitOrder, makeAmount: BigInt(order["make_amount"]), takeAmount: BigInt(order["take_amount"]) };
        default:
          return {
            kind: Kind.DutchAuction,
            amountIn: BigInt(order["amount_in"]),
            startOut: BigInt(order["start_out"]),
            endOut: BigInt(order["end_out"]),
            startTs: BigInt(order["start_time"]),
            endTs: BigInt(order["end_time"]),
          };
      }
    };
    for (let round = 0; round < 30; round++) {
      const owner = await funded();
      const ownerInput = await ata(w.authority, owner.address, w.inputMint, 10_000n);
      const receiver = await findAssociatedTokenAddress({ owner: owner.address, mint: w.outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
      const amount = BigInt(1 + next(2_000));
      const expiresIn = 60 + next(86_400);
      const order = [
        { kind: "swap", amount_in: amount.toString(), min_out: String(1 + next(5_000)) },
        { kind: "limit", make_amount: amount.toString(), take_amount: String(1 + next(5_000)) },
        {
          kind: "dutch",
          amount_in: amount.toString(),
          start_out: String(500 + next(500)),
          end_out: String(1 + next(500)),
          start_time: NOW.toString(),
          end_time: (NOW + BigInt(expiresIn)).toString(),
        },
      ][next(3)] as Json;
      const partner = next(2) === 0 ? undefined : { account: (await generateKeyPairSigner()).address, bps: 1 + next(100) };
      const prepared = await ok(relaying, "prepare_signed_intent", {
        owner: owner.address,
        input_mint: w.inputMint,
        output_mint: w.outputMint,
        order,
        expires_in: expiresIn,
        submit_within: 60 + next(3_000),
        relayer_fee: String(next(40)),
        ...(partner === undefined ? {} : { partner }),
      });
      const submit = prepared["submit"] as Json;
      const fields: SignedIntentFields = {
        domain,
        owner: owner.address,
        ownerInput,
        inputMint: w.inputMint,
        outputMint: w.outputMint,
        receiver,
        nonce: BigInt(submit["nonce"]),
        expiresAt: BigInt(submit["expires_at"]),
        submitBy: BigInt(submit["submit_by"]),
        kind: toParams(submit["order"]).kind,
        params: encodeParams(toParams(submit["order"])),
        epoch: BigInt(submit["epoch"]),
        relayerFee: BigInt(submit["relayer_fee"]),
        ext: createExt(partner === undefined ? {} : { partner: { key: partner.account, bps: partner.bps } }),
      };
      expect(submit["order"], `round ${round}`).toEqual(order);
      expect(prepared["message"], `round ${round}`).toBe(getBase64Decoder().decode(await signedIntentMessage(fields)));
      const described = await describeSignedIntent(fields, {
        now: NOW,
        currentEpoch: 0n,
        expectedDomain: domain,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        inputDecimals: 6,
        outputDecimals: 6,
      });
      expect(prepared["digest"], `round ${round}`).toBe(described.digest);
      expect((prepared["summary"] as string[]).slice(0, described.lines.length), `round ${round}`).toEqual(withFromNow(described.lines, fields.expiresAt, NOW));
      expect(prepared["summary"], `round ${round}`).toContain(`Expires: ${new Date(Number(fields.expiresAt) * 1000).toISOString()}, ${fromNow(fields.expiresAt, NOW)}`);
      await execute(prepared["setup"], owner);
      const signature = getBase58Decoder().decode(
        await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(prepared["message"])),
      );
      await ok(relaying, "submit_signed_intent", { ...submit, signature });
      expect(await ok(relaying, "get_intent", { owner: owner.address, nonce: submit["nonce"] }), `round ${round}`).toMatchObject({
        status: "open",
        receiver,
        expires_at: submit["expires_at"],
        order,
        partner: partner ?? null,
      });
    }
  });

  it("charges the relayer's fee in the input token, signed by the owner and paid as the intent is created", async () => {
    const relayer = await funded();
    const relaying = await connect(relayer, ["--relay-fee", `${w.inputMint}=25`]);
    const owner = await funded();
    const ownerInput = await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const prepared = await ok(relaying, "prepare_signed_intent", swap({ owner: owner.address }));
    expect(prepared["submit"]).toMatchObject({ relayer_fee: "25" });
    expect(prepared["summary"]).toContain(
      `Relayer fee: 0.000025 of ${w.inputMint}, paid from ${ownerInput} to whoever submits it`,
    );
    expect(prepared["summary"].at(-1)).toBe(`Setup: sets the engine's spending allowance on ${ownerInput} to 0.000425 (now 0)`);
    await execute(prepared["setup"], owner);
    const signature = getBase58Decoder().decode(
      await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(prepared["message"])),
    );
    expect(await fail(relaying, "submit_signed_intent", { ...prepared["submit"], relayer_fee: "24", signature })).toEqual({
      code: "RelayFeeTooLow",
      retryable: false,
      hint: `this relayer charges 25 raw units of ${w.inputMint} per intent; prepare and sign the intent again on this server`,
    });
    expect(await fail(relaying, "submit_signed_intent", { ...prepared["submit"], relayer_fee: "26", signature })).toMatchObject({
      code: "SignatureInvalid",
    });
    await ok(relaying, "submit_signed_intent", { ...prepared["submit"], signature });
    const relayerAccount = await findAssociatedTokenAddress({ owner: relayer.address, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(balance(relayerAccount)).toBe(25n);
    expect(balance(ownerInput)).toBe(1_000n - ESCROW - 25n);
    expect(prepared["summary"]).toContain(
      `Cost to you: 0.000025 of ${w.inputMint} to the relayer, plus 5000 lamports of SOL for the setup transaction's network fee, once`,
    );
    const holdings = (mints: string[]) => ok(relaying, "get_balances", { owner: owner.address, mints });
    const sol = h.svm.getBalance(owner.address) ?? 0n;
    expect(sol).toBeGreaterThan(0n);
    expect(await holdings([w.inputMint, w.outputMint])).toEqual({
      owner: owner.address,
      lamports: sol.toString(),
      sol: formatAmount(sol, 9),
      tokens: [
        {
          mint: w.inputMint,
          decimals: 6,
          account: ownerInput,
          exists: true,
          balance: "575",
          balance_tokens: "0.000575",
          engine_allowance: "0",
          escrowed: ESCROW.toString(),
        },
        {
          mint: w.outputMint,
          decimals: 6,
          account: await findAssociatedTokenAddress({ owner: owner.address, mint: w.outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
          exists: true,
          balance: "0",
          balance_tokens: "0",
          engine_allowance: "0",
          escrowed: "0",
        },
      ],
      unreadable: 0,
    });
    const nonce = (prepared["submit"] as Json)["nonce"] as string;
    await execute((await ok(relaying, "prepare_cancel", { owner: owner.address, nonce }))["prepared"], owner);
    expect(await ok(relaying, "get_intent", { owner: owner.address, nonce })).toMatchObject({
      status: "cancelled",
      escrowed: ESCROW.toString(),
      remaining: "0",
    });
    expect(((await holdings([w.inputMint]))["tokens"] as Json[])[0]).toMatchObject({ balance: "975", escrowed: "0" });
    const stranger = await generateKeyPairSigner();
    expect(await ok(relaying, "get_balances", { owner: stranger.address, mints: [w.inputMint] })).toMatchObject({ lamports: "0", sol: "0" });
    expect(((await ok(relaying, "get_balances", { owner: stranger.address, mints: [w.inputMint] }))["tokens"] as Json[])[0]).toMatchObject({
      exists: false,
      balance: "0",
      engine_allowance: "0",
    });
    const other = await generateKeyPairSigner();
    await send(owner, [getApproveInstruction({ source: ownerInput, delegate: other.address, owner, amount: 9n })]);
    expect(((await holdings([w.inputMint]))["tokens"] as Json[])[0]).toMatchObject({ engine_allowance: "0" });
    expect(await fail(relaying, "get_balances", { owner: owner.address, mints: [] })).toMatchObject({ code: "InvalidInput" });
  });

  it("preview signed intent is a tool", async () => {
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const { tools } = await client.listTools();
    const listed = tools.find((t) => t.name === "solive_preview_signed_intent");
    expect(listed?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const prepared = await ok(client, "prepare_signed_intent", swap({ owner: owner.address }));
    await execute(prepared["setup"], owner);
    const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(prepared["message"])));
    const preview = await ok(client, "preview_signed_intent", { ...prepared["submit"], signature });
    expect(preview).toMatchObject({ intent: prepared["intent"], exists: 0, relayer_fee: "0", warnings: [] });
    expect(preview["summary"]).toContain(`Digest (must match your wallet): ${prepared["digest"]}`);
    expect(exists(prepared["intent"])).toBe(false);
    const other = await funded();
    const forged = getBase58Decoder().decode(await signBytes(other.keyPair.privateKey, getBase64Encoder().encode(prepared["message"])));
    expect(await fail(client, "preview_signed_intent", { ...prepared["submit"], signature: forged })).toMatchObject({ code: "SignatureInvalid" });
  });
});
