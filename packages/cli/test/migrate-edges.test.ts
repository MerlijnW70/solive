import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimBoardAddress, findIntentPda, findUserStatePda, getClaimBoardSize, LEGACY_BOARD_SPACE } from "@intent-engine/core";
import { EXIT_OK } from "../src/main.js";
import { MIGRATE_BATCH } from "../src/migrate-commands.js";
import { cli, funded, h, transport, type World, world } from "./harness.js";

type Json = Record<string, any>;
type Listed = { address: Address; data: Uint8Array; lamports: bigint };

const VERSION_AT = { user: 8 + 72, intent: 8 + 164, board: 8 + 124 };
const HELD_AT = 8 + 112;
const STAKE = 50_000_000n;

describe("migrate rent and batches", () => {
  let w: World;
  let keys: Record<string, KeyPairSigner>;
  let listed: Listed[];
  let sent: number[];

  beforeEach(async () => {
    w = await world();
    keys = { "owner.json": w.owner, "payer.json": await funded() };
    listed = [];
    sent = [];
  });

  const migrate = (yes: boolean) => {
    h.through = {
      ...transport,
      engineAccounts: async () => listed,
      send: async (instructions) => {
        sent.push(instructions.length);
        throw new Error("refused by the node");
      },
    };
    return cli(["migrate", "--keypair", "payer.json", "--all", ...(yes ? ["--yes"] : [])], keys);
  };

  afterEach(() => {
    h.through = null;
  });

  const created = async (): Promise<Address> => {
    const judge = (await funded()).address;
    const args = ["create", "attested", "--keypair", "owner.json", "--input-mint", w.inputMint, "--output-mint", w.outputMint, "--expires-in", "3600"];
    const terms = ["--units", "raw", "--amount-in", "100", "--min-result", "1", "--max-result", "1", "--attestor", judge, "--nonce", "0", "--spec-hash", "ab".repeat(32), "--yes"];
    const made = await cli([...args, ...terms], keys);
    expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
    return (await findIntentPda({ owner: w.owner.address, nonce: 0n }))[0];
  };

  const dataOf = (address: Address): Uint8Array => {
    const account = h.svm.getAccount(address);
    if (!account.exists) {
      throw new Error("account missing");
    }
    return new Uint8Array(account.data);
  };

  const outdated = (data: Uint8Array, at: number, version = 1): Uint8Array => {
    const copy = data.slice();
    copy[at] = version;
    return copy;
  };

  const legacyBoard = async (): Promise<Uint8Array> => {
    const intent = await created();
    const opened = await cli(["claims", "open", "--keypair", "owner.json", "--nonce", "0", "--max-secs", "3600", "--stake", "0.05", "--yes"], keys);
    expect([opened.code, opened.err]).toEqual([EXIT_OK, ""]);
    const board = outdated(dataOf(await claimBoardAddress(intent)).slice(0, LEGACY_BOARD_SPACE), VERSION_AT.board);
    new DataView(board.buffer).setBigUint64(HELD_AT, STAKE, true);
    return board;
  };

  const preview = async (): Promise<Json> => {
    const all = await migrate(false);
    expect([all.code, all.err.includes("Error")]).toEqual([EXIT_OK, false]);
    return all.json() as Json;
  };

  it("tops a growing claim board up to its new rent plus the stake it holds", async () => {
    const data = await legacyBoard();
    const oldMin = h.svm.minimumBalanceForRentExemption(BigInt(LEGACY_BOARD_SPACE));
    const newMin = h.svm.minimumBalanceForRentExemption(BigInt(getClaimBoardSize()));
    const short = 1_000n;
    const address = (await generateKeyPairSigner()).address;
    listed = [{ address, data, lamports: oldMin + STAKE - short }];
    const lacking = await preview();
    expect(lacking).toMatchObject({ migrate: { "claim board": 1 }, top_up_lamports: (newMin - oldMin + short).toString() });
    expect(lacking["summary"]).toContain(`Pays ${newMin - oldMin + short} lamports of rent from ${keys["payer.json"]?.address} for the accounts that grow; no account loses lamports`);
    listed = [{ address, data, lamports: oldMin + STAKE + 7_000n }];
    expect(await preview()).toMatchObject({ top_up_lamports: (newMin - oldMin).toString() });
  });

  it("tops up nothing for an account that keeps its size, even one below its rent", async () => {
    const intent = await created();
    listed = [{ address: intent, data: outdated(dataOf(intent), VERSION_AT.intent), lamports: 1_000n }];
    const kept = await preview();
    expect(kept).toMatchObject({ migrate: { intent: 1 }, top_up_lamports: "0" });
    expect(kept["summary"]).toEqual(["Migrates 1 outdated engine accounts in 1 transactions: 1 intent", "Skips 0 accounts that are already current"]);
  });

  it("sends a full batch then the rest, and names the accounts of each failed batch", async () => {
    await created();
    const [user] = await findUserStatePda({ owner: w.owner.address });
    const data = outdated(dataOf(user), VERSION_AT.user);
    const addresses = await Promise.all(Array.from({ length: MIGRATE_BATCH + 1 }, async () => (await generateKeyPairSigner()).address));
    listed = addresses.map((address) => ({ address, data, lamports: 10_000_000n }));
    const tried = await migrate(true);
    expect([tried.code, tried.err]).toEqual([EXIT_OK, ""]);
    expect(tried.json()).toMatchObject({ sent: true, transactions: 2, signatures: [] });
    expect(tried.json()["failed"]).toEqual([
      { accounts: addresses.slice(0, MIGRATE_BATCH), error: "refused by the node" },
      { accounts: addresses.slice(MIGRATE_BATCH), error: "refused by the node" },
    ]);
    expect(sent).toHaveLength(2);
    expect((sent[0] ?? 0) - (sent[1] ?? 0)).toBe(MIGRATE_BATCH - 1);
  });
});
