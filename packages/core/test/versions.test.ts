import { createHash } from "node:crypto";
import { type Address, AccountRole, getAddressDecoder, getAddressEncoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_LAYOUTS,
  type AccountLayout,
  AccountVersionError,
  boardTerms,
  IntentCoreError,
  legacyStakeTo,
  lineIntent,
  migratesInPlace,
  buildCloseLegacy,
  checkAccountVersion,
  findConfigPda,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  isCurrentAccount,
  recordedPayer,
  storedVersion,
} from "../src/index.js";

const PAYER = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" as Address;

function account(layout: AccountLayout, version: number, size = layout.space): Uint8Array {
  const data = new Uint8Array(size);
  data.set(layout.discriminator, 0);
  data[8 + layout.versionAt] = version;
  if (layout.payerAt !== null) {
    data.set(getAddressEncoder().encode(PAYER), 8 + layout.payerAt);
  }
  return data;
}

const named = (name: string): AccountLayout => {
  const layout = ACCOUNT_LAYOUTS.find((l) => l.name === name);
  if (layout === undefined) throw new Error(name);
  return layout;
};

describe("account versions", () => {
  it("name one layout per account type, each discriminator the hash of its type name", () => {
    const types = ["Config", "UserState", "Intent", "Mandate", "MintCap", "Committee", "ClaimBoard", "Standby", "Profile", "ClaimList"];
    expect(ACCOUNT_LAYOUTS.map((l) => [...l.discriminator])).toEqual(
      types.map((t) => [...createHash("sha256").update(`account:${t}`).digest().subarray(0, 8)]),
    );
  });

  it("read an account only at the current version of its type", () => {
    for (const layout of ACCOUNT_LAYOUTS) {
      const current = account(layout, layout.version);
      expect(isCurrentAccount(current)).toBe(true);
      expect(checkAccountVersion(current)).toBe(current);
      expect(storedVersion(current)).toEqual({ layout, version: layout.version });
      const reads = layout.oldest === layout.version ? `version ${layout.version}` : `versions ${layout.oldest} to ${layout.version}`;
      for (const version of [0, layout.version - 1, layout.version + 1, 255].filter((v) => v !== layout.version && v >= 0)) {
        const other = account(layout, version);
        expect(isCurrentAccount(other)).toBe(false);
        if (version >= layout.oldest && version <= layout.version) {
          expect(checkAccountVersion(other)).toBe(other);
          continue;
        }
        expect(() => checkAccountVersion(other)).toThrow(AccountVersionError);
        expect(() => checkAccountVersion(other)).toThrow(
          `this ${layout.name} account is of version ${version}; this SDK reads ${layout.name} ${reads} only. Close it with intent-engine close-legacy`,
        );
      }
    }
  });

  it("read the previous version of intents, mint caps and claim boards, so their owners can still get their escrow back", () => {
    expect(ACCOUNT_LAYOUTS.filter((l) => l.oldest < l.version).map((l) => [l.name, l.oldest])).toEqual([
      ["intent", 1],
      ["mint cap", 1],
      ["claim board", 1],
    ]);
    expect(ACCOUNT_LAYOUTS.filter((l) => migratesInPlace(account(l, 1))).map((l) => l.name)).toEqual(["config", "user"]);
    const board = named("claim board");
    const data = account(board, 1);
    const worker = "So11111111111111111111111111111111111111112" as Address;
    data.set(getAddressEncoder().encode(worker), 8 + 64);
    data.set([0x10, 0x27], 8 + 96);
    data.set([0x40, 0x42, 0x0f], 8 + 112);
    const terms = boardTerms(data);
    expect(terms).toEqual({ intent: "11111111111111111111111111111111", owner: PAYER, worker, until: 10_000n, held: 1_000_000n });
    if (terms === null) throw new Error("no terms");
    expect(legacyStakeTo(terms, false, 9_999n)).toBe(worker);
    expect(() => legacyStakeTo(terms, true, 9_999n)).toThrow(IntentCoreError);
    expect(legacyStakeTo(terms, true, 10_000n)).toBe(PAYER);
    expect(legacyStakeTo({ ...terms, held: 0n }, false, 0n)).toBeNull();
    expect(boardTerms(account(named("intent"), 1))).toBeNull();
  });

  it("name the escrow of a claim board and a stand-by entry, and of nothing else", () => {
    const escrow = "So11111111111111111111111111111111111111112" as Address;
    const board = account(named("claim board"), 1);
    board.set(getAddressEncoder().encode(escrow), 8);
    const entry = account(named("stand-by entry"), 0);
    entry.set(getAddressEncoder().encode(escrow), 8 + 32);
    expect([lineIntent(board), lineIntent(entry)]).toEqual([escrow, escrow]);
    expect(lineIntent(account(named("intent"), 1))).toBeNull();
    expect(lineIntent(entry.slice(0, 40))).toBeNull();
  });

  it("read a board, a stand-by entry and a payer from data that ends right after the field, and nothing shorter", () => {
    const board = account(named("claim board"), 1);
    const worker = "So11111111111111111111111111111111111111112" as Address;
    board.set(getAddressEncoder().encode(worker), 8 + 64);
    board.set([0x10, 0x27], 8 + 96);
    board.set([7], 8 + 112);
    const exact = board.slice(0, 8 + 120);
    expect(boardTerms(exact)).toEqual({ intent: "11111111111111111111111111111111", owner: PAYER, worker, until: 10_000n, held: 7n });
    expect(boardTerms(board.slice(0, 8 + 119))).toBeNull();
    expect(boardTerms(board.slice(0, 50))).toBeNull();
    const escrow = "So11111111111111111111111111111111111111112" as Address;
    const entry = account(named("stand-by entry"), 0);
    entry.set(getAddressEncoder().encode(escrow), 8 + 32);
    expect(lineIntent(entry.slice(0, 8 + 64))).toBe(escrow);
    expect(lineIntent(entry.slice(0, 8 + 63))).toBeNull();
    const payerAt = named("claim board").payerAt ?? 0;
    expect(recordedPayer(board.slice(0, 8 + payerAt + 32))).toBe(PAYER);
    expect(recordedPayer(board.slice(0, 8 + payerAt + 31))).toBeNull();
  });

  it("build close-legacy with each optional account it is given, in its own slot", async () => {
    const target = "So11111111111111111111111111111111111111112" as Address;
    const [config, vault, intent, stakeTo, feeTo] = [1, 2, 3, 4, 5].map((n) => getAddressDecoder().decode(new Uint8Array(32).fill(n))) as [Address, Address, Address, Address, Address];
    const slots = (ix: { accounts: readonly { address: Address }[] }) => ix.accounts.slice(2, 7).map(({ address }) => address);
    expect(slots(await buildCloseLegacy({ account: target, payee: PAYER, config, vault, intent, stakeTo, feeTo }))).toEqual([config, vault, intent, stakeTo, feeTo]);
    expect(slots(await buildCloseLegacy({ account: target, payee: PAYER, vault, feeTo }))).toEqual([
      INTENT_ENGINE_PROGRAM_ADDRESS,
      vault,
      INTENT_ENGINE_PROGRAM_ADDRESS,
      INTENT_ENGINE_PROGRAM_ADDRESS,
      feeTo,
    ]);
    expect(slots(await buildCloseLegacy({ account: target, payee: PAYER, intent, stakeTo }))).toEqual([
      INTENT_ENGINE_PROGRAM_ADDRESS,
      INTENT_ENGINE_PROGRAM_ADDRESS,
      intent,
      stakeTo,
      INTENT_ENGINE_PROGRAM_ADDRESS,
    ]);
  });

  it("refuse an account of an earlier size with its length", () => {
    const board = named("claim board");
    const old = account(board, 1, 168);
    expect(isCurrentAccount(old)).toBe(false);
    expect(() => checkAccountVersion(old)).toThrow("this claim board account is 168 bytes long, not the claim board layout");
    expect(() => checkAccountVersion(new Uint8Array(40).fill(7))).toThrow(RangeError);
  });

  it("find the wallet a layout records as the payer, and none where it records none", () => {
    for (const layout of ACCOUNT_LAYOUTS) {
      expect(recordedPayer(account(layout, 1))).toBe(layout.payerAt === null ? null : PAYER);
    }
    const board = named("claim board");
    expect(recordedPayer(account(board, 1, 168))).toBe(PAYER);
    expect(recordedPayer(account(board, 1).slice(0, 60))).toBeNull();
    const blank = new Uint8Array(board.space);
    blank.set(board.discriminator, 0);
    expect(recordedPayer(blank)).toBeNull();
    expect(recordedPayer(new Uint8Array(40).fill(7))).toBeNull();
  });

  it("build close-legacy with the config only when it is passed", async () => {
    const [config] = await findConfigPda();
    const tag = [...createHash("sha256").update("global:close_legacy").digest().subarray(0, 8)];
    const target = "So11111111111111111111111111111111111111112" as Address;
    const withConfig = await buildCloseLegacy({ account: target, payee: PAYER, config });
    expect([...withConfig.data]).toEqual(tag);
    expect(withConfig.accounts.slice(0, 3)).toEqual([
      { address: target, role: AccountRole.WRITABLE },
      { address: PAYER, role: AccountRole.WRITABLE },
      { address: config, role: AccountRole.READONLY },
    ]);
    const without = await buildCloseLegacy({ account: target, payee: PAYER });
    expect(without.accounts[2]).toEqual({ address: INTENT_ENGINE_PROGRAM_ADDRESS, role: AccountRole.READONLY });
  });
});
