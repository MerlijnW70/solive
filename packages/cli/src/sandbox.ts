import { randomBytes } from "node:crypto";
import { chmod, readdir, stat } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { UsageError } from "./arg-values.js";
import type { Values } from "./arg-options.js";
import { CHECK_ENV, docker, ENV_ARTIFACT_PATH, ENV_ARTIFACT_SHA256, ENV_SPEC_PATH } from "./check-process.js";
import { JudgeRefused } from "./judge-errors.js";

export const SANDBOX_IMAGE = "node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392";
export const SANDBOX_MEMORY = "1g";
export const SANDBOX_CPUS = "1";
export const SANDBOX_PIDS = 256;
export const SANDBOX_TMP = "256m";
export const SANDBOX_USER = "65534:65534";
export const SANDBOX_ROOT = "/judge";
export const SANDBOX_HOME = "/tmp";

export const SANDBOX_KINDS = ["docker", "none"] as const;
export type SandboxKind = (typeof SANDBOX_KINDS)[number];
export type Sandbox = { kind: "none" } | { kind: "docker"; image: string; memory: string; cpus: string };

export const SANDBOX_NEEDED = "--sandbox must be docker or none";
export const IMAGE_NEEDS_DIGEST = "--sandbox-image must name an image by its digest, as <name>@sha256:<64 hex>; a reference without a digest is refused";
export const MEMORY_FORMAT = "--sandbox-memory must be a whole number of megabytes or gigabytes, such as 512m or 2g";
export const CPUS_FORMAT = "--sandbox-cpus must be a number of CPUs above 0, such as 1 or 1.5";

export const DOCKER_ENV = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "XDG_RUNTIME_DIR"] as const;

const DIGESTED = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;
const MEMORY = /^[1-9]\d{0,5}[mg]$/;
const CPUS = /^\d{1,3}(\.\d{1,2})?$/;
const SANDBOX_ONLY = ["sandbox-image", "sandbox-memory", "sandbox-cpus"] as const;
const READABLE = 0o444;
const SEARCHABLE = 0o755;

export const sandboxOnly = (option: string): string => `--${option} applies only with --sandbox docker`;

export function sandboxOf(values: Values): Sandbox {
  const kind = values.sandbox ?? "docker";
  if (!(SANDBOX_KINDS as readonly string[]).includes(kind)) {
    throw new UsageError(SANDBOX_NEEDED);
  }
  if (kind === "none") {
    const given = SANDBOX_ONLY.find((option) => values[option] !== undefined);
    if (given !== undefined) {
      throw new UsageError(sandboxOnly(given));
    }
    return { kind: "none" };
  }
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
  return { kind: "docker", image, memory, cpus };
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
  `docker is not available (${reason || "no answer"}), so the check cannot run in its sandbox and nothing was run or paid; install Docker from ${DOCKER_INSTALL} and start it, or pass --sandbox none to run the check with your own rights, files, keys and network`;

export const imageMissing = (image: string, reason: string): string => `docker could not pull ${image} (${reason || "no answer"}); nothing was run or paid`;

export const NO_SANDBOX = "warning: --sandbox none ran the check with your own rights: it could read your files and keys and use your network";

export async function sandboxReady(sandbox: Sandbox, env: NodeJS.ProcessEnv): Promise<void> {
  if (sandbox.kind === "none") {
    return;
  }
  const server = await docker(["version", "--format", "{{.Server.Version}}"], env);
  if (server.status !== 0) {
    throw new JudgeRefused(dockerMissing(server.out));
  }
  if ((await docker(["image", "inspect", "--format", "{{.Id}}", sandbox.image], env)).status === 0) {
    return;
  }
  const pulled = await docker(["pull", sandbox.image], env, true);
  if (pulled.status !== 0) {
    throw new JudgeRefused(imageMissing(sandbox.image, pulled.out));
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
    "--tmpfs",
    `/tmp:rw,exec,nosuid,nodev,size=${SANDBOX_TMP}`,
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
