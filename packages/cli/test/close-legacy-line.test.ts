import { type Address, getAddressEncoder, type KeyPairSigner, lamports as toLamports } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimBoardAddress,
  CLAIMS_VERSION,
  findIntentPda,
  findVaultPda,
  getIntentDecoder,
  INTENT_VERSION,
  OLDEST_INTENT_VERSION,
  profileAddress,
  PROFILE_VERSION,
  TOKEN_PROGRAM_ADDRESS,
} from "@intent-engine/core";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { cli, funded, h, NOW, setNow, type World, world } from "./harness.js";

type Json = Record<string, any>;

const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const INTENT_VERSION_AT = 8 + 164;
const BOARD_VERSION_AT = 8 + 124;
const PROFILE_VERSION_AT = 8 + 456;
const STAKE = 50_000_000n;

describe("close-legacy on a line account and the escrow behind it", () => {
  let w: World;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    w = await world();
    keys = { "owner.json": w.owner, "payer.json": await funded(), "worker.json": await funded() };
  });

  const createIntent = async (extra: string[] = []): Promise<Address> => {
    const judge = (await funded()).address;
    const args = ["create", "attested", "--keypair", "owner.json", "--input-mint", w.inputMint, "--output-mint", w.outputMint, "--expires-in", "3600"];
    const terms = ["--units", "raw", "--amount-in", "100", "--min-result", "1", "--max-result", "1", "--attestor", judge, "--nonce", "0", ...extra, "--yes"];
    const created = await cli([...args, ...terms], keys);
    expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
    return (await findIntentPda({ owner: w.owner.address, nonce: 0n }))[0];
  };

  const edit = (address: Address, change: (data: Uint8Array) => void) => {
    const account = h.svm.getAccount(address);
    if (!account.exists) {
      throw new Error("account missing");
    }
    const data = new Uint8Array(account.data);
    change(data);
    h.svm.setAccount({ ...account, data });
  };

  const lamportsOf = (address: Address) => h.svm.getBalance(address) ?? 0n;

  const close = (address: Address) => cli(["close-legacy", "--keypair", "payer.json", "--address", address], keys);

  const outdatedBoard = async (take: boolean) => {
    const intent = await createIntent(["--spec-hash", "ab".repeat(32)]);
    const opened = await cli(["claims", "open", "--keypair", "owner.json", "--nonce", "0", "--max-secs", "3600", "--stake", "0.05", "--yes"], keys);
    expect([opened.code, opened.err]).toEqual([EXIT_OK, ""]);
    if (take) {
      const taken = await cli(["claims", "take", "--keypair", "worker.json", "--owner", w.owner.address, "--nonce", "0", "--secs", "600", "--yes"], keys);
      expect([taken.code, taken.err]).toEqual([EXIT_OK, ""]);
    }
    const board = await claimBoardAddress(intent);
    edit(board, (data) => {
      data[BOARD_VERSION_AT] = CLAIMS_VERSION - 1;
    });
    return { intent, board };
  };

  it("refuses while the escrow reads as open and closes once it reads as closed or unreadable", async () => {
    const { intent, board } = await outdatedBoard(false);
    const original = h.svm.getAccount(intent);
    if (!original.exists) {
      throw new Error("intent missing");
    }
    const open = `${board} is an outdated claim board account of escrow ${intent}, which is still open; closing it would drop its place in the line, so upgrade it with intent-engine migrate instead`;
    const reads = async (outcome: "open" | "closed", label: string) => {
      const result = await close(board);
      const seen = result.code === EXIT_OK ? result.json()["sent"] : result.err;
      expect([label, result.code, seen]).toEqual(outcome === "open" ? [label, EXIT_FAILED, open] : [label, EXIT_OK, false]);
    };
    const restore = () => h.svm.setAccount(original);
    const withVersion = (version: number) => {
      restore();
      edit(intent, (data) => {
        data[INTENT_VERSION_AT] = version;
      });
    };

    await reads("open", "current");
    withVersion(OLDEST_INTENT_VERSION);
    await reads("open", "oldest version");
    withVersion(OLDEST_INTENT_VERSION - 1);
    await reads("closed", "below the oldest version");
    withVersion(INTENT_VERSION + 1);
    await reads("closed", "above the current version");

    h.svm.setAccount({ ...original, data: original.data.slice(0, 8), space: 8n });
    await reads("closed", "too short to hold a version");
    h.svm.setAccount({ ...original, programAddress: TOKEN_PROGRAM_ADDRESS });
    await reads("closed", "owned by another program");
    h.svm.setAccount({ ...original, lamports: toLamports(0n), data: new Uint8Array(0), space: 0n, programAddress: SYSTEM_PROGRAM });
    await reads("closed", "gone");

    restore();
    const expiresAt = getIntentDecoder().decode(original.data).expiresAt;
    setNow(expiresAt - 1n);
    await reads("open", "a second before expiry");
    setNow(expiresAt);
    await reads("closed", "at expiry");
  });

  it("pays a held stake to its worker and a lapsed one with the rest to the owner", async () => {
    const { intent, board } = await outdatedBoard(true);
    h.svm.setAccount({ address: intent, lamports: toLamports(0n), data: new Uint8Array(0), space: 0n, programAddress: SYSTEM_PROGRAM, executable: false });
    const held = lamportsOf(board);
    const worker = keys["worker.json"]?.address;
    const paid = "the wallet its layout records as the one that paid for it";
    const shown = (await close(board)).json() as Json;
    expect(shown).toMatchObject({ sent: false, account: board, payee: w.owner.address, lamports: held.toString() });
    expect(shown["summary"].slice(1)).toEqual([
      `Pays the ${STAKE} lamports of claim stake it holds to ${worker}, as settling the claim would`,
      `Sends the other ${held - STAKE} lamports to ${w.owner.address}, ${paid}`,
    ]);
    setNow(NOW + 601n);
    const lapsed = (await close(board)).json() as Json;
    expect(lapsed["summary"].slice(1)).toEqual([`Sends all its ${held} lamports to ${w.owner.address}, ${paid}`]);
  });

  it("closes an outdated intent whose vault account is left empty", async () => {
    const intent = await createIntent();
    edit(intent, (data) => {
      data[INTENT_VERSION_AT] = 0;
    });
    const [vault] = await findVaultPda({ intent });
    h.svm.setAccount({ address: vault, lamports: toLamports(1_000_000n), data: new Uint8Array(0), space: 0n, programAddress: TOKEN_PROGRAM_ADDRESS, executable: false });
    const shown = await close(intent);
    expect([shown.code, shown.json()["sent"], shown.json()["account"]]).toEqual([EXIT_OK, false, intent]);
  });

  it("pays an outdated profile to the data account its layout records as the payer", async () => {
    await createIntent();
    const set = await cli(["profile", "set", "--keypair", "owner.json", "--skills", "rust", "--endpoint", "https://worker.example/jobs", "--yes"], keys);
    expect([set.code, set.err]).toEqual([EXIT_OK, ""]);
    const profile = await profileAddress(w.owner.address);
    edit(profile, (data) => {
      data[PROFILE_VERSION_AT] = PROFILE_VERSION - 1;
      data.set(getAddressEncoder().encode(w.ownerInput), 8);
    });
    const shown = (await close(profile)).json() as Json;
    expect(shown["payee"]).toBe(w.ownerInput);
    expect(shown["summary"].slice(1)).toEqual([`Sends all its ${lamportsOf(profile)} lamports to ${w.ownerInput}, the wallet its layout records as the one that paid for it`]);
  });
});
