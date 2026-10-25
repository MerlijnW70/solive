import { generateKeyPairSigner, getBase58Decoder, getBase64Encoder, type Instruction, lamports, signBytes, some } from "@solana/kit";
import { getTokenDecoder, getTokenEncoder, getTransferInstruction } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { formatAmount } from "@intent-engine/core";
import { findDelegatePda, specMemo, U64_MAX } from "@intent-engine/core/internal";
import { DEVNET_GENESIS_HASH, MEMO_PROGRAM_ADDRESS } from "@intent-engine/client/internal";
import { createCost, rentRate } from "../src/agent/budget.js";
import { DEFAULT_SUBMIT_WITHIN, publishesLine, SPEC_URL_TOO_LONG, SPEC_URL_UNSIGNED } from "../src/agent/signed.js";
import { WARN_REPLACES_DELEGATE } from "../src/agent/owner.js";
import { SPEC_URL_PLAIN } from "../src/agent/create.js";
import { ata, ESCROW, funded, h, NOW, send, transport, type World } from "./harness.js";
import { connect, exists, execute, fail, type Json, ok, served, swapOf } from "./agent-kit.js";

describe("agent server against the deployed engine", () => {
  let w: World;
  const free = () => ["--relay-fee", `${w.inputMint}=0`];
  let client: Client;

  const swap = (over: object = {}) => swapOf(w, over);

  beforeEach(async () => {
    ({ w, client } = await served());
  });

  it("a relayed proof escrow publishes its spec url", async () => {
    const relayer = await funded();
    const sent: Instruction[][] = [];
    h.through = { ...transport, send: async (instructions, payer) => {
      sent.push([...instructions]);
      return transport.send(instructions, payer);
    } };
    const relaying = await connect(relayer, free());
    h.through = null;
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const judge = (await generateKeyPairSigner()).address;
    const specUrl = "https://a.io/spec.md";
    const order = { kind: "attested", amount_in: ESCROW.toString(), min_result: "1", max_result: "1", attestor: judge, spec_hash: "5c".repeat(32) };
    const terms = { ...swap({ owner: owner.address, order }), spec_url: specUrl };
    expect(await fail(relaying, "prepare_signed_intent", { ...terms, order: swap()["order"] })).toMatchObject({ code: "InvalidInput" });
    expect(await fail(relaying, "prepare_signed_intent", { ...terms, spec_url: "ftp://example.org/spec" })).toMatchObject({ code: "InvalidInput" });
    expect(await fail(relaying, "prepare_signed_intent", { ...terms, spec_url: "https://example.org/jobs/spec.md" })).toEqual({ code: "RelayTooLarge", retryable: false, hint: SPEC_URL_TOO_LONG });
    const prepared = await ok(relaying, "prepare_signed_intent", terms);
    expect(prepared["submit"]).toMatchObject({ spec_url: specUrl });
    expect(prepared["summary"]).toContain(publishesLine(specUrl));
    expect(prepared["warnings"]).toContain(SPEC_URL_UNSIGNED);
    await execute(prepared["setup"], owner);
    const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(prepared["message"])));
    const signed = { ...prepared["submit"], signature };
    const preview = await ok(relaying, "preview_signed_intent", signed);
    expect(preview["summary"]).toContain(publishesLine(specUrl));
    expect(preview["warnings"]).toContain(SPEC_URL_UNSIGNED);
    expect(await ok(relaying, "submit_signed_intent", signed)).toMatchObject({ intent: prepared["intent"], signature: expect.any(String) });
    const memos = sent.flat().filter((ix) => ix.programAddress === MEMO_PROGRAM_ADDRESS);
    expect(memos.map((ix) => new TextDecoder().decode(Uint8Array.from(ix.data ?? [])))).toEqual([specMemo(specUrl)]);
    expect(memos[0]?.accounts?.map((a) => a.address)).toEqual([relayer.address]);
    expect(exists(prepared["intent"])).toBe(true);
    const { spec_url: _, ...unpublished } = signed;
    expect(await ok(relaying, "preview_signed_intent", unpublished)).toMatchObject({ exists: 1 });
  });

  it("mcp create refuses a plain http spec url on a public cluster", async () => {
    const relaying = await connect(await funded(), free());
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const judge = (await generateKeyPairSigner()).address;
    const plainUrl = "http://localhost/spec.md";
    const order = { kind: "attested", amount_in: ESCROW.toString(), min_result: "1", max_result: "1", attestor: judge, spec_hash: "5c".repeat(32) };
    const terms = { ...swap({ owner: owner.address, order }), spec_url: plainUrl };
    expect(await ok(relaying, "prepare_create", terms)).toMatchObject({ summary: expect.arrayContaining([`Publishes: the acceptance spec's url ${plainUrl}, in a memo the owner signs`]) });
    const prepared = await ok(relaying, "prepare_signed_intent", terms);
    expect(prepared["submit"]).toMatchObject({ spec_url: plainUrl });
    await execute(prepared["setup"], owner);
    const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(prepared["message"])));
    const signed = { ...prepared["submit"], signature };
    const refused = { code: "InvalidInput", issues: [{ path: "spec_url", message: SPEC_URL_PLAIN }] };
    const local = h.genesis;
    h.genesis = DEVNET_GENESIS_HASH;
    try {
      expect(await fail(relaying, "prepare_create", terms)).toMatchObject(refused);
      expect(await fail(relaying, "prepare_signed_intent", terms)).toMatchObject(refused);
      expect(await fail(relaying, "preview_signed_intent", signed)).toMatchObject(refused);
      expect(await fail(relaying, "submit_signed_intent", signed)).toMatchObject(refused);
      expect(await ok(relaying, "prepare_create", { ...terms, spec_url: "https://a.io/spec.md" })).toMatchObject({ escrow: ESCROW.toString() });
    } finally {
      h.genesis = local;
    }
    expect(exists(prepared["intent"])).toBe(false);
  });

  it("signs with a default submit window, carries a partner and refuses an allowance that would overflow", async () => {
    const owner = await funded();
    const ownerInput = await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const partner = { account: w.feeRecipient.address, bps: 25 };
    const prepared = await ok(client, "prepare_signed_intent", swap({ owner: owner.address, partner }));
    expect(prepared["submit"]).toMatchObject({ submit_by: (NOW + 3_600n).toString(), partner });
    expect(DEFAULT_SUBMIT_WITHIN).toBe(3_600);
    expect(prepared["summary"]).toContain(`Partner fee: 25 bps of the sold amount, rounded up, to ${partner.account}, less the protocol's partner cut fixed when the intent is created`);
    const [delegate] = await findDelegatePda({ owner: owner.address });
    const view = h.svm.getAccount(ownerInput);
    if (!view.exists) {
      throw new Error("token account missing");
    }
    const allow = (delegatedAmount: bigint) => {
      const token = getTokenDecoder().decode(view.data);
      const data = Uint8Array.from(getTokenEncoder().encode({ ...token, delegate: some(delegate), delegatedAmount }));
      h.svm.setAccount({ ...view, data });
    };
    allow(U64_MAX - ESCROW);
    expect((await ok(client, "prepare_signed_intent", swap({ owner: owner.address })))["escrow"]).toBe(ESCROW.toString());
    allow(U64_MAX - ESCROW + 1n);
    const capped = await ok(client, "prepare_signed_intent", swap({ owner: owner.address }));
    expect(capped["summary"].at(-1)).toBe(
      `Setup: sets the engine's spending allowance on ${ownerInput} to ${formatAmount(U64_MAX, 6)} (now ${formatAmount(U64_MAX - ESCROW + 1n, 6)})`,
    );
    const outsider = (await generateKeyPairSigner()).address;
    const foreign = getTokenDecoder().decode(view.data);
    h.svm.setAccount({
      ...view,
      data: Uint8Array.from(getTokenEncoder().encode({ ...foreign, delegate: some(outsider), delegatedAmount: 5n })),
    });
    const replacing = await ok(client, "prepare_signed_intent", swap({ owner: owner.address }));
    expect(replacing["warnings"]).toContain(WARN_REPLACES_DELEGATE);
    expect(replacing["summary"].at(-1)).toBe(`Setup: removes the approval ${outsider} holds on ${ownerInput}`);
  });

  it("never promises one nonce to two requests that arrive at the same moment", async () => {
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 10_000n);
    const relaying = await connect(await funded(), free());
    const terms = swap({ owner: owner.address, order: { kind: "swap", amount_in: "100", min_out: "50" } });
    const signed = await Promise.all(Array.from({ length: 6 }, () => ok(relaying, "prepare_signed_intent", terms)));
    expect(new Set(signed.map((p) => p["nonce"])).size).toBe(6);
    const created = await Promise.all(Array.from({ length: 6 }, () => ok(client, "prepare_create", swap())));
    expect(new Set(created.map((p) => p["nonce"])).size).toBe(6);
  });

  it("refuses a nonce already handed out and takes it back when a prepare fails", async () => {
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 10_000n);
    const relaying = await connect(await funded(), free());
    const terms = swap({ owner: owner.address, nonce: "7", order: { kind: "swap", amount_in: "100", min_out: "50" } });
    const both = await Promise.all([0, 1].map(() => relaying.callTool({ name: "solive_prepare_signed_intent", arguments: terms })));
    expect(both.filter((r) => r.isError !== true)).toHaveLength(1);
    expect(both.filter((r) => r.isError === true).map((r) => (r.structuredContent as Json)["code"])).toEqual(["NoncePromised"]);
    expect(await fail(relaying, "prepare_create", terms)).toMatchObject({ code: "NoncePromised", retryable: true });
    const broke = await generateKeyPairSigner();
    await ata(w.authority, broke.address, w.inputMint, 10_000n);
    const unfunded = swap({ owner: broke.address, order: { kind: "swap", amount_in: "100", min_out: "50" } });
    expect((await fail(relaying, "prepare_signed_intent", unfunded))["code"]).not.toBe("NoncePromised");
    h.svm.airdrop(broke.address, lamports(1_000_000_000n));
    expect((await ok(relaying, "prepare_signed_intent", unfunded))["nonce"]).toBe("0");
  });

  it("relays one signed intent once however many times it is submitted at the same moment", async () => {
    const relayer = await funded();
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 10_000n);
    const cost = createCost({ createFee: 0, crankBounty: 0 }, await rentRate(transport));
    const relaying = await connect(relayer, [...free(), "--relay-hourly-lamports", (2n * cost).toString()]);
    const terms = swap({ owner: owner.address, order: { kind: "swap", amount_in: "100", min_out: "50" } });
    const sign = async (message: string) =>
      getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(message)));
    const first = await ok(relaying, "prepare_signed_intent", terms);
    await execute(first["setup"], owner);
    const second = await ok(relaying, "prepare_signed_intent", terms);
    await execute(second["setup"], owner);
    const payload = { ...first["submit"], signature: await sign(first["message"]) };
    const before = h.svm.getBalance(relayer.address) ?? 0n;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        relaying.callTool({ name: "solive_submit_signed_intent", arguments: payload as Record<string, unknown> }),
      ),
    );
    const sent = results.filter((r) => r.isError !== true && (r.structuredContent as Json)["signature"] !== null);
    expect(sent).toHaveLength(1);
    for (const r of results.filter((x) => x.isError === true)) {
      expect((r.structuredContent as Json)["code"]).toBe("SubmitInFlight");
    }
    expect(before - (h.svm.getBalance(relayer.address) ?? 0n)).toBeLessThanOrEqual(cost);
    await ok(relaying, "submit_signed_intent", { ...second["submit"], signature: await sign(second["message"]) });
  });

  it("never claims success for a nonce another intent took, and frees the budget of a relay that never went out", async () => {
    const relayer = await funded();
    const owner = await funded();
    const ownerInput = await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const cost = createCost({ createFee: 0, crankBounty: 0 }, await rentRate(transport));
    const relaying = await connect(relayer, [...free(), "--relay-hourly-lamports", cost.toString()]);
    const terms = swap({ owner: owner.address, order: { kind: "swap", amount_in: "100", min_out: "50" } });
    const sign = async (message: string) =>
      getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(message)));
    const first = await ok(relaying, "prepare_signed_intent", terms);
    await execute(first["setup"], owner);
    const drained = await sign(first["message"]);
    const elsewhere = await connect(await funded(), [...free(), "--relay-hourly-lamports", cost.toString()]);
    const rival = await ok(elsewhere, "prepare_signed_intent", {
      ...terms,
      nonce: first["nonce"],
      order: { kind: "swap", amount_in: "100", min_out: "1" },
    });
    await send(owner, [
      getTransferInstruction({ source: ownerInput, destination: w.ownerInput, authority: owner, amount: 1_000n }),
    ]);
    expect((await fail(relaying, "submit_signed_intent", { ...first["submit"], signature: drained }))["code"]).toBe(
      "InsufficientFunds",
    );
    await send(w.owner, [
      getTransferInstruction({ source: w.ownerInput, destination: ownerInput, authority: w.owner, amount: 1_000n }),
    ]);
    await ok(relaying, "submit_signed_intent", { ...first["submit"], signature: drained });
    expect(await fail(relaying, "submit_signed_intent", { ...rival["submit"], signature: await sign(rival["message"]) })).toEqual({
      code: "NonceTaken",
      retryable: false,
      hint: "a different intent already uses this owner's nonce; these signed terms can never be submitted",
    });
  });
});
