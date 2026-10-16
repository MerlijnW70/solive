import { spawnSync } from "node:child_process";

export const DOCKER = spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0 || process.env["CI"] !== undefined;

export const DOCKER_TEST = { skip: !DOCKER, timeout: 120_000 } as const;
