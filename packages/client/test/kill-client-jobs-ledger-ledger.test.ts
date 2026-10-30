import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { type Address, getAddressDecoder, type SignableMessage } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { COSIGN_KEYS_AT, MAX_COSIGNERS, OFFCHAIN_PREFIX } from "@intent-engine/core/internal";
import { envelopeDigest, LEDGER_ERRORS, LEDGER_FORMS, LedgerError, LedgerPathError, type LedgerTransport, type OpenTransport, parseLedgerPath } from "../src/ledger-path.js";
import { ledgerSigner, notOwnEnvelope, plainLedgerError } from "../src/ledger.js";

const OK = [0x90, 0x00];
const MORE = 0x02;
const GET_VERSION = 0x04;
const GET_ADDRESS = 0x05;
const PATH = "usb://ledger";
const DIGEST = "0123456789abcdef".repeat(4);

type Key = { secret: KeyObject; bytes: Uint8Array; address: Address };

function freshKey(): Key {
  for (;;) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const bytes = new Uint8Array(Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url"));
    if ((bytes[0] ?? 0) > 0 && (bytes[31] ?? 0) > 0) {
      return { secret: privateKey, bytes, address: getAddressDecoder().decode(bytes) };
    }
  }
}

type Device = { open: OpenTransport; signed: Uint8Array[] };

function device(key: Key, { forge = false, address = key.bytes }: { forge?: boolean; address?: Uint8Array } = {}): Device {
  const signed: Uint8Array[] = [];
  const open: OpenTransport = async () => {
    let chunks: number[] = [];
    const transport = {
      close: async () => undefined,
      decorateAppAPIMethods: () => undefined,
      send: async (_cla: number, ins: number, _p1: number, p2: number, data: Buffer = Buffer.alloc(0)) => {
        chunks.push(...data);
        if ((p2 & MORE) !== 0) {
          return Buffer.from(OK);
        }
        const payload = Buffer.from(chunks);
        chunks = [];
        if (ins === GET_VERSION) {
          return Buffer.from([1, 0, 1, 3, 9, ...OK]);
        }
        if (ins === GET_ADDRESS) {
          return Buffer.from([...address, ...OK]);
        }
        const message = new Uint8Array(payload.subarray(2 + 4 * (payload[1] ?? 0)));
        signed.push(message);
        const signature = sign(null, forge ? Uint8Array.from([...message, 0]) : message, key.secret);
        return Buffer.from([...signature, ...OK]);
      },
    };
    return transport as unknown as LedgerTransport;
  };
  return { open, signed };
}

const ascii = (text: string) => [...new TextEncoder().encode(text)];

const envelope = (keys: readonly Uint8Array[], digest = DIGEST, version = 1): Uint8Array =>
  Uint8Array.from([...OFFCHAIN_PREFIX, version, keys.length, ...keys.flatMap((k) => [...k]), ...ascii(digest)]);

const changed = (bytes: Uint8Array, at: number, by: number) => Uint8Array.from(bytes, (b, i) => (i === at ? b + by : b));

const ascending = (a: Uint8Array, b: Uint8Array) => {
  const at = a.findIndex((x, i) => x !== b[i]);
  return at < 0 ? 0 : (a[at] ?? 0) - (b[at] ?? 0);
};

const signable = (content: Uint8Array): SignableMessage => ({ content, signatures: {} });

async function signs(keys: (own: Key) => Uint8Array[], digest = DIGEST) {
  const own = freshKey();
  const ledger = device(own);
  const signer = await ledgerSigner(PATH, ledger.open);
  const message = envelope(keys(own), digest);
  const outcome = await signer.signMessages([signable(message)]).then(
    (signatures) => ({ signatures }),
    (error: unknown) => ({ error }),
  );
  return { own, ledger, signer, message, outcome };
}

describe("a Ledger path", () => {
  it("reads the account and change levels it names, and only those", () => {
    expect(parseLedgerPath("usb://ledger")).toStrictEqual({ derivation: "44'/501'" });
    expect(parseLedgerPath("usb://ledger?key=1")).toStrictEqual({ account: 1, derivation: "44'/501'/1'" });
    expect(parseLedgerPath("usb://ledger?key=3/0")).toStrictEqual({ account: 3, change: 0, derivation: "44'/501'/3'/0'" });
  });

  it("takes the highest hardened index and refuses the next one", () => {
    expect(parseLedgerPath("usb://ledger?key=2147483647")).toStrictEqual({ account: 2147483647, derivation: "44'/501'/2147483647'" });
    const next = "usb://ledger?key=2147483648";
    expect(() => parseLedgerPath(next)).toThrow(LedgerPathError);
    expect(() => parseLedgerPath(next)).toThrow(LEDGER_FORMS.join(", "));
  });

  it("reads the digest at the end of an envelope", () => {
    expect(envelopeDigest(envelope([new Uint8Array(32).fill(1)]))).toBe(DIGEST);
  });
});

describe("a Ledger error in plain words", () => {
  it("names blind signing by its status alone and a missing device by its id alone", () => {
    expect(plainLedgerError({ statusCode: 0x6808, message: "x" }).message).toBe(LEDGER_ERRORS.blindSigning);
    expect(plainLedgerError({ id: "NoDevice", message: "x" }).message).toBe(LEDGER_ERRORS.notFound);
    expect(plainLedgerError({ message: "x" }).message).toBe("the Ledger could not be used: x; nothing was sent");
  });
});

describe("a Ledger signer", () => {
  it("refuses a device that answers with an address of the wrong size", async () => {
    const own = freshKey();
    await expect(ledgerSigner(PATH, device(own, { address: own.bytes.subarray(1) }).open)).rejects.toThrow(
      new LedgerError(`the Ledger returned no 32 byte address for ${PATH}; nothing was sent`),
    );
  });

  it("signs an envelope whose only signer is its own key, with every hex digit in the digest", async () => {
    const { own, ledger, signer, message, outcome } = await signs((key) => [key.bytes]);
    expect(signer.address).toBe(own.address);
    expect(outcome).toStrictEqual({ signatures: [{ [own.address]: new Uint8Array(sign(null, message, own.secret)) }] });
    expect(ledger.signed).toStrictEqual([message]);
  });

  it("signs an envelope of two sorted signers that differ in their first byte", async () => {
    const { own, message, outcome } = await signs((key) => [changed(key.bytes, 0, -1), key.bytes]);
    expect(outcome).toStrictEqual({ signatures: [{ [own.address]: new Uint8Array(sign(null, message, own.secret)) }] });
  });

  it("signs an envelope of two sorted signers that differ only in their last byte", async () => {
    const { own, message, outcome } = await signs((key) => [changed(key.bytes, 31, -1), key.bytes]);
    expect(outcome).toStrictEqual({ signatures: [{ [own.address]: new Uint8Array(sign(null, message, own.secret)) }] });
  });

  it("signs an envelope with the most signers a release takes", async () => {
    const { own, message, outcome } = await signs((key) => [key.bytes, ...Array.from({ length: MAX_COSIGNERS - 1 }, () => freshKey().bytes)].sort(ascending));
    expect(message.length).toBe(COSIGN_KEYS_AT + 32 * MAX_COSIGNERS + 64);
    expect(outcome).toStrictEqual({ signatures: [{ [own.address]: new Uint8Array(sign(null, message, own.secret)) }] });
  });

  const refused = async (keys: (own: Key) => Uint8Array[], digest = DIGEST) => {
    const { own, ledger, outcome } = await signs(keys, digest);
    expect(outcome).toStrictEqual({ error: new LedgerError(notOwnEnvelope(own.address)) });
    expect(ledger.signed).toStrictEqual([]);
  };

  it("refuses a digest with a character that is not a lowercase hex digit", async () => {
    for (const bad of ["g", "/", ":", "`", "A"]) {
      await refused((key) => [key.bytes], `${DIGEST.slice(0, 63)}${bad}`);
    }
  });

  it("refuses an envelope that does not name its own key", async () => {
    await refused(() => [freshKey().bytes]);
    await refused(() => [freshKey().bytes, freshKey().bytes].sort(ascending));
  });

  it("refuses signers out of order", async () => {
    await refused((key) => [key.bytes, changed(key.bytes, 0, -1)]);
    await refused((key) => [key.bytes, changed(key.bytes, 31, -1)]);
  });

  it("refuses an envelope of no signers, of too many, or of another version", async () => {
    await refused(() => []);
    await refused((key) => [key.bytes, ...Array.from({ length: MAX_COSIGNERS }, () => freshKey().bytes)].sort(ascending));
    const own = freshKey();
    const ledger = device(own);
    const signer = await ledgerSigner(PATH, ledger.open);
    await expect(signer.signMessages([signable(envelope([own.bytes], DIGEST, 0))])).rejects.toThrow(new LedgerError(notOwnEnvelope(own.address)));
    expect(ledger.signed).toStrictEqual([]);
  });

  it("refuses a signature from the device that does not verify", async () => {
    const own = freshKey();
    const signer = await ledgerSigner(PATH, device(own, { forge: true }).open);
    await expect(signer.signMessages([signable(envelope([own.bytes]))])).rejects.toThrow(
      new LedgerError(`the Ledger returned a signature that does not verify for ${own.address}; nothing was sent`),
    );
  });
});
