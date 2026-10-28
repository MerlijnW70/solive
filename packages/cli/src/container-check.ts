import { spawn } from "node:child_process";
import type { Check } from "./check-process.js";
import { relayOutput, toStderr } from "./check-output.js";
import { type InterruptSignal, SIGNAL_EXIT } from "./judge-errors.js";
import { quietly, warn } from "./process-reap.js";

export type Docker = { status: number | null; out: string };

export const dockerTimedOut = (seconds: number): string => `docker gave no answer within ${seconds} seconds`;

export function docker(args: readonly string[], env: NodeJS.ProcessEnv, shown = false, timeoutSeconds?: number): Promise<Docker> {
  return new Promise((done) => {
    const client = spawn("docker", args, { env, stdio: ["ignore", shown ? 2 : "pipe", shown ? 2 : "pipe"], windowsHide: true });
    const timer =
      timeoutSeconds === undefined
        ? undefined
        : setTimeout(() => {
            client.kill("SIGKILL");
            done({ status: null, out: dockerTimedOut(timeoutSeconds) });
          }, timeoutSeconds * 1000);
    let out = "";
    for (const stream of [client.stdout, client.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        out += chunk;
      });
    }
    client.once("error", (error) => {
      clearTimeout(timer);
      done({ status: null, out: error.message });
    });
    client.once("close", (status) => {
      clearTimeout(timer);
      done({ status, out: out.trim() });
    });
  });
}

export const containerLeft = (name: string): string => `warning: the check's container ${name} could not be removed; remove it with docker rm -f ${name}`;

export const DOCKER_RUN_FAILED = 125;

export type Ended = { oom: boolean; error: string };

export async function endedState(name: string, env: NodeJS.ProcessEnv): Promise<Ended | null> {
  const inspected = await docker(["container", "inspect", "--format", "{{json .State}}", name], env);
  if (inspected.status !== 0) {
    return null;
  }
  try {
    const state = JSON.parse(inspected.out) as { OOMKilled?: unknown; Error?: unknown };
    return { oom: state.OOMKilled === true, error: typeof state.Error === "string" ? state.Error : "" };
  } catch {
    return null;
  }
}

export const startFailed = (code: number, error: string): string =>
  `docker could not start the check's container (exit ${code}${error === "" ? "" : `: ${error.slice(0, 300)}`})`;

export async function removeContainer(name: string, env: NodeJS.ProcessEnv): Promise<void> {
  await docker(["rm", "-f", "-v", name], env);
  if ((await docker(["container", "inspect", name], env)).status === 0) {
    warn(containerLeft(name));
  }
}

export function runContainer(args: readonly string[], name: string, env: NodeJS.ProcessEnv, timeoutSeconds: number): Promise<Check> {
  return new Promise((done, failed) => {
    const child = spawn("docker", ["run", "--name", name, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    relayOutput([child.stdout, child.stderr], toStderr);
    const kill = async (): Promise<void> => {
      await docker(["kill", name], env);
      await docker(["rm", "-f", "-v", name], env);
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
        const ended = timedOut || interrupted !== undefined ? null : await endedState(name, env);
        await removeContainer(name, env);
        settle();
        const failedToStart = code === DOCKER_RUN_FAILED || (ended !== null && ended.error !== "");
        done({
          exitCode: timedOut || interrupted !== undefined ? null : code,
          timedOut,
          ...(interrupted === undefined ? {} : { interrupted }),
          ...(ended?.oom === true ? { oom: true as const } : {}),
          ...(failedToStart && ended?.oom !== true ? { infra: startFailed(code ?? DOCKER_RUN_FAILED, ended?.error ?? "") } : {}),
        });
      });
    });
  });
}
