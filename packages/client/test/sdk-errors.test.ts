import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { testSignature } from "../src/testing.js";
import * as core from "@intent-engine/core";
import {
  AccountVersionError,
  EncryptionKeyError,
  IntentCoreError,
  InvalidInput,
  NoSignature,
  NotAnEngineAccount,
  NotInvited,
  SealedError,
} from "@intent-engine/core";
import * as client from "../src/index.js";
import {
  AnnouncementsUnreadable,
  BadSaltSignature,
  BehindMinSlot,
  BlockhashExpired,
  BookNotClosable,
  ClaimHeldBy,
  CommitteeNeeded,
  ConfirmMismatch,
  CosignRejected,
  EscrowExpired,
  FailedOnChain,
  FetchFailed,
  FirstOpeningRefused,
  IntentUnreadable,
  isSdkError,
  LedgerError,
  LedgerPathError,
  MainnetNotAllowed,
  MaybeSent,
  MissingAccount,
  NoFreeNonce,
  NoHeldShare,
  NoKeyAtCreation,
  RateLimited,
  TimedOut,
  Cancelled,
  TransactionUnread,
  NoMessageSigner,
  NotAMint,
  NotASignature,
  NotDeliverable,
  NotFillable,
  NotRefutable,
  NotSettleable,
  PayeeMoved,
  PayToNotWallet,
  PreviewRefused,
  ProfileHistoryIncomplete,
  SDK_ERRORS,
  SdkError,
  type SdkErrorCode,
  type SdkErrors,
  SpecSealed,
  SpecUnreadable,
  StaleRead,
  SubscriptionEnded,
  TransportLacks,
  UrlTooLong,
  VoteRejected,
} from "../src/index.js";
import { failure } from "../src/internal.js";
import { packageDir } from "./bundle.js";

const WALLET = "11111111111111111111111111111111" as Address;
const SIG = testSignature("sent");

const SAMPLES: { [C in SdkErrorCode]: () => SdkErrors[C] } = {
  "invalid-input": () => new InvalidInput("amount", "range", "amount is too large"),
  "intent-core-error": () => new IntentCoreError("Overflow"),
  "encryption-key-error": () => new EncryptionKeyError("not a key file"),
  "sealed-error": () => new SealedError("malformed"),
  "not-invited": () => new NotInvited(WALLET),
  "account-version-error": () => new AccountVersionError("intent", 1, 2, 100),
  "not-an-engine-account": () => new NotAnEngineAccount(WALLET, "not an engine intent"),
  "no-signature": () => new NoSignature(WALLET),
  "missing-account": () => new MissingAccount("intent", WALLET),
  "not-a-mint": () => new NotAMint(WALLET),
  "not-deliverable": () => new NotDeliverable(WALLET, "not-open", "is no longer open"),
  "no-message-signer": () => new NoMessageSigner(WALLET),
  "bad-salt-signature": () => new BadSaltSignature(WALLET),
  "url-too-long": () => new UrlTooLong(300, 200, 2),
  "announcements-unreadable": () => new AnnouncementsUnreadable(),
  "first-opening-refused": () => new FirstOpeningRefused(WALLET, "00".repeat(32), { reason: "nothing-opens" }),
  "not-refutable": () => new NotRefutable(WALLET, "is later"),
  "book-not-closable": () => new BookNotClosable(WALLET, "is open"),
  "no-free-nonce": () => new NoFreeNonce(WALLET),
  "no-held-share": () => new NoHeldShare(WALLET, WALLET, "not-held", "nothing held"),
  "not-settleable": () => new NotSettleable(WALLET, "not-open", "is not open"),
  "claim-held-by": () => new ClaimHeldBy(WALLET, WALLET, 9n),
  "not-fillable": () => new NotFillable(WALLET, "attested", "is attested"),
  "pay-to-not-wallet": () => new PayToNotWallet(WALLET, WALLET),
  "payee-moved": () => new PayeeMoved(WALLET, WALLET),
  "escrow-expired": () => new EscrowExpired(WALLET, 9n),
  "vote-rejected": () => new VoteRejected(WALLET, WALLET),
  "cosign-rejected": () => new CosignRejected(WALLET, WALLET),
  "committee-needed": () => new CommitteeNeeded(WALLET, 10n, 5n),
  "intent-unreadable": () => new IntentUnreadable(WALLET, new SealedError("inner")),
  "stale-read": () => new StaleRead(5n, 9n),
  "preview-refused": () => new PreviewRefused(),
  "transport-lacks": () => new TransportLacks("sendStatus"),
  "confirm-mismatch": () => new ConfirmMismatch("genesis hash", "a", "b"),
  "spec-sealed": () => new SpecSealed("https://example.org/spec", [WALLET], true),
  "spec-unreadable": () => new SpecUnreadable("https://example.org/spec", "answered 404"),
  "ledger-error": () => new LedgerError("rejected on the device"),
  "ledger-path-error": () => new LedgerPathError("not a path"),
  "maybe-sent": () => new MaybeSent(SIG, 9n, "may have landed"),
  "failed-on-chain": () => new FailedOnChain("failed", failure(SIG, null)),
  "blockhash-expired": () => new BlockhashExpired("expired"),
  "behind-min-slot": () => new BehindMinSlot(5n, 9n),
  "subscription-ended": () => new SubscriptionEnded(SIG, "ended"),
  "not-a-signature": () => new NotASignature("getSignaturesForAddress"),
  "fetch-failed": () => new FetchFailed("https://example.org/spec", "redirect", "unexpected redirect"),
  "mainnet-not-allowed": () => new MainnetNotAllowed("https://example.org"),
  "profile-history-incomplete": () => new ProfileHistoryIncomplete(WALLET),
  "no-key-at-creation": () => new NoKeyAtCreation(WALLET, WALLET),
  "rate-limited": () => new RateLimited("getTransaction", 10_000),
  "timed-out": () => new TimedOut("getTransaction", 2_500),
  cancelled: () => new Cancelled("getTransaction"),
  "transaction-unread": () => new TransactionUnread(SIG),
};

const exported: unknown[] = [...Object.values(core as Record<string, unknown>), ...Object.values(client as Record<string, unknown>)];

const exportedErrors = (): Set<unknown> =>
  new Set(exported.filter((value) => typeof value === "function" && value !== SdkError && (value as { prototype?: unknown }).prototype instanceof Error));

const samples = (): [string, () => SdkError][] => Object.entries(SAMPLES as Record<string, () => SdkError>);

describe("one typed error model", () => {
  it("every error class core and client export extends SdkError, and no two share a code", () => {
    const exported = exportedErrors();
    const codes = new Map<unknown, string>();
    for (const [code, make] of samples()) {
      const error = make();
      expect(error, code).toBeInstanceOf(SdkError);
      expect(error.code, code).toBe(code);
      expect(error.name, code).toBe(error.constructor.name);
      expect(isSdkError(error), code).toBe(true);
      expect(isSdkError(error, code as SdkErrorCode), code).toBe(true);
      expect(SDK_ERRORS[code as SdkErrorCode].error, code).toBe(error.constructor);
      expect(codes.has(error.constructor), code).toBe(false);
      codes.set(error.constructor, code);
    }
    for (const error of exported) {
      expect((error as { prototype: unknown }).prototype instanceof SdkError, (error as { name: string }).name).toBe(true);
      expect(codes.has(error), (error as { name: string }).name).toBe(true);
    }
    expect(new Set(codes.values()).size).toBe(codes.size);
    expect(codes.size).toBe(exported.size);
  });

  it("names every code in kebab case after its class, and keeps the standard cause", () => {
    for (const [code, make] of samples()) {
      expect(code).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(code).toBe(make().name.replace(/(?<!^)(?=[A-Z])/g, "-").toLowerCase());
    }
    const inner = new SealedError("inner");
    expect(new IntentUnreadable(WALLET, inner).cause).toBe(inner);
    expect(new InvalidInput("url", "format", "bad url", { cause: inner })).toMatchObject({ field: "url", rule: "format", cause: inner });
  });

  it("narrows by code and refuses look-alikes", () => {
    const error: unknown = new MaybeSent(SIG, 7n, "may have landed");
    expect(isSdkError(error, "failed-on-chain")).toBe(false);
    if (!isSdkError(error, "maybe-sent")) {
      throw error;
    }
    expect([error.signature, error.lastValidBlockHeight]).toEqual([SIG, 7n]);
    expect(isSdkError(Object.assign(new Error("x"), { code: "maybe-sent" }))).toBe(false);
    expect(isSdkError(null)).toBe(false);
    expect(isSdkError("maybe-sent")).toBe(false);
  });

  it("gives the four refusals a machine reason", () => {
    expect(new NotSettleable(WALLET, "already-paid", "already paid it").reason).toBe("already-paid");
    expect(new NotDeliverable(WALLET, "claim-held", "is claimed").reason).toBe("claim-held");
    expect(new NotFillable(WALLET, "not-open", "is not open").reason).toBe("not-open");
    expect(new FirstOpeningRefused(WALLET, "00".repeat(32), { reason: "incomplete", closed: true }).reason).toBe("incomplete");
  });
});

const SOURCES = ["core", "client"].map((name) => join(packageDir(name), "src"));
const BARE = /\bnew (Error|RangeError|TypeError|SyntaxError)\(/;
const RAW_CLASS = /\bextends (Error|RangeError|TypeError)\b/;

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
  );

describe("no bare errors in the SDK sources", () => {
  it("core and client src construct no plain Error, RangeError or TypeError, and only SdkError extends Error", () => {
    const files = SOURCES.flatMap(sources);
    expect(files.length).toBeGreaterThan(50);
    const found = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ at: `${file}:${i + 1}`, line }))
        .filter(({ line }) => BARE.test(line) || (RAW_CLASS.test(line) && !line.includes("class SdkError extends Error"))),
    );
    expect(found).toEqual([]);
  });

  it("the scan catches each banned form", () => {
    for (const line of ['throw new Error("x");', "throw new RangeError(`y`);", 'reject(new TypeError("fetch failed"));', "export class X extends RangeError {"]) {
      expect(BARE.test(line) || RAW_CLASS.test(line), line).toBe(true);
    }
    expect(BARE.test('throw new InvalidInput("a", "range", "b");')).toBe(false);
  });
});
