import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  type Address,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getPublicKeyFromAddress,
  type MessagePartialSigner,
  type SignatureBytes,
  type SignatureDictionary,
  type TransactionPartialSigner,
  verifySignature,
} from "@solana/kit";
import { COSIGN_KEYS_AT, MAX_COSIGNERS, OFFCHAIN_PREFIX } from "@intent-engine/core";

export const LEDGER_FORMS = ["usb://ledger", "usb://ledger?key=<account>", "usb://ledger?key=<account>/<change>"];

export const LEDGER_ERRORS = {
  notFound: "no Ledger was found: plug it in, unlock it, open the Solana app and run the command again; nothing was sent",
  locked: "the Ledger is locked: unlock it with its PIN, open the Solana app and run the command again; nothing was sent",
  noApp: "the Solana app is not open on the Ledger: open it and run the command again; nothing was sent",
  blindSigning: "blind signing is disabled in the Ledger's Solana app: enable it in the app's settings, since Squads instructions need it, and run the command again; nothing was sent",
  rejected: "signing was rejected on the Ledger; nothing was sent",
  missing: "signing with a Ledger needs @ledgerhq/hw-app-solana@7.12.0 and @ledgerhq/hw-transport-node-hid-noevents@6.36.0, which are not installed: install both where intent-engine is installed and run the command again; nothing was sent",
  driver: "the USB driver node-hid is not built in this checkout: build it as docs/maintainers/operations.md shows under Signing with a Ledger and run the command again; nothing was sent",
} as const;

const LOCKED = new Set([0x5515, 0x6982]);
const NO_APP = new Set([0x6e00, 0x6e01, 0x6d00, 0x6d02, 0x6511, 0x650f]);
const REJECTED = 0x6985;
const BLIND_SIGNING = 0x6808;
const MAX_INDEX = 2 ** 31 - 1;
const ADDRESS_BYTES = 32;
const SIGNATURE_BYTES = 64;

export class LedgerPathError extends Error {}

export class LedgerError extends Error {}

export type LedgerPath = { account?: number; change?: number; derivation: string };

export type LedgerTransport = { close(): Promise<void> };

export type OpenTransport = () => Promise<LedgerTransport>;

export type DeviceSigner = TransactionPartialSigner & MessagePartialSigner & { readonly device: string };

type App = {
  getAppConfiguration(): Promise<{ blindSigningEnabled: boolean }>;
  getAddress(path: string): Promise<{ address: Uint8Array }>;
  signTransaction(path: string, message: Buffer): Promise<{ signature: Uint8Array }>;
  signOffchainMessage(path: string, message: Buffer): Promise<{ signature: Uint8Array }>;
};

const required = createRequire(import.meta.url);

export function ledgerModule(name: string, resolve: (name: string) => unknown = required): unknown {
  try {
    return resolve(name);
  } catch (error) {
    if ((error as { code?: unknown }).code === "MODULE_NOT_FOUND") {
      throw new LedgerError(LEDGER_ERRORS.missing);
    }
    throw error;
  }
}

const load = (name: string): unknown => ledgerModule(name);

export const isLedgerPath = (text: string): boolean => text.startsWith("usb://");

export const isDevice = (signer: object): signer is DeviceSigner => "device" in signer && typeof signer.device === "string";

export const messageHash = (message: Uint8Array): string => getBase58Decoder().decode(createHash("sha256").update(message).digest());

export const ENVELOPE_DIGEST_CHARS = 64;

export const envelopeDigest = (envelope: Uint8Array): string => new TextDecoder().decode(envelope.subarray(envelope.length - ENVELOPE_DIGEST_CHARS));

export const MESSAGE_ONLY =
  "this Ledger signs only the release message here, never a transaction, so a host cannot add an instruction to what it signs; a fee-payer key signs and pays the transaction; nothing was sent";

export function messageOnly<S extends MessagePartialSigner & { readonly address: Address }>(signer: S): S & TransactionPartialSigner {
  return Object.freeze({
    ...signer,
    signTransactions: async () => {
      throw new LedgerError(MESSAGE_ONLY);
    },
  });
}

function index(text: string | undefined, path: string): number | undefined {
  if (text === undefined) {
    return undefined;
  }
  const value = Number(text);
  if (value > MAX_INDEX) {
    throw new LedgerPathError(`${path} names an index above ${MAX_INDEX}; use ${LEDGER_FORMS.join(", ")}`);
  }
  return value;
}

export function parseLedgerPath(text: string): LedgerPath {
  const match = /^usb:\/\/ledger(?:\?key=(0|[1-9]\d{0,9})(?:\/(0|[1-9]\d{0,9}))?)?$/.exec(text);
  if (match === null) {
    throw new LedgerPathError(`${text} is not a Ledger path; use ${LEDGER_FORMS.join(", ")}`);
  }
  const account = index(match[1], text);
  const change = index(match[2], text);
  const levels = ["44'", "501'", ...[account, change].filter((n) => n !== undefined).map((n) => `${n}'`)];
  return { ...(account === undefined ? {} : { account }), ...(change === undefined ? {} : { change }), derivation: levels.join("/") };
}

export const openUsb: OpenTransport = async () => {
  const hid = load("@ledgerhq/hw-transport-node-hid-noevents") as { default: { open(path: string): Promise<LedgerTransport> } };
  return hid.default.open("");
};

const appOn = (transport: LedgerTransport): App => {
  const Solana = (load("@ledgerhq/hw-app-solana") as { default: new (transport: LedgerTransport) => App }).default;
  return new Solana(transport);
};

const detail = (error: unknown): { status?: number; id?: string; message: string } => {
  const found = (error ?? {}) as { statusCode?: unknown; id?: unknown; message?: unknown };
  return {
    ...(typeof found.statusCode === "number" ? { status: found.statusCode } : {}),
    ...(typeof found.id === "string" ? { id: found.id } : {}),
    message: typeof found.message === "string" ? found.message : String(error),
  };
};

export function plainLedgerError(error: unknown): LedgerError {
  if (error instanceof LedgerError) {
    return error;
  }
  const { status, id, message } = detail(error);
  if (status === REJECTED) {
    return new LedgerError(LEDGER_ERRORS.rejected);
  }
  if (status === BLIND_SIGNING || /blind signature/i.test(message)) {
    return new LedgerError(LEDGER_ERRORS.blindSigning);
  }
  if (status !== undefined && LOCKED.has(status)) {
    return new LedgerError(LEDGER_ERRORS.locked);
  }
  if (status !== undefined && NO_APP.has(status)) {
    return new LedgerError(LEDGER_ERRORS.noApp);
  }
  if (/bindings file|HID_hidraw|HID\.node/.test(message)) {
    return new LedgerError(LEDGER_ERRORS.driver);
  }
  if (id === "NoDevice" || /no ?device|could not open|cannot open device/i.test(message)) {
    return new LedgerError(LEDGER_ERRORS.notFound);
  }
  if (status !== undefined) {
    return new LedgerError(`the Ledger answered with status 0x${status.toString(16).padStart(4, "0")}; nothing was sent`);
  }
  return new LedgerError(`the Ledger could not be used: ${message}; nothing was sent`);
}

async function session<T>(open: OpenTransport, use: (app: App) => Promise<T>): Promise<T> {
  let transport: LedgerTransport;
  try {
    transport = await open();
  } catch (error) {
    throw plainLedgerError(error);
  }
  try {
    return await use(appOn(transport));
  } catch (error) {
    throw plainLedgerError(error);
  } finally {
    await transport.close().catch(() => undefined);
  }
}

async function signed(signer: Address, signature: Uint8Array, message: Uint8Array): Promise<SignatureBytes> {
  const bytes = new Uint8Array(signature);
  const valid = bytes.length === SIGNATURE_BYTES && (await verifySignature(await getPublicKeyFromAddress(signer), bytes as SignatureBytes, message));
  if (!valid) {
    throw new LedgerError(`the Ledger returned a signature that does not verify for ${signer}; nothing was sent`);
  }
  return bytes as SignatureBytes;
}

export const notOwnEnvelope = (signer: Address) =>
  `the Ledger signs only an off-chain message whose signers, sorted and each once, include its own key ${signer}, and this message does not; nothing was sent`;

const isHex = (b: number) => (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66);

function ownEnvelope(signer: Address, message: Uint8Array): boolean {
  const key = getAddressEncoder().encode(signer);
  const head = OFFCHAIN_PREFIX.length;
  const count = message[head + 1] ?? 0;
  const keys = Array.from({ length: count }, (_, i) => message.subarray(COSIGN_KEYS_AT + 32 * i, COSIGN_KEYS_AT + 32 * (i + 1)));
  const before = (a: Uint8Array, b: Uint8Array) => {
    const at = a.findIndex((x, i) => x !== b[i]);
    return at >= 0 && (a[at] ?? 0) < (b[at] ?? 0);
  };
  return (
    count >= 1 &&
    count <= MAX_COSIGNERS &&
    message.length === COSIGN_KEYS_AT + 32 * count + 64 &&
    OFFCHAIN_PREFIX.every((b, i) => message[i] === b) &&
    message[head] === 1 &&
    keys.every((k, i) => i === 0 || before(keys[i - 1] ?? k, k)) &&
    keys.some((k) => k.every((b, i) => b === key[i])) &&
    message.subarray(COSIGN_KEYS_AT + 32 * count).every(isHex)
  );
}

export async function ledgerSigner(text: string, open: OpenTransport = openUsb): Promise<DeviceSigner> {
  const { derivation } = parseLedgerPath(text);
  const key = await session(open, async (app) => {
    await app.getAppConfiguration();
    return new Uint8Array((await app.getAddress(derivation)).address);
  });
  if (key.length !== ADDRESS_BYTES) {
    throw new LedgerError(`the Ledger returned no ${ADDRESS_BYTES} byte address for ${text}; nothing was sent`);
  }
  const address = getAddressDecoder().decode(key);
  const signer: DeviceSigner = {
    address,
    device: text,
    signTransactions: async (transactions) => {
      const out: SignatureDictionary[] = [];
      for (const transaction of transactions) {
        const message = new Uint8Array(transaction.messageBytes);
        const signature = await session(open, async (app) => {
          if (!(await app.getAppConfiguration()).blindSigningEnabled) {
            throw new LedgerError(LEDGER_ERRORS.blindSigning);
          }
          return (await app.signTransaction(derivation, Buffer.from(message))).signature;
        });
        out.push(Object.freeze({ [address]: await signed(address, signature, message) }));
      }
      return out;
    },
    signMessages: async (messages) => {
      const out: SignatureDictionary[] = [];
      for (const { content } of messages) {
        const message = new Uint8Array(content);
        if (!ownEnvelope(address, message)) {
          throw new LedgerError(notOwnEnvelope(address));
        }
        const signature = await session(open, async (app) => (await app.signOffchainMessage(derivation, Buffer.from(message))).signature);
        out.push(Object.freeze({ [address]: await signed(address, signature, message) }));
      }
      return out;
    },
  };
  return Object.freeze(signer);
}
