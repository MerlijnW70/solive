import { describe, expect, it } from "vitest";
import { claim, type Recorded, type Running, statOf } from "../src/process-table.js";

const entry = (pid: number, parent: number, group: number, session: number, started: number): Running => ({ pid, parent, group, session, started, zombie: false });

const pids = (table: Running[], recorded: Recorded) => claim(table, recorded).map((running) => running.pid);

describe("the process table", () => {
  it.skipIf(process.platform !== "linux")("reads a process's parent, group and session past the name in its stat line", () => {
    const own = statOf(process.pid);
    expect(own).toStrictEqual({ pid: process.pid, parent: process.ppid, group: expect.any(Number), session: expect.any(Number), started: expect.any(Number), zombie: false });
    expect([own?.group, own?.session, own?.started].every((field) => Number.isSafeInteger(field) && (field ?? 0) > 0)).toBe(true);
    expect(statOf(-1)).toBeNull();
  });

  it("claims a child listed before its parent, however deep the chain", () => {
    const recorded: Recorded = { started: new Map([[6000, 100]]), leaders: new Map() };
    const grandchild = entry(6002, 6001, 6002, 6002, 120);
    const child = entry(6001, 6000, 6001, 6001, 110);
    const root = entry(6000, 1, 6000, 6000, 100);
    expect(pids([grandchild, child, root, entry(6003, 1, 6003, 6003, 130)], recorded)).toEqual([6002, 6001, 6000]);
    expect([...recorded.started.keys()].sort()).toEqual([6000, 6001, 6002]);
  });

  it("claims a process of a gone session leader that started in the same tick as the leader", () => {
    const recorded: Recorded = { started: new Map(), leaders: new Map([[7000, 500]]) };
    expect(pids([entry(7001, 1, 7001, 7000, 500), entry(7002, 1, 7002, 7000, 499)], recorded)).toEqual([7001]);
  });
});
