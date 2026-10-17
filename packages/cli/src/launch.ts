import { spawn } from "node:child_process";

export type Launched = { code: number; output: string };

export const WINDOWS_NOT_FOUND = 9009;

export const invocation = (program: string, args: readonly string[], platform: string): [string, string[]] =>
  platform === "win32" ? ["cmd.exe", ["/d", "/c", program, ...args]] : [program, [...args]];

export const notFound = (code: number, platform: string): boolean => platform === "win32" && code === WINDOWS_NOT_FOUND;

export function launch(program: string, args: readonly string[], platform: string = process.platform): Promise<Launched | null> {
  const [file, list] = invocation(program, args, platform);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn(file, list, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? resolve(null) : reject(error)));
    child.once("close", (code) => {
      const exit = code ?? 1;
      resolve(notFound(exit, platform) ? null : { code: exit, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}
