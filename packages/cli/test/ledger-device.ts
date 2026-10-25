import { createPrivateKey, getRandomValues, type KeyObject, sign } from "node:crypto";
import { createRequire } from "node:module";
import { type Address, createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder, getBase58Decoder, type KeyPairSigner } from "@solana/kit";
import type { LedgerTransport, OpenTransport } from "@intent-engine/client/internal";

type Store = { passed: number; queue: [string, string][]; replayExchange(apdu: Buffer): Buffer; ensureQueueEmpty(): void };
type Mocker = {
  RecordStore: new (queue: [string, string][]) => Store;
  openTransportReplayer(store: Store): Promise<LedgerTransport>;
};

const load = createRequire(import.meta.url);
const mocker = load("@ledgerhq/hw-transport-mocker") as Mocker;
export const { TransportError } = load("@ledgerhq/hw-transport/errors") as { TransportError: new (message: string, id: string) => Error };

export const OK = "9000";
export const REJECT = "6985";
export const SIGN = "sign";
export const MESSAGE = "message";
export const CONFIG = "e004000000";
export const BLIND_ON = `0100010309${OK}`;
export const BLIND_OFF = `0000010309${OK}`;
const HARDENED = 0x80000000;
const MORE = 0x02;
const PKCS8_ED25519 = "302e020100300506032b657004220420";
const INSTRUCTIONS: Record<string, number> = { [SIGN]: 0x06, [MESSAGE]: 0x07 };

export const hex = (bytes: Iterable<number>) => Buffer.from([...bytes]).toString("hex");

export const pathBytes = (levels: number[]) => [
  levels.length,
  ...levels.flatMap((n) => {
    const word = (n | HARDENED) >>> 0;
    return [word >>> 24, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff];
  }),
];

export const addressApdu = (levels: number[], key: Address): [string, string] => [
  hex([0xe0, 0x05, 0, 0, pathBytes(levels).length, ...pathBytes(levels)]),
  `${hex(getAddressEncoder().encode(key))}${OK}`,
];

export type Key = { address: Address; secret: KeyObject; signer: KeyPairSigner };

export async function deviceKey(): Promise<Key> {
  const seed = getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const secret = createPrivateKey({ key: Buffer.concat([Buffer.from(PKCS8_ED25519, "hex"), seed]), format: "der", type: "pkcs8" });
  return { address: signer.address, secret, signer };
}

export type Signed = { kind: string; path: number[]; bytes: Uint8Array };

export type Device = { store: Store; opened: number; paths: number[][]; signatures: string[]; signed: Signed[]; open: OpenTransport };

export function device(key: Key, queue: [string, string][], open?: OpenTransport): Device {
  const store = new mocker.RecordStore(queue);
  const made: Device = { store, opened: 0, paths: [], signatures: [], signed: [], open: async () => mocker.openTransportReplayer(store) };
  const replay = store.replayExchange.bind(store);
  let chunks: number[] = [];
  store.replayExchange = (apdu: Buffer) => {
    const kind = store.queue[0]?.[0] ?? "";
    if (INSTRUCTIONS[kind] === undefined || apdu[1] !== INSTRUCTIONS[kind]) {
      return replay(apdu);
    }
    chunks.push(...apdu.subarray(5));
    if (((apdu[3] ?? 0) & MORE) !== 0) {
      return Buffer.from(OK, "hex");
    }
    const payload = Buffer.from(chunks);
    chunks = [];
    const [, answer] = store.queue.shift() ?? [kind, OK];
    store.passed += 1;
    const depth = payload[1] ?? 0;
    const path = Array.from({ length: depth }, (_, i) => (payload.readUInt32BE(2 + 4 * i) & ~HARDENED) >>> 0);
    const bytes = new Uint8Array(payload.subarray(2 + 4 * depth));
    made.paths.push(path);
    made.signed.push({ kind, path, bytes });
    if (answer !== OK) {
      return Buffer.from(answer, "hex");
    }
    const signature = sign(null, bytes, key.secret);
    made.signatures.push(getBase58Decoder().decode(signature));
    return Buffer.from(`${hex(signature)}${OK}`, "hex");
  };
  made.open = async () => {
    made.opened += 1;
    return open === undefined ? mocker.openTransportReplayer(store) : open();
  };
  return made;
}

export const signing = (levels: number[], key: Key, answers: string[] = [OK]): [string, string][] => [
  [CONFIG, BLIND_ON],
  addressApdu(levels, key.address),
  ...answers.flatMap((answer): [string, string][] => [
    [CONFIG, BLIND_ON],
    [SIGN, answer],
  ]),
];

export const found = (levels: number[], key: Key): [string, string][] => [[CONFIG, BLIND_ON], addressApdu(levels, key.address)];

export const messageThen = (answer = OK): [string, string][] => [[MESSAGE, answer]];

export const transactionThen = (answer = OK): [string, string][] => [
  [CONFIG, BLIND_ON],
  [SIGN, answer],
];
