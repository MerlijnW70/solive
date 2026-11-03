import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";

export const KEY_FILE_BYTES = 64;

export type KeyFile = { file: string; bytes: Uint8Array } | { file: string; problem: "unreadable" | "exposed" | "not-a-keypair" };

function expandHome(path: string, home: string): string {
  if (path === "~") {
    return home;
  }
  return /^~[\\/]/.test(path) ? `${home}${path.slice(1)}` : path;
}

const isKeyBytes = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length === KEY_FILE_BYTES && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);

export async function readKeyFile(path: string, platform: string = process.platform, home: string = homedir()): Promise<KeyFile> {
  const file = expandHome(path, home);
  let mode: number;
  let text: string;
  try {
    mode = (await stat(file)).mode;
    text = await readFile(file, "utf8");
  } catch {
    return { file, problem: "unreadable" };
  }
  if (platform !== "win32" && (mode & 0o077) !== 0) {
    return { file, problem: "exposed" };
  }
  let bytes: unknown;
  try {
    bytes = JSON.parse(text);
  } catch {
    return { file, problem: "not-a-keypair" };
  }
  return isKeyBytes(bytes) ? { file, bytes: Uint8Array.from(bytes) } : { file, problem: "not-a-keypair" };
}
