import { randomBytes } from "node:crypto";
import { chmod, readdir, stat } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { UsageError } from "./arg-values.js";
import type { Values } from "./arg-options.js";
import { CHECK_ENV, docker, ENV_ARTIFACT_PATH, ENV_ARTIFACT_SHA256, ENV_SPEC_PATH } from "./check-process.js";
import { JudgeInfraError } from "./judge-errors.js";

export const SANDBOX_IMAGE = "node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392";
export const SANDBOX_MEMORY = "1g";
export const SANDBOX_CPUS = "1";
export const SANDBOX_PIDS = 256;
export const SANDBOX_TMP = "256m";
export const SANDBOX_NOFILE = 1024;
export const DOCKER_ASK_SECONDS = 30;
export const DOCKER_PULL_SECONDS = 900;
export const SANDBOX_USER = "65534:65534";
export const SANDBOX_ROOT = "/judge";
export const SANDBOX_HOME = "/tmp";

export const SANDBOX_KINDS = ["docker", "viper", "none"] as const;
export type SandboxKind = (typeof SANDBOX_KINDS)[number];
export type Box = { image: string; memory: string; cpus: string; tmp: string; gpu: boolean };
export type Sandbox = { kind: "none"; trusted: true } | { kind: "viper"; node?: Box } | ({ kind: "docker" } & Box);

export const SANDBOX_NEEDED = "--sandbox must be docker, viper or none";
export const VIPER_TAKES_NO_RUN = "--sandbox viper judges the cases in the spec's judge-cases block, so it takes no --run and no --check";
export const IMAGE_NEEDS_DIGEST = "--sandbox-image must name an image by its digest, as <name>@sha256:<64 hex>; a reference without a digest is refused";
export const MEMORY_FORMAT = "--sandbox-memory must be a whole number of megabytes or gigabytes, such as 512m or 2g";
export const CPUS_FORMAT = "--sandbox-cpus must be a number of CPUs above 0, such as 1 or 1.5";
export const TMP_FORMAT = "--sandbox-tmp must be a whole number of megabytes or gigabytes, such as 256m or 4g";
export const NONE_NEEDS_TRUST =
  "--sandbox none runs the worker's code with your own rights: it can read your judge keypair, wallet files and environment and use your network, and it can steer the verdict you sign. Judge untrusted work with --sandbox docker; pass --sandbox none --i-trust-this-work only for work you wrote or fully trust";
export const TRUST_ONLY_WITH_NONE = "--i-trust-this-work applies only with --sandbox none";

export const DOCKER_ENV = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "XDG_RUNTIME_DIR"] as const;

const DIGESTED = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;
const MEMORY = /^[1-9]\d{0,5}[mg]$/;
const CPUS = /^\d{1,3}(\.\d{1,2})?$/;
const SANDBOX_ONLY = ["sandbox-image", "sandbox-memory", "sandbox-cpus", "sandbox-tmp", "sandbox-gpu"] as const;
const READABLE = 0o444;
const SEARCHABLE = 0o755;

export const sandboxOnly = (option: string): string => `--${option} applies only with --sandbox docker, or with --sandbox viper and --plain-node`;

export const PLAIN_NODE_ONLY = "--plain-node applies only with --sandbox viper";
export const SANDBOX_NEEDS_DOCTOR = "sandbox needs doctor";

export function boxOf(values: Values): Box {
  const image = values["sandbox-image"] ?? SANDBOX_IMAGE;
  if (!DIGESTED.test(image)) {
    throw new UsageError(IMAGE_NEEDS_DIGEST);
  }
  const memory = values["sandbox-memory"] ?? SANDBOX_MEMORY;
  if (!MEMORY.test(memory)) {
    throw new UsageError(MEMORY_FORMAT);
  }
  const cpus = values["sandbox-cpus"] ?? SANDBOX_CPUS;
  if (!CPUS.test(cpus) || Number(cpus) <= 0) {
    throw new UsageError(CPUS_FORMAT);
  }
  const tmp = values["sandbox-tmp"] ?? SANDBOX_TMP;
  if (!MEMORY.test(tmp)) {
    throw new UsageError(TMP_FORMAT);
  }
  return { image, memory, cpus, tmp, gpu: values["sandbox-gpu"] === true };
}

export function sandboxOf(values: Values): Sandbox {
  const kind = values.sandbox ?? "docker";
  if (!(SANDBOX_KINDS as readonly string[]).includes(kind)) {
    throw new UsageError(SANDBOX_NEEDED);
  }
  if (values["plain-node"] === true && kind !== "viper") {
    throw new UsageError(PLAIN_NODE_ONLY);
  }
  if (values["i-trust-this-work"] === true && kind !== "none") {
    throw new UsageError(TRUST_ONLY_WITH_NONE);
  }
  if (kind === "viper" && values["plain-node"] === true) {
    if (values.run !== undefined || values.check !== undefined) {
      throw new UsageError(VIPER_TAKES_NO_RUN);
    }
    return { kind, node: boxOf(values) };
  }
  if (kind === "none" || kind === "viper") {
    const given = SANDBOX_ONLY.find((option) => values[option] !== undefined);
    if (given !== undefined) {
      throw new UsageError(sandboxOnly(given));
    }
    if (kind === "viper" && (values.run !== undefined || values.check !== undefined)) {
      throw new UsageError(VIPER_TAKES_NO_RUN);
    }
    if (kind === "viper") {
      return { kind };
    }
    if (values["i-trust-this-work"] !== true) {
      throw new UsageError(NONE_NEEDS_TRUST);
    }
    return { kind, trusted: true };
  }
  return { kind: "docker", ...boxOf(values) };
}

export function dockerEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...CHECK_ENV, ...DOCKER_ENV]) {
    const value = base[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

const DOCKER_INSTALL = ["https:", "", "docs.docker.com", "engine", "install", ""].join("/");

export const dockerMissing = (reason: string): string =>
  `docker is not available (${reason || "no answer"}), so the check cannot run in its sandbox and nothing was run or paid; install Docker from ${DOCKER_INSTALL} and start it. Only for work you wrote or fully trust, --sandbox none --i-trust-this-work runs the check with your own rights, files, keys and network`;

export const imageMissing = (image: string, reason: string): string => `docker could not pull ${image} (${reason || "no answer"}); nothing was run or paid`;

export const NO_SANDBOX = "warning: --sandbox none ran the check with your own rights: it could read your files and keys and use your network";
export const NO_ISOLATION = "no isolation: --sandbox none --i-trust-this-work ran the check with the judge's own rights, files, keys and network";
export const GPU_SHARED = "the check ran with --sandbox-gpu: the container could reach the host's GPU devices and driver, which the other limits do not cover";

export const boxIn = (sandbox: Sandbox): Box | undefined => (sandbox.kind === "docker" ? sandbox : sandbox.kind === "viper" ? sandbox.node : undefined);

export type DockerLimits = { ask: number; pull: number };

export async function sandboxReady(sandbox: Sandbox, env: NodeJS.ProcessEnv, limits: DockerLimits = { ask: DOCKER_ASK_SECONDS, pull: DOCKER_PULL_SECONDS }): Promise<void> {
  const box = boxIn(sandbox);
  if (box === undefined) {
    return;
  }
  const server = await docker(["version", "--format", "{{.Server.Version}}"], env, false, limits.ask);
  if (server.status !== 0) {
    throw new JudgeInfraError(dockerMissing(server.out));
  }
  if ((await docker(["image", "inspect", "--format", "{{.Id}}", box.image], env, false, limits.ask)).status === 0) {
    return;
  }
  const pulled = await docker(["pull", box.image], env, true, limits.pull);
  if (pulled.status !== 0) {
    throw new JudgeInfraError(imageMissing(box.image, pulled.out));
  }
}

export const containerName = (): string => `judge-${randomBytes(8).toString("hex")}`;

export type Mounted = { root: string; path: string; spec: string; check: string | undefined };

export const insideOf = (root: string, host: string): string => posix.join(SANDBOX_ROOT, ...relative(root, host).split(sep));

export function containerArgs(sandbox: Extract<Sandbox, { kind: "docker" }>, copy: Mounted, sha256: string, run: string): string[] {
  const shared = ["work", "spec", ...(copy.check === undefined ? [] : ["check"])];
  return [
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--ipc",
    "private",
    "--cgroupns",
    "private",
    "--log-driver",
    "none",
    "--user",
    SANDBOX_USER,
    "--pids-limit",
    String(SANDBOX_PIDS),
    "--memory",
    sandbox.memory,
    "--memory-swap",
    sandbox.memory,
    "--cpus",
    sandbox.cpus,
    "--ulimit",
    `nofile=${SANDBOX_NOFILE}:${SANDBOX_NOFILE}`,
    "--ulimit",
    "core=0",
    "--tmpfs",
    `/tmp:rw,exec,nosuid,nodev,size=${sandbox.tmp}`,
    ...(sandbox.gpu ? ["--gpus", "all"] : []),
    ...shared.flatMap((dir) => ["--mount", `type=bind,source=${join(copy.root, dir)},target=${posix.join(SANDBOX_ROOT, dir)},readonly`]),
    "--workdir",
    SANDBOX_ROOT,
    "--env",
    `HOME=${SANDBOX_HOME}`,
    "--env",
    `${ENV_SPEC_PATH}=${insideOf(copy.root, copy.spec)}`,
    "--env",
    `${ENV_ARTIFACT_PATH}=${insideOf(copy.root, copy.path)}`,
    "--env",
    `${ENV_ARTIFACT_SHA256}=${sha256}`,
    "--entrypoint",
    "/bin/sh",
    sandbox.image,
    "-c",
    run,
  ];
}

export async function shareable(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      await chmod(full, SEARCHABLE);
      await shareable(full);
    } else {
      await chmod(full, ((await stat(full)).mode & 0o777) | READABLE);
    }
  }
}
