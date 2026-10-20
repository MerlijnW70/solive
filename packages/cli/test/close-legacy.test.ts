import { type Address, type KeyPairSigner, lamports as toLamports } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimBoardAddress,
  CLAIMS_VERSION,
  findIntentPda,
  findUserStatePda,
  findVaultPda,
  getProfileSize,
  profileAddress,
  PROFILE_VERSION,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  INTENT_VERSION,
  OLDEST_INTENT_VERSION,
  USER_VERSION,
} from "@intent-engine/core";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { balance, cli, funded, h, type World, world } from "./harness.js";

type Json = Record<string, any>;

const INTENT_VERSION_AT = 8 + 164;
const USER_VERSION_AT = 8 + 72;
const PROFILE_VERSION_AT = 8 + 456;
const BOARD_VERSION_AT = 8 + 124;

describe("close-legacy on the command line", () => {
  let w: World;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    w = await world();
    keys = { "owner.json": w.owner, "payer.json": await funded() };
  });

  const createIntent = async (extra: string[] = []): Promise<Address> => {
    const judge = (await funded()).address;
    const args = ["create", "attested", "--keypair", "owner.json", "--input-mint", w.inputMint, "--output-mint", w.outputMint, "--expires-in", "3600"];
    const terms = ["--units", "raw", "--amount-in", "100", "--min-result", "1", "--max-result", "1", "--attestor", judge, "--nonce", "0", ...extra, "--yes"];
    const created = await cli([...args, ...terms], keys);
    expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
    return (await findIntentPda({ owner: w.owner.address, nonce: 0n }))[0];
  };

  const setVersion = (address: Address, at: number, version: number) => {
    const account = h.svm.getAccount(address);
    if (!account.exists) {
      throw new Error("account missing");
    }
    const data = new Uint8Array(account.data);
    data[at] = version;
    h.svm.setAccount({ ...account, data });
  };

  const lamportsOf = (address: Address) => h.svm.getBalance(address) ?? 0n;

  const close = (address: Address, yes: boolean) => cli(["close-legacy", "--keypair", "payer.json", "--address", address, ...(yes ? ["--yes"] : [])], keys);

  it("refuses a current account and an intent whose vault holds its escrow, and an owner cancels an intent of the previous version", async () => {
    const intent = await createIntent();
    const current = await close(intent, true);
    expect(current.code).toBe(EXIT_FAILED);
    expect(current.err).toContain(`${intent} is a current intent account; close-legacy closes only accounts of an earlier layout or version`);

    setVersion(intent, INTENT_VERSION_AT, 0);
    const shown = await cli(["show", "intent", "--owner", w.owner.address, "--nonce", "0"], {});
    expect(shown.code).toBe(EXIT_FAILED);
    expect(shown.err).toContain(`this intent account is of version 0; this SDK reads intent versions ${OLDEST_INTENT_VERSION} to ${INTENT_VERSION} only. Close it with intent-engine close-legacy`);
    const [vault] = await findVaultPda({ intent });
    const kept = await close(intent, true);
    expect(kept.code).toBe(EXIT_FAILED);
    expect(kept.err).toContain(`the vault ${vault} of intent ${intent} still holds its escrow; cancel, expire or close the intent first so its owner gets every token back`);
    expect(h.svm.getAccount(intent).exists).toBe(true);

    setVersion(intent, INTENT_VERSION_AT, OLDEST_INTENT_VERSION);
    const tokens = balance(w.ownerInput);
    const cancelled = await cli(["cancel", "--keypair", "owner.json", "--nonce", "0", "--close", "--yes"], keys);
    expect([cancelled.code, cancelled.err]).toEqual([EXIT_OK, ""]);
    expect(balance(w.ownerInput)).toBe(tokens + 100n);
    expect(h.svm.getAccount(intent).exists).toBe(false);
    expect(h.svm.getAccount(vault).exists).toBe(false);
  });

  it("refuses an outdated claim board of an open escrow, and closes it to its owner once the escrow is cancelled", async () => {
    const intent = await createIntent(["--spec-hash", "ab".repeat(32)]);
    const opened = await cli(["claims", "open", "--keypair", "owner.json", "--nonce", "0", "--max-secs", "3600", "--stake", "0.05", "--yes"], keys);
    expect([opened.code, opened.err]).toEqual([EXIT_OK, ""]);
    const board = await claimBoardAddress(intent);
    setVersion(board, BOARD_VERSION_AT, CLAIMS_VERSION - 1);
    const kept = await close(board, true);
    expect(kept.code).toBe(EXIT_FAILED);
    expect(kept.err).toContain(
      `${board} is an outdated claim board account of escrow ${intent}, which is still open; closing it would drop its place in the line, so upgrade it with intent-engine migrate instead`,
    );
    expect(h.svm.getAccount(board).exists).toBe(true);
    const cancelled = await cli(["cancel", "--keypair", "owner.json", "--nonce", "0", "--yes"], keys);
    expect([cancelled.code, cancelled.err]).toEqual([EXIT_OK, ""]);
    const held = lamportsOf(board);
    const before = lamportsOf(w.owner.address);
    const sent = await close(board, true);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(h.svm.getAccount(board).exists).toBe(false);
    expect(lamportsOf(w.owner.address)).toBe(before + held);
  });

  it("refuses a user state and closes an outdated profile to its wallet after a preview", async () => {
    await createIntent();
    const [user] = await findUserStatePda({ owner: w.owner.address });
    setVersion(user, USER_VERSION_AT, USER_VERSION - 1);
    const kept = await close(user, false);
    expect(kept.code).toBe(EXIT_FAILED);
    expect(kept.err).toContain(`${user} is a user account, which is upgraded in place and never closed`);

    const set = await cli(["profile", "set", "--keypair", "owner.json", "--skills", "rust", "--endpoint", "https://worker.example/jobs", "--yes"], keys);
    expect([set.code, set.err]).toEqual([EXIT_OK, ""]);
    const profile = await profileAddress(w.owner.address);
    setVersion(profile, PROFILE_VERSION_AT, PROFILE_VERSION - 1);
    const held = lamportsOf(profile);
    const preview = (await close(profile, false)).json() as Json;
    expect(preview).toMatchObject({
      sent: false,
      account: profile,
      payee: w.owner.address,
      lamports: held.toString(),
      summary: [
        `Closes ${profile}, an outdated profile account: version ${PROFILE_VERSION - 1}, ${getProfileSize()} bytes; the current one is version ${PROFILE_VERSION}, ${getProfileSize()} bytes`,
        `Sends all its ${held} lamports to ${w.owner.address}, the wallet its layout records as the one that paid for it`,
      ],
    });
    expect(lamportsOf(profile)).toBe(held);
    const before = lamportsOf(w.owner.address);
    const sent = await close(profile, true);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.json()["sent"]).toBe(true);
    expect(h.svm.getAccount(profile).exists).toBe(false);
    expect(lamportsOf(w.owner.address)).toBe(before + held);
  });

  it("pays an account of no known type to the fee recipient and refuses foreign or missing ones", async () => {
    const odd = (await funded()).address;
    const lamports = 5_000_000n;
    h.svm.setAccount({ address: odd, lamports: toLamports(lamports), data: new Uint8Array(40).fill(7), programAddress: INTENT_ENGINE_PROGRAM_ADDRESS, executable: false, space: 40n });
    const preview = (await close(odd, false)).json() as Json;
    expect(preview["payee"]).toBe(w.feeRecipient.address);
    expect(preview["summary"]).toEqual([
      `Closes ${odd}, an engine account of 40 bytes that matches no account type`,
      `Sends all its ${lamports} lamports to ${w.feeRecipient.address}, the config's fee recipient, since its layout records no payer`,
    ]);
    const before = lamportsOf(w.feeRecipient.address);
    expect((await close(odd, true)).code).toBe(EXIT_OK);
    expect(lamportsOf(w.feeRecipient.address)).toBe(before + lamports);

    const foreign = await close(w.ownerInput, false);
    expect(foreign.code).toBe(EXIT_FAILED);
    expect(foreign.err).toContain(`${w.ownerInput} is not an engine account`);
    expect((await close(odd, false)).err).toContain(`${odd} does not exist`);
    for (const args of [["close-legacy", "--keypair", "payer.json"], ["close-legacy", "extra", "--keypair", "payer.json", "--address", odd]]) {
      expect((await cli(args, keys)).code).toBe(EXIT_USAGE);
    }
  });
});
