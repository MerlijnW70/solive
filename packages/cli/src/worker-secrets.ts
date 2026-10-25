import { type Address, isAddress, isMessagePartialSigner, type TransactionPartialSigner } from "@solana/kit";
import { isSha256Hex } from "@intent-engine/core/internal";
import { isDevice, SECRET_BYTES } from "@intent-engine/client/internal";
import { FlowRefused } from "./flows.js";
import { settingsDir } from "./wallet.js";

export type WorkerSecret = { worker: Address; intent: Address; sha256: string; url: string; secret: Uint8Array };

export type SecretFiles = {
  home: string;
  readText(path: string): Promise<string>;
  saveText(path: string, text: string, secret: boolean): Promise<void>;
};

const SECRET_HEX = /^[0-9a-f]{64}$/;

export const secretsPath = (home: string, worker: Address, intent: Address, sha256: string): string =>
  `${settingsDir(home)}/secrets/${worker}-${intent}-${sha256}.json`;

export const signsMessages = (signer: TransactionPartialSigner): boolean => isMessagePartialSigner(signer) && !isDevice(signer);

export const secretBroken = (path: string): string => `${path} is not a delivery secrets file this CLI wrote; move it away to announce again; nothing was sent`;

export const otherUrl = (path: string, url: string): string =>
  `this work was announced from this machine with the url ${url}, whose secret ${path} keeps; deliver it again with that url; nothing was sent`;

export const noSecret = (path: string): string =>
  `${path} does not exist: the worker signs on a device that cannot sign messages, so its delivery secrets live only in the file deliver wrote; refute from the machine that announced; nothing was sent`;

function parsed(text: string, path: string): WorkerSecret {
  let held: Partial<Record<keyof WorkerSecret, unknown>>;
  try {
    held = JSON.parse(text) as Partial<Record<keyof WorkerSecret, unknown>>;
  } catch {
    throw new FlowRefused(secretBroken(path));
  }
  const { worker, intent, sha256, url, secret } = held;
  if (
    typeof worker !== "string" ||
    !isAddress(worker) ||
    typeof intent !== "string" ||
    !isAddress(intent) ||
    typeof sha256 !== "string" ||
    !isSha256Hex(sha256) ||
    typeof url !== "string" ||
    typeof secret !== "string" ||
    !SECRET_HEX.test(secret)
  ) {
    throw new FlowRefused(secretBroken(path));
  }
  return { worker, intent, sha256, url, secret: Uint8Array.from(Buffer.from(secret, "hex")) };
}

export async function savedSecret(files: SecretFiles, worker: Address, intent: Address, sha256: string): Promise<WorkerSecret | null> {
  const path = secretsPath(files.home, worker, intent, sha256);
  let text: string;
  try {
    text = await files.readText(path);
  } catch {
    return null;
  }
  const found = parsed(text, path);
  if (found.worker !== worker || found.intent !== intent || found.sha256 !== sha256) {
    throw new FlowRefused(secretBroken(path));
  }
  return found;
}

export async function secretFor(files: SecretFiles, worker: Address, intent: Address, sha256: string, url: string): Promise<WorkerSecret> {
  const path = secretsPath(files.home, worker, intent, sha256);
  const found = await savedSecret(files, worker, intent, sha256);
  if (found !== null) {
    if (found.url !== url) {
      throw new FlowRefused(otherUrl(path, found.url));
    }
    return found;
  }
  const secret = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  const text = `${JSON.stringify({ worker, intent, sha256, url, secret: Buffer.from(secret).toString("hex") }, null, 2)}\n`;
  await files.saveText(path, text, true);
  return { worker, intent, sha256, url, secret };
}

export async function keptSecret(files: SecretFiles, worker: Address, intent: Address, sha256: string): Promise<WorkerSecret> {
  const found = await savedSecret(files, worker, intent, sha256);
  if (found === null) {
    throw new FlowRefused(noSecret(secretsPath(files.home, worker, intent, sha256)));
  }
  return found;
}
