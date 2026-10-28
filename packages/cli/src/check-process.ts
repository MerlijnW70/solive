import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { relayOutput, toStderr } from "./check-output.js";
import { type InterruptSignal, SIGNAL_EXIT } from "./judge-errors.js";
import { claim, processTable, statOf } from "./process-table.js";
import { sweep, taskkill, type Watch } from "./process-reap.js";

export { containerLeft, type Docker, docker, removeContainer, runContainer } from "./container-check.js";
export { leftRunning, stillRunning } from "./process-reap.js";
export { claim, type Recorded, type Running } from "./process-table.js";

export const ENV_SPEC_PATH = "SPEC_PATH";
export const ENV_ARTIFACT_PATH = "ARTIFACT_PATH";
export const ENV_ARTIFACT_SHA256 = "ARTIFACT_SHA256";

const SCAN_MS = 250;

export const CHECK_ENV = ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "TERM"] as const;

export type Check = { exitCode: number | null; timedOut: boolean; interrupted?: InterruptSignal; escaped?: number[]; oom?: true; infra?: string };

export type CheckOptions = { cwd?: string };

export function runCheck(command: string, env: NodeJS.ProcessEnv, timeoutSeconds: number, options: CheckOptions = {}): Promise<Check> {
  return new Promise((done, failed) => {
    const child = spawn(command, {
      shell: true,
      env,
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    relayOutput([child.stdout, child.stderr], toStderr);
    const windows = process.platform === "win32";
    const seed = child.pid === undefined || windows ? null : statOf(child.pid);
    const watch: Watch = {
      pid: child.pid ?? 0,
      started: seed?.started ?? null,
      recorded: {
        started: new Map(seed === null ? [] : [[seed.pid, seed.started]]),
        leaders: new Map(seed === null || seed.pid !== seed.session ? [] : [[seed.pid, seed.started]]),
      },
      alive: true,
      marker: env[ENV_SPEC_PATH] === undefined ? undefined : `${ENV_SPEC_PATH}=${env[ENV_SPEC_PATH]}`,
      cwd: options.cwd === undefined ? undefined : resolve(options.cwd),
    };
    let scanning: Promise<void> = Promise.resolve();
    let scanTimer: NodeJS.Timeout | undefined;
    const scan = () => {
      scanning = processTable().then((table) => {
        if (table !== null && watch.alive) {
          claim(table, watch.recorded);
        }
      });
      void scanning.finally(() => {
        if (watch.alive) {
          scanTimer = setTimeout(scan, SCAN_MS);
          scanTimer.unref();
        }
      });
    };
    if (seed !== null) {
      scan();
    }
    const stopScanning = () => {
      watch.alive = false;
      clearTimeout(scanTimer);
    };
    const kill = (): Promise<void> => {
      if (child.pid === undefined) {
        return Promise.resolve();
      }
      if (windows) {
        return taskkill(child.pid);
      }
      return scanning.then(() => sweep(watch, false)).then(() => undefined);
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
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler);
      }
    };
    child.once("error", (error) => {
      clearTimeout(timer);
      void killing.finally(() => {
        stopScanning();
        settle();
        failed(error);
      });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      void killing.finally(async () => {
        stopScanning();
        let escaped: number[] = [];
        if (!windows && child.pid !== undefined) {
          await scanning.catch(() => undefined);
          escaped = await sweep(watch, true).catch(() => []);
        }
        settle();
        done({
          exitCode: timedOut || interrupted !== undefined ? null : code,
          timedOut,
          ...(interrupted === undefined ? {} : { interrupted }),
          ...(escaped.length === 0 ? {} : { escaped }),
        });
      });
    });
  });
}

type SignalListener = (signal: InterruptSignal) => void;

export type HeldSignals = { caught(): InterruptSignal | undefined; listen(listener: SignalListener): void; release(): void };

export function holdSignals(): HeldSignals {
  let caught: InterruptSignal | undefined;
  let listener: SignalListener | undefined;
  const handlers = (Object.keys(SIGNAL_EXIT) as InterruptSignal[]).map((signal) => {
    const handler = () => {
      caught ??= signal;
      listener?.(signal);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  return {
    caught: () => caught,
    listen: (next) => {
      listener = next;
    },
    release: () => {
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler);
      }
    },
  };
}

export function checkEnv(base: NodeJS.ProcessEnv, spec: string, artifact: string, sha256: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHECK_ENV) {
    const value = base[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, [ENV_SPEC_PATH]: spec, [ENV_ARTIFACT_PATH]: artifact, [ENV_ARTIFACT_SHA256]: sha256 };
}
