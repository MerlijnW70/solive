import { spawn } from "node:child_process";
import type { Check } from "./check-process.js";
import { type InterruptSignal, SIGNAL_EXIT } from "./judge-errors.js";
import { quietly, warn } from "./process-reap.js";

export type Docker = { status: number | null; out: string };

export function docker(args: readonly string[], env: NodeJS.ProcessEnv, shown = false): Promise<Docker> {
  return new Promise((done) => {
    const client = spawn("docker", args, { env, stdio: ["ignore", shown ? 2 : "pipe", shown ? 2 : "pipe"], windowsHide: true });
    let out = "";
    for (const stream of [client.stdout, client.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        out += chunk;
      });
    }
    client.once("error", (error) => done({ status: null, out: error.message }));
    client.once("close", (status) => done({ status, out: out.trim() }));
  });
}

export const containerLeft = (name: string): string => `warning: the check's container ${name} could not be removed; remove it with docker rm -f ${name}`;

export async function removeContainer(name: string, env: NodeJS.ProcessEnv): Promise<void> {
  await docker(["rm", "-f", name], env);
  if ((await docker(["container", "inspect", name], env)).status === 0) {
    warn(containerLeft(name));
  }
}

export function runContainer(args: readonly string[], name: string, env: NodeJS.ProcessEnv, timeoutSeconds: number): Promise<Check> {
  return new Promise((done, failed) => {
    const child = spawn("docker", ["run", "--name", name, ...args], {
      env,
      stdio: ["ignore", 2, 2],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const kill = async (): Promise<void> => {
      await docker(["kill", name], env);
      await docker(["rm", "-f", name], env);
      if (child.pid !== undefined && child.exitCode === null) {
        quietly(child.pid);
      }
    };
    let timedOut = false;
    let interrupted: InterruptSignal | undefined;
    let killing: Promise<void> = Promise.resolve();
    const handlers = (Object.keys(SIGNAL_EXIT) as InterruptSignal[]).map((signal) => {
      const handler = () => {
        interrupted ??= signal;
        killing = kill();
      };
      process.on(signal, handler);
      return [signal, handler] as const;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killing = kill();
    }, timeoutSeconds * 1000);
    const settle = () => {
      clearTimeout(timer);
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler);
      }
    };
    child.once("error", (error) => {
      void killing.finally(async () => {
        await removeContainer(name, env);
        settle();
        failed(error);
      });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      void killing.finally(async () => {
        await removeContainer(name, env);
        settle();
        done({
          exitCode: timedOut || interrupted !== undefined ? null : code,
          timedOut,
          ...(interrupted === undefined ? {} : { interrupted }),
        });
      });
    });
  });
}
