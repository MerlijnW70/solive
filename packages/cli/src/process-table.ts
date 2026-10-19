import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";

const STARTED_FIELD = 19;

export type Running = { pid: number; parent: number; group: number; session: number; started: number; zombie: boolean };

export type Recorded = { started: Map<number, number>; leaders: Map<number, number> };

function parseStat(pid: number, line: string): Running {
  const fields = line.slice(line.lastIndexOf(")") + 2).split(" ");
  const [state, parent, group, session] = fields;
  return { pid, parent: Number(parent), group: Number(group), session: Number(session), started: Number(fields[STARTED_FIELD]), zombie: state === "Z" };
}

export function statOf(pid: number): Running | null {
  try {
    return parseStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

export async function processTable(): Promise<Running[] | null> {
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

export const living = (running: Running) => !running.zombie;

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
