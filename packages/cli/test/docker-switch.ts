import { spawnSync } from "node:child_process";
import { SANDBOX_IMAGE } from "../src/sandbox.js";
import { caseFilledChosen, caseFilledPinned, caseOomInfra, caseOomPinned } from "../src/verdict-model.js";

export const DOCKER = spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0 || process.env["CI"] !== undefined;

export const DOCKER_TEST = { skip: !DOCKER, timeout: 120_000 } as const;

let groupKill: boolean | undefined;

export const groupKills = (): boolean => {
  groupKill ??= spawnSync("docker", ["run", "--rm", "--memory", "128m", "--entrypoint", "cat", SANDBOX_IMAGE, "/sys/fs/cgroup/memory.oom.group"], { encoding: "utf8" }).stdout?.trim() === "1";
  return groupKill;
};

export const selfKilledPinned = (memory: string): string => (groupKills() ? caseFilledPinned(memory) : caseOomPinned(memory));

export const selfKilledChosen = (memory: string): string => (groupKills() ? caseFilledChosen(memory) : caseOomInfra(memory));
