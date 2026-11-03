import { type Address, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { AccountVersionError } from "@intent-engine/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RefutationView } from "../src/announcement-reads.js";
import type { Transport } from "../src/transport.js";

const mocked = vi.hoisted(() => ({
  blobHead: vi.fn(),
  openWithEsk: vi.fn(),
  keyFingerprintV4: vi.fn(),
  announcementCommitment: vi.fn(),
  parseEncryptionKey: vi.fn(),
  isEncryptionKeyText: vi.fn(),
  committeeKeys: vi.fn(),
  loadProfile: vi.fn(),
}));

vi.mock("@intent-engine/core/internal", async (importOriginal) => {
  const real = await importOriginal<typeof import("@intent-engine/core/internal")>();
  return {
    ...real,
    delivery: { ...real.delivery, blobHead: mocked.blobHead },
    openWithEsk: mocked.openWithEsk,
    keyFingerprintV4: mocked.keyFingerprintV4,
    announcementCommitment: mocked.announcementCommitment,
    parseEncryptionKey: mocked.parseEncryptionKey,
    isEncryptionKeyText: mocked.isEncryptionKeyText,
  };
});

vi.mock("../src/announce-keys.js", () => ({ committeeKeys: mocked.committeeKeys }));
vi.mock("../src/client-claims.js", () => ({ loadProfile: mocked.loadProfile }));

const { standingOf } = await import("../src/refutation-standing.js");

const FIRST = "11111111111111111111111111111112" as Address;
const SECOND = "So11111111111111111111111111111111111111112" as Address;
const KEY = new Uint8Array(32).fill(7);
const FINGERPRINT = new Uint8Array(32).fill(9);
const COMMITMENT = new Uint8Array(32).fill(3);

const refutation = { attestor: FIRST, intent: SECOND, blob: new Uint8Array(1), esk: new Uint8Array(32), earlierWorker: SECOND, delivered: new Uint8Array(32), earlierCommitment: COMMITMENT } as unknown as RefutationView;

beforeEach(() => {
  vi.resetAllMocks();
  mocked.committeeKeys.mockResolvedValue({ members: [FIRST, SECOND] });
  mocked.loadProfile.mockResolvedValue({ encryptionKey: "key text" });
  mocked.parseEncryptionKey.mockReturnValue(KEY);
  mocked.isEncryptionKeyText.mockReturnValue(true);
  mocked.keyFingerprintV4.mockResolvedValue(FINGERPRINT);
  mocked.openWithEsk.mockResolvedValue({ salt: new Uint8Array(32) });
  mocked.announcementCommitment.mockResolvedValue(COMMITMENT);
});

describe("the recipients a refutation is opened against", () => {
  it("takes the key of a recipient whose bit is set and the bare wallet of one whose bit is clear", async () => {
    mocked.blobHead.mockReturnValue({ count: 2, mask: 0b10, fps: [new Uint8Array(32), FINGERPRINT], urlLen: 0 });
    expect(await standingOf({} as Transport, refutation)).toBe("substantiated");
    expect(mocked.loadProfile).toHaveBeenCalledTimes(1);
    expect(mocked.loadProfile.mock.calls[0]?.[1]).toBe(SECOND);
    expect(mocked.openWithEsk.mock.calls[0]?.[2]).toStrictEqual([FIRST, { wallet: SECOND, encryptionKey: KEY }]);
  });

  it("reads the bits from the lowest up", async () => {
    mocked.blobHead.mockReturnValue({ count: 2, mask: 0b01, fps: [FINGERPRINT, new Uint8Array(32)], urlLen: 0 });
    expect(await standingOf({} as Transport, refutation)).toBe("substantiated");
    expect(mocked.loadProfile.mock.calls[0]?.[1]).toBe(FIRST);
    expect(mocked.openWithEsk.mock.calls[0]?.[2]).toStrictEqual([{ wallet: FIRST, encryptionKey: KEY }, SECOND]);
  });

  it("is unverifiable when a keyed recipient's key no longer matches its fingerprint", async () => {
    mocked.blobHead.mockReturnValue({ count: 2, mask: 0b10, fps: [new Uint8Array(32), new Uint8Array(32).fill(1)], urlLen: 0 });
    expect(await standingOf({} as Transport, refutation)).toBe("unverifiable");
  });
});

describe("a keyed recipient's profile that cannot give a key", () => {
  const sealedToSecond = () => mocked.blobHead.mockReturnValue({ count: 2, mask: 0b10, fps: [new Uint8Array(32), FINGERPRINT], urlLen: 0 });

  it("is unverifiable when the profile publishes no key or does not exist", async () => {
    sealedToSecond();
    mocked.loadProfile.mockResolvedValue({ encryptionKey: null });
    expect(await standingOf({} as Transport, refutation)).toBe("unverifiable");
    mocked.loadProfile.mockResolvedValue(null);
    expect(await standingOf({} as Transport, refutation)).toBe("unverifiable");
    expect(mocked.openWithEsk).not.toHaveBeenCalled();
  });

  it("is unverifiable when the profile names a key no secret can be made with, or is of a layout this SDK cannot read", async () => {
    sealedToSecond();
    mocked.isEncryptionKeyText.mockReturnValue(false);
    expect(await standingOf({} as Transport, refutation)).toBe("unverifiable");
    mocked.isEncryptionKeyText.mockReturnValue(true);
    mocked.loadProfile.mockRejectedValue(new AccountVersionError("profile", 9, 1, 100));
    expect(await standingOf({} as Transport, refutation)).toBe("unverifiable");
    expect(mocked.openWithEsk).not.toHaveBeenCalled();
  });

  it("throws a transport error instead of calling the refutation unverifiable", async () => {
    sealedToSecond();
    const error = new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "Bad Gateway", statusCode: 502 });
    mocked.loadProfile.mockRejectedValue(error);
    await expect(standingOf({} as Transport, refutation)).rejects.toBe(error);
  });
});
