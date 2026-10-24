import type { KeyPairSigner, Signature } from "@solana/kit";
import { getMintToInstruction } from "@solana-program/token";
import { TransactionMetadata } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, findVaultPda, Kind, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { createClient, type EngineTransaction } from "@intent-engine/client";
import { EXIT_ALERTED, EXIT_OK } from "../src/main.js";
import { cli, funded, h, NOW, type World, world } from "./harness.js";
import { listAccounts, listing } from "./monitor-transport.js";

const BASELINE = "/srv/monitor/closed.json";
const RECENT = NOW + 1_000n;

type Alert = Record<string, unknown>;

function landed(signature: Signature, blockTime: bigint): EngineTransaction {
  const meta = h.svm.getTransaction(signature);
  if (!(meta instanceof TransactionMetadata)) {
    throw new Error(`${signature} did not land`);
  }
  const emitted = meta
    .innerInstructions()
    .flat()
    .map((inner) => new Uint8Array(inner.instruction().data()));
  return { signature, slot: h.svm.getClock().slot, blockTime, failed: false, emitted };
}

describe("the monitor on fills whose intent is already closed", () => {
  let w: World;
  let solver: KeyPairSigner;

  beforeEach(async () => {
    w = await world();
    listAccounts();
    solver = await funded();
    expect((await cli(["monitor", "--write-baseline", BASELINE], {})).code).toBe(EXIT_OK);
  });

  async function settled(nonce: bigint, amountIn: bigint) {
    const client = createClient({ url: "http://127.0.0.1:8899", transport: listing });
    const created = await client.createIntent({
      signer: w.owner,
      inputMint: w.inputMint,
      outputMint: w.outputMint,
      nonce,
      params: { kind: Kind.SwapExactIn, amountIn, minOut: 1n },
    });
    const out = await findAssociatedTokenAddress({ owner: solver.address, mint: w.outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const route = [getMintToInstruction({ mint: w.outputMint, token: out, mintAuthority: w.authority, amount: 1n })];
    const filled = await client.fill({ solver, intent: { owner: w.owner.address, nonce }, route });
    const [vault] = await findVaultPda({ intent: created.intent });
    const fill = { ...landed(filled, RECENT - 3_600n), tokens: [{ account: vault, mint: w.inputMint, owner: created.intent }] };
    await client.close(solver, { owner: w.owner.address, nonce });
    expect(h.svm.getAccount(created.intent).exists).toBe(false);
    return { intent: created.intent, create: landed(created.signature, RECENT - 4_000n), fill };
  }

  const once = async (limit: string) => {
    const run = await cli(["monitor", "--expect", BASELINE, "--once", "--since", "3900", "--max-fill", `${w.inputMint}=${limit}`], {});
    return { code: run.code, alerts: run.out === "" ? [] : (run.each() as Alert[]) };
  };

  it("takes the input mint from the vault in the fill transaction, created outside --since", async () => {
    const small = await settled(0n, 100n);
    const big = await settled(1n, 600n);
    h.engineLog = [big.fill, small.fill, big.create, small.create];
    expect(await once("600")).toEqual({ code: EXIT_OK, alerts: [] });
    const capped = await once("100");
    expect(capped.code).toBe(EXIT_ALERTED);
    expect(capped.alerts).toEqual([
      { kind: "fill-amount", field: w.inputMint, expected: "100", observed: "600", slot: Number(big.fill.slot), intent: big.intent, signature: big.fill.signature },
    ]);
  });

  it("still alerts on a fill whose input mint no source holds", async () => {
    const small = await settled(0n, 100n);
    const bare: EngineTransaction = { ...small.fill, tokens: [] };
    h.engineLog = [bare];
    const unknown = await once("600");
    expect(unknown.code).toBe(EXIT_ALERTED);
    expect(unknown.alerts).toEqual([
      {
        kind: "fill-amount",
        field: "inputMint",
        expected: "a readable input mint",
        observed: "missing",
        slot: Number(bare.slot),
        intent: small.intent,
        signature: bare.signature,
        amountIn: "100",
      },
    ]);
    const other = (await funded()).address;
    h.engineLog = [{ ...small.fill, tokens: [{ account: other, mint: w.outputMint, owner: other }] }];
    expect((await once("600")).alerts.map((a) => a["field"])).toEqual(["inputMint"]);
  });
});
