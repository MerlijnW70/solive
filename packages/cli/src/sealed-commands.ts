import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { Address } from "@solana/kit";
import { NotInvited, seal, sealedTo, SealedError, unseal } from "@intent-engine/core";
import { createClient, SpecSealed, type Transport } from "@intent-engine/client";
import type { Command } from "./command-types.js";
import { FlowRefused } from "./flows.js";
import type { Runtime } from "./runtime.js";

type Sealing = Extract<Command, { name: "seal" | "unseal" }>;
type Reading = Extract<Command, { name: "spec" }>;

export const MAX_SEALED_INPUT = 67_108_864;

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
    const sealed = await seal(input, command.to);
    await writeFile(command.out, sealed, { flag: "wx" });
    return { out: command.out, sha256: sha256(input), sealed_sha256: sha256(sealed), to: sealedTo(sealed) };
  }
  const keypair = await runtime.loadKeypair(command.keypair);
  let plain: Uint8Array;
  try {
    plain = await unseal(input, keypair);
  } catch (error) {
    throw error instanceof SealedError ? new FlowRefused(error instanceof NotInvited ? `${error.message}; nothing was written` : `${command.file}: ${error.message}`) : error;
  }
  await writeFile(command.out, plain, { flag: "wx" });
  return { out: command.out, sha256: sha256(plain) };
}

export async function readJobSpec(command: Reading, runtime: Runtime, transport: Transport): Promise<object> {
  const client = createClient({ url: command.url, transport });
  const keypair = command.keypair === undefined ? undefined : await runtime.loadKeypair(command.keypair);
  let spec;
  try {
    spec = await client.spec(command.intent, keypair);
  } catch (error) {
    throw error instanceof SpecSealed ? new FlowRefused(error.message) : error;
  }
  if (spec === null) {
    throw new FlowRefused(`the escrow ${command.intent} publishes no spec url, or is not a proof escrow; ask its owner for the spec`);
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
