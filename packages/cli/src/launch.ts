import { spawn } from "node:child_process";

export type Launched = { code: number; output: string };

export const WINDOWS_NOT_FOUND = 9009;

export const invocation = (program: string, args: readonly string[], platform: string): [string, string[]] =>
  platform === "win32" ? ["cmd.exe", ["/d", "/c", program, ...args]] : [program, [...args]];

export const notFound = (code: number, platform: string): boolean => platform === "win32" && code === WINDOWS_NOT_FOUND;

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
