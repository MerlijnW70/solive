import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { Address } from "@solana/kit";
import { type DeliveryKey } from "@intent-engine/core";
import { newEncryptionKeyFile, readEncryptionKeyFile, seal, sealedTo, unseal } from "@intent-engine/core/internal";
import { isSdkError, SpecUnreadable, type Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { MAX_SPEC_BYTES, sealRecipients } from "@intent-engine/client/internal";
import { tool } from "./agent/names.js";
import type { Command } from "./command-types.js";
import { FlowRefused } from "./flows.js";
import type { Runtime } from "./runtime.js";

type Sealing = Extract<Command, { name: "seal" | "unseal" }>;
type Reading = Extract<Command, { name: "spec" }>;

export const encryptionKeyLines = (key: string | null, removed: boolean): string[] =>
  key !== null ? [`Encryption key: ${key}; deliveries are sealed to it`] : removed ? ["Encryption key: none; deliveries are sealed to the key derived from the wallet"] : [];

export const encryptionKeyNext = (publicKey: string): string =>
  `publish the public key with profile set --encryption-key ${publicKey}, then judge with --encryption-keypair naming this file; it only decrypts and never signs`;

export async function newEncryptionKey(out: string, runtime: Runtime): Promise<object> {
  const { text, publicKey } = await newEncryptionKeyFile();
  await runtime.saveText(out, text, true);
  return { out, encryption_key: publicKey, next: encryptionKeyNext(publicKey) };
}

export async function loadEncryptionKeys(runtime: Runtime, paths: readonly string[] = []): Promise<DeliveryKey[]> {
  return Promise.all(paths.map((path) => loadEncryptionKey(runtime, path)));
}

export async function loadEncryptionKey(runtime: Runtime, path: string): Promise<DeliveryKey> {
  try {
    return await readEncryptionKeyFile(await runtime.readText(path));
  } catch (error) {
    throw isSdkError(error, "encryption-key-error") ? new FlowRefused(`--encryption-keypair ${path}: ${error.message}`) : error;
  }
}

export const MAX_SEALED_INPUT = 67_108_864;

export const sealedOverLimit = (bytes: number): string =>
  `the sealed file is ${bytes} bytes, over the ${MAX_SPEC_BYTES} bytes ${tool("get_spec")} reads, so it cannot open it; shorten it, or have readers use intent-engine unseal`;

export const jobClosed = (intent: Address): string => `the job ${intent} is closed: it was paid, cancelled or expired, or never existed`;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function bounded(path: string): Promise<Uint8Array> {
  const bytes = new Uint8Array(await readFile(path));
  if (bytes.length > MAX_SEALED_INPUT) {
    throw new FlowRefused(`${path} is larger than ${MAX_SEALED_INPUT} bytes`);
  }
  return bytes;
}

export async function sealing(command: Sealing, runtime: Runtime): Promise<object> {
  const input = await bounded(command.file);
  if (command.name === "seal") {
    let sealed: Uint8Array;
    try {
      sealed = await seal(input, await sealRecipients(runtime.transport(command.url), command.to));
    } catch (error) {
      throw isSdkError(error, "sealed-error") ? new FlowRefused(`${error.message}; nothing was written`) : error;
    }
    await writeFile(command.out, sealed, { flag: "wx" });
    const over = sealed.length > MAX_SPEC_BYTES ? { warnings: [sealedOverLimit(sealed.length)] } : {};
    return { out: command.out, sha256: sha256(input), sealed_sha256: sha256(sealed), to: sealedTo(sealed), ...over };
  }
  const openers = [
    ...(command.keypair === undefined ? [] : [await runtime.loadKeypair(command.keypair)]),
    ...(await loadEncryptionKeys(runtime, command.encryptionKeypairs)),
  ];
  let plain: Uint8Array;
  try {
    plain = await unseal(input, openers);
  } catch (error) {
    if (isSdkError(error, "not-invited")) {
      throw new FlowRefused(`${error.message}; nothing was written`);
    }
    throw isSdkError(error, "sealed-error") ? new FlowRefused(`${command.file}: ${error.message}`) : error;
  }
  await writeFile(command.out, plain, { flag: "wx" });
  return { out: command.out, sha256: sha256(plain) };
}

export async function readJobSpec(command: Reading, runtime: Runtime, transport: Transport): Promise<object> {
  const fetch = (url: string, init: { redirect: "error"; signal: AbortSignal }) =>
    runtime.specFetch(url, init).catch(() => {
      throw new SpecUnreadable(url, "could not be fetched");
    });
  const client = createClient({ url: command.url, transport, fetch });
  const keypair = command.keypair === undefined ? undefined : await runtime.loadKeypair(command.keypair);
  let spec;
  try {
    spec = await client.spec(command.intent, keypair);
  } catch (error) {
    throw isSdkError(error, "spec-sealed") || isSdkError(error, "spec-unreadable") ? new FlowRefused(error.message) : error;
  }
  if (spec === null) {
    throw new FlowRefused((await transport.getAccount(command.intent)) === null ? jobClosed(command.intent) : `the escrow ${command.intent} publishes no spec url, or is not a proof escrow; ask its owner for the spec`);
  }
  if (command.out !== undefined) {
    await writeFile(command.out, spec.text, { flag: "wx" });
  }
  const sealed: Address[] | undefined = spec.sealedTo;
  return {
    url: spec.url,
    sha256: spec.sha256,
    matches: spec.matches,
    ...(sealed === undefined ? {} : { sealed_to: sealed }),
    ...(command.out === undefined ? { text: spec.text } : { out: command.out }),
  };
}
