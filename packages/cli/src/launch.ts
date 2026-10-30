import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

export type Launched = { code: number; output: string };

export const WINDOWS_NOT_FOUND = 9009;

export const invocation = (program: string, args: readonly string[], platform: string): [string, string[]] =>
  platform === "win32" ? ["cmd.exe", ["/d", "/c", program, ...args]] : [program, [...args]];

export const notFound = (code: number, platform: string): boolean => platform === "win32" && code === WINDOWS_NOT_FOUND;

export const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

const lookupKey = (env: Readonly<Record<string, string | undefined>>, name: string, platform: string): string | undefined =>
  platform === "win32" ? Object.keys(env).find((key) => key.toUpperCase() === name) : name in env ? name : undefined;

const runnable = (file: string, platform: string): boolean => {
  try {
    const info = statSync(file);
    return info.isFile() && (platform === "win32" || (info.mode & 0o111) !== 0);
  } catch {
    return false;
  }
};

export function onPath(program: string, env: Readonly<Record<string, string | undefined>>, platform: string): boolean {
  const pathKey = lookupKey(env, "PATH", platform);
  const dirs = (pathKey === undefined ? "" : (env[pathKey] ?? "")).split(delimiter).filter((dir) => dir !== "");
  const extKey = lookupKey(env, "PATHEXT", platform);
  const extensions =
    platform === "win32"
      ? (extKey === undefined ? DEFAULT_PATHEXT : (env[extKey] ?? DEFAULT_PATHEXT)).split(";").filter((ext) => ext !== "")
      : [];
  const names = platform === "win32" ? extensions.map((ext) => program + ext) : [program];
  return dirs.some((dir) => names.some((name) => runnable(join(dir, name), platform)));
}

export class LaunchTimedOut extends Error {
  constructor(program: string, timeoutMs: number) {
    super(`${program} did not finish within ${timeoutMs / 1000} seconds, so it was stopped`);
    this.name = "LaunchTimedOut";
  }
}

export function launch(program: string, args: readonly string[], platform: string = process.platform, timeoutMs?: number): Promise<Launched | null> {
  const [file, list] = invocation(program, args, platform);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn(file, list, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill();
            reject(new LaunchTimedOut(program, timeoutMs));
          }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        resolve(null);
      } else {
        reject(error);
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const exit = code ?? 1;
      resolve(notFound(exit, platform) ? null : { code: exit, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}
