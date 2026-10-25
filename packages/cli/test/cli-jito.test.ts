import {
  AccountRole,
  type Address,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type KeyPairSigner,
  lamports,
} from "@solana/kit";
import { getApproveInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import { findIntentPda, splitFee } from "@intent-engine/core/internal";
import { ENV_JUPITER_KEY } from "../src/commands.js";
import { JITO_TIP_ACCOUNTS, MAX_COMPUTE_UNITS, SIMULATION_REFUSED } from "@intent-engine/solver";
import { ata, cli, ESCROW, FEE_BPS, funded, h, NOW, send, world } from "./harness.js";
import { createSwap, type Json, unitLimitOf } from "./cli-kit.js";

describe("cli against the deployed engine", () => {
  let authority: KeyPairSigner;
  let feeRecipient: KeyPairSigner;
  let owner: KeyPairSigner;
  let inputMint: Address;
  let outputMint: Address;

  beforeEach(async () => {
    ({ authority, feeRecipient, owner, inputMint, outputMint } = await world());
  });

  const create = (nonce: string, expiresAt: bigint) => createSwap(inputMint, outputMint, nonce, expiresAt);

  it("sends a tipped bundle to jito only for a fill that simulates, and reports it as sent", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.wires.length = 0;
    h.fetched.length = 0;
    await cli(create("8", NOW + 3_600n), { "owner.json": owner });
    h.wires.length = 0;
    const solver = await funded();
    await ata(authority, feeRecipient.address, inputMint);
    await ata(authority, solver.address, inputMint);
    const solverOutput = await ata(authority, solver.address, outputMint);
    const net = splitFee(ESCROW, FEE_BPS).net;
    const jito = (swapInstruction: unknown) => [
      { status: 200, body: { inputMint, outputMint, swapMode: "ExactIn", inAmount: net.toString(), otherAmountThreshold: "999999" } },
      { status: 200, body: { swapInstruction, addressLookupTableAddresses: [] } },
      { status: 200, body: { jsonrpc: "2.0", id: 1, result: "bundle-7" } },
    ];
    const run = (program: string) =>
      cli(
        [
          "solve",
          "--keypair",
          "s.json",
          "--jupiter",
          "https://api.jup.ag/swap/v1",
          "--jito",
          "https://engine.example",
          "--tip",
          "10000",
          "--min-profit",
          `${outputMint}=1`,
          "--route-program",
          program,
        ],
        { "s.json": solver },
      );
    const [i8] = await findIntentPda({ owner: owner.address, nonce: 8n });
    h.jupiterReplies = jito({ programId: "11111111111111111111111111111111", accounts: [], data: "" });
    const doomed = (await run("11111111111111111111111111111111")).json() as Json;
    expect(doomed).toMatchObject({ filled: [], sent: [], skipped: [] });
    expect((doomed["failed"] as { intent: string; error: string }[]).map((f) => [f.intent, f.error.startsWith(SIMULATION_REFUSED)])).toEqual([
      [i8, true],
    ]);
    expect(h.fetched).toHaveLength(2);
    expect(h.wires).toEqual([]);
    for (const tip of JITO_TIP_ACCOUNTS) {
      h.svm.airdrop(tip, lamports(1_000_000_000n));
    }
    const stash = await funded();
    const stashAccount = await ata(authority, stash.address, outputMint, 1_000_000n);
    await send(stash, [getApproveInstruction({ source: stashAccount, delegate: solver.address, owner: stash, amount: 1_000_000n })]);
    const route = getTransferCheckedInstruction({
      source: stashAccount,
      mint: outputMint,
      destination: solverOutput,
      authority: solver.address,
      amount: 999_999n,
      decimals: 6,
    });
    h.fetched.length = 0;
    h.env[ENV_JUPITER_KEY] = "paid-key";
    h.jupiterReplies = jito({
      programId: route.programAddress,
      accounts: (route.accounts ?? []).map((m) => ({
        pubkey: m.address,
        isSigner: m.role === AccountRole.READONLY_SIGNER || m.role === AccountRole.WRITABLE_SIGNER,
        isWritable: m.role === AccountRole.WRITABLE || m.role === AccountRole.WRITABLE_SIGNER,
      })),
      data: Buffer.from(route.data ?? new Uint8Array()).toString("base64"),
    });
    const result = (await run(route.programAddress)).json() as Json;
    expect(result).toMatchObject({ filled: [], sent: [{ intent: i8, signature: "bundle-7" }], failed: [] });
    expect(h.wires).toEqual([]);
    expect(h.fetched[2]?.url).toBe("https://engine.example/api/v1/bundles");
    expect(h.fetched.map((f) => f.headers?.["x-api-key"])).toEqual(["paid-key", "paid-key", undefined]);
    expect(ENV_JUPITER_KEY).toBe("JUPITER_API_KEY");
    delete h.env[ENV_JUPITER_KEY];
    const sent = JSON.parse(h.fetched[2]?.body ?? "{}") as { params: [string[]] };
    expect(sent.params[0]).toHaveLength(1);
    const accounts = (wire: string) =>
      getCompiledTransactionMessageDecoder().decode(
        getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes,
      ).staticAccounts;
    expect(accounts(sent.params[0][0] ?? "").some((a) => JITO_TIP_ACCOUNTS.includes(a))).toBe(true);
    expect(unitLimitOf(sent.params[0][0] ?? "")).toBeLessThan(MAX_COMPUTE_UNITS / 10);
  });

  it("sends every fill of a solve through one jito bundle that tips only on its last transaction", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    await cli(create("8", NOW + 3_600n), { "owner.json": owner });
    await cli(create("9", NOW + 3_600n), { "owner.json": owner });
    h.wires.length = 0;
    const solver = await funded();
    await ata(authority, feeRecipient.address, inputMint);
    await ata(authority, solver.address, inputMint);
    const solverOutput = await ata(authority, solver.address, outputMint);
    for (const tip of JITO_TIP_ACCOUNTS) {
      h.svm.airdrop(tip, lamports(1_000_000_000n));
    }
    const stash = await funded();
    const stashAccount = await ata(authority, stash.address, outputMint, 1_000_000n);
    await send(stash, [getApproveInstruction({ source: stashAccount, delegate: solver.address, owner: stash, amount: 1_000_000n })]);
    const route = getTransferCheckedInstruction({
      source: stashAccount,
      mint: outputMint,
      destination: solverOutput,
      authority: solver.address,
      amount: 999_999n,
      decimals: 6,
    });
    const net = splitFee(ESCROW, FEE_BPS).net;
    const quoted = [
      { status: 200, body: { inputMint, outputMint, swapMode: "ExactIn", inAmount: net.toString(), otherAmountThreshold: "999999" } },
      {
        status: 200,
        body: {
          swapInstruction: {
            programId: route.programAddress,
            accounts: (route.accounts ?? []).map((m) => ({
              pubkey: m.address,
              isSigner: m.role === AccountRole.READONLY_SIGNER || m.role === AccountRole.WRITABLE_SIGNER,
              isWritable: m.role === AccountRole.WRITABLE || m.role === AccountRole.WRITABLE_SIGNER,
            })),
            data: Buffer.from(route.data ?? new Uint8Array()).toString("base64"),
          },
          addressLookupTableAddresses: [],
        },
      },
    ];
    const engine = "https://" + "engine.example";
    const run = (size: string, bundles: string[]) => {
      h.fetched.length = 0;
      h.jupiterReplies = [...quoted, ...quoted, ...bundles.map((id) => ({ status: 200, body: { jsonrpc: "2.0", id: 1, result: id } }))];
      return cli(
        [
          "solve",
          "--keypair",
          "s.json",
          "--jupiter",
          "https://api.jup.ag/swap/v1",
          "--jito",
          engine,
          "--tip",
          "10000",
          "--bundle-size",
          size,
          "--concurrency",
          "1",
          "--min-profit",
          `${outputMint}=1`,
          "--route-program",
          route.programAddress,
        ],
        { "s.json": solver },
      );
    };
    const [i8] = await findIntentPda({ owner: owner.address, nonce: 8n });
    const [i9] = await findIntentPda({ owner: owner.address, nonce: 9n });
    const tipped = (wire: string) =>
      getCompiledTransactionMessageDecoder()
        .decode(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes)
        .staticAccounts.some((a) => JITO_TIP_ACCOUNTS.includes(a));
    const bundled = (await run("5", ["bundle-1"])).json() as Json;
    expect(bundled).toMatchObject({ filled: [], skipped: [], failed: [] });
    expect(new Set((bundled["sent"] as { intent: string; signature: string }[]).map((s) => `${s.intent} ${s.signature}`))).toEqual(
      new Set([`${i8} bundle-1`, `${i9} bundle-1`]),
    );
    const requests = h.fetched.filter((f) => f.url === engine + "/api/v1/bundles");
    expect(requests).toHaveLength(1);
    const wires = (JSON.parse(requests[0]?.body ?? "{}") as { params: [string[]] }).params[0];
    expect(wires.map(tipped)).toEqual([false, true]);
    expect(h.wires).toEqual([]);
    const single = (await run("1", ["bundle-a", "bundle-b"])).json() as Json;
    expect((single["sent"] as { signature: string }[]).map((s) => s.signature).sort()).toEqual(["bundle-a", "bundle-b"]);
    const singles = h.fetched.filter((f) => f.url === engine + "/api/v1/bundles");
    expect(singles.map((f) => (JSON.parse(f.body ?? "{}") as { params: [string[]] }).params[0].map(tipped))).toEqual([[true], [true]]);
  });
});
