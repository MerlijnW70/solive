import type { Address, MessagePartialSigner, TransactionPartialSigner } from "@solana/kit";
import { SdkError } from "@intent-engine/core";

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

const MAX_INDEX = 2 ** 31 - 1;

export class LedgerPathError extends SdkError {
  readonly code = "ledger-path-error";
  override readonly name = "LedgerPathError";
}

export class LedgerError extends SdkError {
  readonly code = "ledger-error";
  override readonly name = "LedgerError";
}

export type LedgerPath = { account?: number; change?: number; derivation: string };

export type LedgerTransport = { close(): Promise<void> };

export type OpenTransport = () => Promise<LedgerTransport>;

export type DeviceSigner = TransactionPartialSigner & MessagePartialSigner & { readonly device: string };

export const isLedgerPath = (text: string): boolean => text.startsWith("usb://");

export const isDevice = (signer: object): signer is DeviceSigner => "device" in signer && typeof signer.device === "string";

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
