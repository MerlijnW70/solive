import { spawn } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { claim, living, processTable, type Recorded, type Running } from "./process-table.js";

const SESSION_ROUNDS = 10;
const ROUND_PAUSE_MS = 10;

export const quietly = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
};

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

export type Watch = { pid: number; started: number | null; recorded: Recorded; alive: boolean; marker: string | undefined; cwd: string | undefined };

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

export const warn = (text: string) => {
  process.stderr.write(`${text}\n`);
};

export async function sweep(watch: Watch, report: boolean): Promise<number[]> {
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

export function taskkill(pid: number): Promise<void> {
  return new Promise((done) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.once("error", () => done());
    killer.once("exit", () => done());
  });
}
