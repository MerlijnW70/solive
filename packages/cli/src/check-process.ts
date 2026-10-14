import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { type InterruptSignal, SIGNAL_EXIT } from "./judge-errors.js";

export const ENV_SPEC_PATH = "SPEC_PATH";
export const ENV_ARTIFACT_PATH = "ARTIFACT_PATH";
export const ENV_ARTIFACT_SHA256 = "ARTIFACT_SHA256";

const SESSION_ROUNDS = 10;
const STARTED_FIELD = 19;
const SCAN_MS = 250;
const ROUND_PAUSE_MS = 10;

export const CHECK_ENV = ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "TERM"] as const;

export type Check = { exitCode: number | null; timedOut: boolean; interrupted?: InterruptSignal; escaped?: number[] };

export type CheckOptions = { cwd?: string };

const quietly = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
};

export type Running = { pid: number; parent: number; group: number; session: number; started: number; zombie: boolean };

export type Recorded = { started: Map<number, number>; leaders: Map<number, number> };

function parseStat(pid: number, line: string): Running {
  const fields = line.slice(line.lastIndexOf(")") + 2).split(" ");
  const [state, parent, group, session] = fields;
  return { pid, parent: Number(parent), group: Number(group), session: Number(session), started: Number(fields[STARTED_FIELD]), zombie: state === "Z" };
}

function statOf(pid: number): Running | null {
  try {
    return parseStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

async function processTable(): Promise<Running[] | null> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return null;
  }
  const found = await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry))
      .map(async (entry): Promise<Running | null> => {
        try {
          return parseStat(Number(entry), await readFile(`/proc/${entry}/stat`, "utf8"));
        } catch {
          return null;
        }
      }),
  );
  return found.filter((running) => running !== null);
}

export function claim(table: readonly Running[], recorded: Recorded): Running[] {
  const byPid = new Map(table.map((running) => [running.pid, running]));
  for (const records of [recorded.started, recorded.leaders]) {
    for (const [pid, started] of records) {
      if ((byPid.get(pid)?.started ?? started) !== started) {
        records.delete(pid);
      }
    }
  }
  const leads = (leader: number) => {
    const started = recorded.started.get(leader);
    return started !== undefined && byPid.get(leader)?.started === started;
  };
  const owned = new Set<number>();
  const inSession = (running: Running) => {
    if (owned.has(running.session)) {
      return true;
    }
    const started = recorded.leaders.get(running.session);
    return started !== undefined && !byPid.has(running.session) && running.started >= started;
  };
  let grew = true;
  while (grew) {
    grew = false;
    for (const running of table) {
      if (running.pid !== process.pid && !owned.has(running.pid) && (leads(running.pid) || owned.has(running.parent) || inSession(running) || leads(running.group))) {
        owned.add(running.pid);
        grew = true;
      }
    }
  }
  const claimed = table.filter((running) => owned.has(running.pid));
  for (const running of claimed) {
    recorded.started.set(running.pid, running.started);
    if (running.pid === running.session) {
      recorded.leaders.set(running.pid, running.started);
    }
  }
  return claimed;
}

function pkillSession(session: number): Promise<void> {
  return new Promise((done) => {
    const killer = spawn("pkill", ["-KILL", "-s", String(session)], { stdio: "ignore" });
    killer.once("error", () => done());
    killer.once("exit", () => done());
  });
}

function listed(command: string, args: readonly string[]): Promise<number[] | null> {
  return new Promise((done) => {
    const lister = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    lister.stdout.setEncoding("utf8");
    lister.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    lister.once("error", () => done(null));
    lister.once("close", (code) => {
      done(code === 0 || code === 1 ? out.split(/\s+/).filter((field) => /^\d+$/.test(field)).map(Number) : null);
    });
  });
}

async function sessionMembers(session: number): Promise<number[]> {
  const found = (await listed("pgrep", ["-s", String(session)])) ?? (await listed("ps", ["-o", "pid=", "-g", String(session)])) ?? [];
  return [...new Set(found)].filter((pid) => pid !== process.pid && pid !== session);
}

type Watch = { pid: number; started: number | null; recorded: Recorded; alive: boolean; marker: string | undefined; cwd: string | undefined };

const living = (running: Running) => !running.zombie;

async function marked(running: Running, watch: Watch): Promise<boolean> {
  if (watch.marker !== undefined) {
    try {
      if ((await readFile(`/proc/${running.pid}/environ`, "utf8")).split("\0").includes(watch.marker)) {
        return true;
      }
    } catch {
      return false;
    }
  }
  if (watch.cwd !== undefined) {
    try {
      const at = await readlink(`/proc/${running.pid}/cwd`);
      return at === watch.cwd || at.startsWith(`${watch.cwd}/`);
    } catch {
      return false;
    }
  }
  return false;
}

export const leftRunning = (pids: readonly number[]): string =>
  `warning: the check left processes running that the judge could not tie to it, so it did not kill them: ${pids.join(", ")}; stop them by hand`;

export const stillRunning = (pids: readonly number[]): string =>
  `warning: processes started by the check were still running after ${SESSION_ROUNDS} kill rounds: ${pids.join(", ")}; stop them by hand`;

async function escapedFrom(table: readonly Running[], owned: readonly Running[], watch: Watch): Promise<number[]> {
  const { started } = watch;
  if (started === null) {
    return [];
  }
  const ours = new Set(owned.map((running) => running.pid));
  const candidates = table.filter((running) => living(running) && running.pid !== process.pid && !ours.has(running.pid) && running.started >= started);
  const found = await Promise.all(candidates.map(async (running) => ((await marked(running, watch)) ? running.pid : null)));
  return found.filter((pid) => pid !== null);
}

const warn = (text: string) => {
  process.stderr.write(`${text}\n`);
};

async function sweep(watch: Watch, report: boolean): Promise<number[]> {
  for (let round = 0; round <= SESSION_ROUNDS; round++) {
    const table = await processTable();
    if (table === null || watch.started === null) {
      if (watch.alive) {
        quietly(-watch.pid);
        await pkillSession(watch.pid);
        return [];
      }
      if (!report) {
        return [];
      }
      const left = await sessionMembers(watch.pid);
      if (left.length > 0) {
        warn(leftRunning(left));
      }
      return left;
    }
    const owned = claim(table, watch.recorded);
    const live = owned.filter(living);
    if (live.length === 0 || round === SESSION_ROUNDS) {
      if (live.length > 0) {
        warn(stillRunning(live.map((running) => running.pid)));
      }
      if (!report) {
        return [];
      }
      const escaped = await escapedFrom(table, owned, watch);
      if (escaped.length > 0) {
        warn(leftRunning(escaped));
      }
      return escaped;
    }
    live.forEach((running) => quietly(running.pid));
    await new Promise((wake) => setTimeout(wake, round * ROUND_PAUSE_MS));
  }
  return [];
}

function taskkill(pid: number): Promise<void> {
  return new Promise((done) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.once("error", () => done());
    killer.once("exit", () => done());
  });
}

export function runCheck(command: string, env: NodeJS.ProcessEnv, timeoutSeconds: number, options: CheckOptions = {}): Promise<Check> {
  return new Promise((done, failed) => {
    const child = spawn(command, {
      shell: true,
      env,
      cwd: options.cwd,
      stdio: ["ignore", 2, 2],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
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

async function removeContainer(name: string, env: NodeJS.ProcessEnv): Promise<void> {
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
