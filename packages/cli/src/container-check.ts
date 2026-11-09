import { spawn } from "node:child_process";
import type { Check } from "./check-process.js";
import { relayOutput, toStderr } from "./check-output.js";
import { type InterruptSignal, SIGNAL_EXIT } from "./judge-errors.js";
import { quietly, warn } from "./process-reap.js";
import { type ContainerFacts, type ContainerState } from "./verdict-model.js";

export { startFailed } from "./verdict-model.js";

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

export const INSPECT_SECONDS = 30;

export const STATUS_POLL_MS = 100;

const NEVER = "0001-01-01T00:00:00Z";

export type Inspected = { state: ContainerState } | { state: null; problem: string };

export async function endedState(name: string, env: NodeJS.ProcessEnv, timeoutSeconds: number = INSPECT_SECONDS): Promise<Inspected> {
  const inspected = await docker(["container", "inspect", "--format", "{{json .State}}", name], env, false, timeoutSeconds);
  if (inspected.status !== 0) {
    return { state: null, problem: inspected.out.slice(0, 300) };
  }
  let state: Record<string, unknown>;
  try {
    const parsed = JSON.parse(inspected.out) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { state: null, problem: "its state is not a JSON object" };
    }
    state = parsed as Record<string, unknown>;
  } catch {
    return { state: null, problem: "its state is not JSON" };
  }
  const { ExitCode: exitCode, OOMKilled: oomKilled, Error: error, StartedAt: startedAt, Running: running } = state;
  if (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode) || (oomKilled !== undefined && typeof oomKilled !== "boolean") || typeof error !== "string" || typeof startedAt !== "string" || running !== false) {
    return { state: null, problem: "its state lacks an ended container's exit code, error or start time, or has an out-of-memory flag that is not true or false" };
  }
  return { state: { started: startedAt !== "" && startedAt !== NEVER, exitCode, oomKilled: oomKilled === true, error } };
}

export const MEMORY_EVENTS = "/sys/fs/cgroup/memory.events";

export const MEMORY_PROCS = "/sys/fs/cgroup/cgroup.procs";

export const CPU_STAT = "/sys/fs/cgroup/cpu.stat";

export const CPU_MAX = "/sys/fs/cgroup/cpu.max";

export const MEMORY_STAT = "/sys/fs/cgroup/memory.stat";

export async function removeContainer(name: string, env: NodeJS.ProcessEnv): Promise<void> {
  await docker(["rm", "-f", "-v", name], env);
  if ((await docker(["container", "inspect", name], env)).status === 0) {
    warn(containerLeft(name));
  }
}

export type ContainerRun = Check & ContainerFacts;

type Seen = { asked: number; answered: number; status: string | undefined };

type PinWatch = { overran(): boolean; ranAtMostMs(endedAt: number): number; stop(): void };

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms).unref());

function watchPin(name: string, env: NodeJS.ProcessEnv, seconds: number, inspectSeconds: number, overrun: () => void): PinWatch {
  let notBefore = performance.now();
  let overran = false;
  let ended = false;
  let timer: NodeJS.Timeout | undefined;
  const ask = async (): Promise<Seen> => {
    const asked = performance.now();
    const read = await docker(["container", "inspect", "--format", "{{.State.Status}}", name], env, false, inspectSeconds);
    return { asked, answered: performance.now(), status: read.status === 0 ? read.out.trim() : undefined };
  };
  const recheck = async (startedBy: number): Promise<void> => {
    const seen = await ask();
    if (ended || seen.status !== "running") {
      return;
    }
    if (seen.asked >= startedBy + seconds * 1000) {
      overran = true;
      overrun();
      return;
    }
    timer = setTimeout(() => void recheck(startedBy), Math.max(1, startedBy + seconds * 1000 - performance.now()));
  };
  const poll = async (): Promise<void> => {
    while (!ended) {
      const seen = await ask();
      if (ended) {
        return;
      }
      if (seen.status === "running") {
        timer = setTimeout(() => void recheck(seen.answered), Math.max(0, seen.answered + seconds * 1000 - performance.now()));
        return;
      }
      if (seen.status === "created") {
        notBefore = seen.asked;
      } else if (seen.status !== undefined) {
        return;
      }
      await pause(STATUS_POLL_MS);
    }
  };
  void poll();
  return {
    overran: () => overran,
    ranAtMostMs: (endedAt) => endedAt - notBefore,
    stop: () => {
      ended = true;
      clearTimeout(timer);
    },
  };
}

export function runContainer(
  args: readonly string[],
  name: string,
  env: NodeJS.ProcessEnv,
  timeoutSeconds: number,
  inspectSeconds: number = INSPECT_SECONDS,
  pinnedSeconds?: number,
): Promise<ContainerRun> {
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
    const pin = pinnedSeconds === undefined ? undefined : watchPin(name, env, pinnedSeconds, inspectSeconds, () => (killing = kill()));
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
      pin?.stop();
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
    child.once("exit", () => {
      clearTimeout(timer);
      const endedAt = performance.now();
      pin?.stop();
      void killing.finally(async () => {
        const overran = pin?.overran() === true;
        const stopped = timedOut || interrupted !== undefined || overran;
        const inspected: Inspected = stopped ? { state: null, problem: "" } : await endedState(name, env, inspectSeconds);
        await removeContainer(name, env);
        settle();
        done({
          exitCode: stopped || inspected.state === null ? null : inspected.state.exitCode,
          timedOut,
          deadline: timedOut,
          state: inspected.state,
          ...(interrupted === undefined ? {} : { interrupted }),
          ...(inspected.state === null && !stopped ? { inspect: inspected.problem } : {}),
          ...(pin === undefined ? {} : { overran, ranAtMostMs: pin.ranAtMostMs(endedAt) }),
        });
      });
    });
  });
}
