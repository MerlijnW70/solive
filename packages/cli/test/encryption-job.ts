import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, getBase64Encoder, getTransactionDecoder, type KeyPairSigner, lamports } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { expect } from "vitest";
import {
  buildCreateProfile,
  buildUpdateProfile,
  EVENT_IX_TAG,
  findAssociatedTokenAddress,
  getIntentDecoder,
  getProfileSetEventEncoder,
  Kind,
  newEncryptionKeyFile,
  parseEncryptionKey,
  type SealRecipient,
} from "@intent-engine/core";
import { createClient, type EngineTransaction, type OpenTransport } from "@intent-engine/client";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK, main } from "../src/main.js";
import { nextSlot } from "./announce.js";
import { creation, funded, h, NOW, runtime, send, transport, type World, world } from "./harness.js";
import { type Device, deviceKey, type Key } from "./ledger-device.js";

const CASES = '{"cases": [{"args": [""], "expected": 0}, {"args": ["one two"], "expected": 2}]}';
const SPEC = `# Count words\n\n\`\`\`judge-cases\n${CASES}\n\`\`\`\n`;
export const COUNT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";
export const LEVELS = [44, 501, 1, 0];
export const PATH = "usb://ledger?key=1/0";
export const KEY_FILE = "judge.enc";
export const NEW_KEY_FILE = "judge-next.enc";
export const ENDPOINT = "https://" + "judge.example";
export const CREATED_SLOT = 4n;
export const WORK_URL = "https://" + "example.org/count.mjs";

export const sha = (text: string) => createHash("sha256").update(text).digest();

export const WORK = sha(COUNT).toString("hex");

export async function run(argv: string[], ledger?: Device | OpenTransport, keys: Record<string, KeyPairSigner> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const open = ledger === undefined ? {} : { ledger: typeof ledger === "function" ? ledger : ledger.open };
  const code = await main(argv, { ...runtime(keys), ...open }, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join("\n"), err: err.join("\n"), json: () => JSON.parse(out.join("\n")) as Record<string, unknown> };
}

export const statusOf = (intent: Address) => {
  const view = h.svm.getAccount(intent);
  return view.exists ? getIntentDecoder().decode(view.data).status : undefined;
};

export const kinds = (ledger: Device) => ledger.signed.map(({ kind }) => kind);

export type Job = { w: World; key: Key; intent: Address; spec: string; artifact: string; dir: string; payer: KeyPairSigner; publicKey: string };

export async function job(attestorOf?: (key: Key) => Promise<Address>): Promise<Job> {
  const w = await world();
  h.watched = [w.owner.address];
  const key = await deviceKey();
  h.svm.airdrop(key.address, lamports(10_000_000_000n));
  const made = await run(["profile", "encryption-key", "new", "--out", KEY_FILE]);
  expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
  const publicKey = String(made.json()["encryption_key"]);
  const attestor = attestorOf === undefined ? key.address : await attestorOf(key);
  const dir = await mkdtemp(join(tmpdir(), "ledger-encryption-"));
  const spec = join(dir, "spec.md");
  const artifact = join(dir, "count.mjs");
  await writeFile(spec, SPEC);
  await writeFile(artifact, COUNT);
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor, specHash: new Uint8Array(sha(SPEC)), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  return { w, key, intent, spec, artifact, dir, payer: await funded(), publicKey };
}

export type Logged = { signature: string; slot: bigint; memos: string[]; feePayer: Address; emitted: Uint8Array[] };

export type Announced = { announcement: Address; seq: bigint; salt: string; sealedTo: SealRecipient[] };

export async function announce(j: Job, worker: KeyPairSigner, work = WORK): Promise<Announced> {
  nextSlot();
  const client = createClient({ url: "http://cluster", transport });
  const input = { worker, intent: j.intent, sha256: work, url: WORK_URL };
  const plan = await client.plan.announce(input);
  const made = await client.announce(input);
  return { announcement: made.announcement, seq: made.seq, salt: made.salt, sealedTo: plan.sealedTo };
}

export const sealedKind = (recipient: SealRecipient): "wallet" | "profile" => (typeof recipient === "string" ? "wallet" : "profile");

export function logged(j: Job, entries: readonly Logged[]): void {
  h.engineLog = [...[...entries].reverse().map((entry) => ({ ...entry, blockTime: null, failed: false })), creation(j.intent, CREATED_SLOT)];
}

export async function publish(j: Job, encryptionKey: string, at: number, update = false): Promise<Logged> {
  const fields = { wallet: j.key.signer, skills: ["judge"], endpoint: ENDPOINT, encryptionKey };
  await send(j.key.signer, [update ? await buildUpdateProfile(fields) : await buildCreateProfile(fields)]);
  return profileEntry(j, encryptionKey, at);
}

export function profileEntry(j: Job, encryptionKey: string, at: number): Logged {
  const event = getProfileSetEventEncoder().encode({ wallet: j.key.address, skills: ["judge"], endpoint: ENDPOINT, docUrl: "", docHash: new Uint8Array(32), encryptionKey: parseEncryptionKey(encryptionKey) });
  return { signature: `profile${at}`, slot: BigInt(4 + at), memos: [], feePayer: j.key.address, emitted: [Uint8Array.from([...EVENT_IX_TAG, ...event])] };
}

export async function keyedProfile(key: Key, file?: string): Promise<{ entry: EngineTransaction; encryptionKey: Uint8Array }> {
  const { text, publicKey } = await newEncryptionKeyFile();
  if (file !== undefined) {
    h.files.set(file, text);
  }
  await send(key.signer, [await buildCreateProfile({ wallet: key.signer, skills: ["judge"], endpoint: ENDPOINT, encryptionKey: publicKey })]);
  const event = getProfileSetEventEncoder().encode({ wallet: key.address, skills: ["judge"], endpoint: ENDPOINT, docUrl: "", docHash: new Uint8Array(32), encryptionKey: parseEncryptionKey(publicKey) });
  const entry: EngineTransaction = { signature: `profile-${key.address}`, slot: 0n, blockTime: null, failed: false, memos: [], feePayer: key.address, emitted: [Uint8Array.from([...EVENT_IX_TAG, ...event])] };
  return { entry, encryptionKey: parseEncryptionKey(publicKey) };
}

export const lastWireSigners = (): string[] => {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(h.wires.at(-1) ?? ""));
  return Object.entries(tx.signatures).flatMap(([signer, signature]) => (signature === null || signature === undefined ? [] : [signer]));
};

export const judging = (j: Job, ...more: string[]) => [
  "judge", "--keypair", PATH, "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--artifact", j.artifact, "--sandbox", "viper", "--fee-payer", "payer.json", ...more,
];

export const payeeOf = (j: Job, worker: Address) => findAssociatedTokenAddress({ owner: worker, mint: j.w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });

export async function served(ledger: Device, args: string[], keys: Record<string, KeyPairSigner> = {}): Promise<Client> {
  h.served.length = 0;
  const err: string[] = [];
  const code = await main(["mcp", "--url", "devnet", "--wallet", "--all-tools", ...args], { ...runtime(keys), ledger: ledger.open }, { out: () => undefined, err: (t) => err.push(t) });
  expect([code, err.join("\n")]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

export async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Record<string, unknown> };
}
