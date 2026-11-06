import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { copyOf, readArtifact, removeCopy } from "./artifact.js";
import { type ContainerRun, docker, ENV_ARTIFACT_PATH, ENV_ARTIFACT_SHA256, ENV_SPEC_PATH, holdSignals, runContainer } from "./check-process.js";
import { containerOutcome, type Ruling } from "./verdict-model.js";
import { JudgeInterrupted } from "./judge-errors.js";
import { type Box, containerArgs, containerName, dockerEnv, SANDBOX_PIDS, sandboxReady } from "./sandbox.js";
import { defaultWallet, expandHome } from "./wallet.js";

export type DoctorCheck = { check: string; ok: boolean; detail?: string };

export type Mounts = { count: number; limit: number };

export type Doctor = {
  docker: string | null;
  image: string;
  gpu: boolean;
  keypair: { path: string; reachable: boolean };
  checks: DoctorCheck[];
  mounts: Mounts | null;
  warnings: string[];
  ready: boolean;
  next: string;
};

export const MOUNTS_NEAR = 0.8;
export const DESKTOP_BIND_MOUNTS = "/mnt/wsl/docker-desktop-bind-mounts/";
export const DESKTOP_COPIES = 4;

export function mountsOf(mountinfo: string, limit: number): Mounts {
  const lines = mountinfo.split("\n").filter((line) => line !== "");
  const desktop = lines.filter((line) => (line.split(" ")[4] ?? "").startsWith(DESKTOP_BIND_MOUNTS)).length;
  return { count: Math.max(lines.length, desktop * DESKTOP_COPIES), limit };
}

export const mountsNear = ({ count, limit }: Mounts): string | undefined =>
  count >= limit * MOUNTS_NEAR
    ? `warning: the Docker host holds about ${count} of the ${limit} mounts one mount namespace may hold; at the limit every docker run fails with no space left on device`
    : undefined;

export async function hostMounts(): Promise<Mounts | null> {
  try {
    const [info, max] = await Promise.all([readFile("/proc/self/mountinfo", "utf8"), readFile("/proc/sys/fs/mount-max", "utf8")]);
    const limit = Number(max.trim());
    return Number.isSafeInteger(limit) && limit > 0 ? mountsOf(info, limit) : null;
  } catch {
    return null;
  }
}

export const DOCTOR_READY = "every isolation check passed on this machine; judge untrusted work with --sandbox docker and a digest-pinned --sandbox-image";
export const DOCTOR_NOT_READY = "one or more isolation checks failed on this machine, so do not judge untrusted work here until each one passes";

export type ProbeLimits = { probeSeconds: number; timeoutProbeSeconds: number };

export const PROBE_LIMITS: ProbeLimits = { probeSeconds: 60, timeoutProbeSeconds: 3 };

const MEMORY_PROBE = "64m";
const FORK_ATTEMPTS = SANDBOX_PIDS + 144;

export const quiet = (script: string): string => `( ${script} ) 2> /dev/null`;

const quoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

const bytesOf = (size: string): number => Number(size.slice(0, -1)) * (size.endsWith("g") ? 1024 ** 3 : 1024 ** 2);

function probes(box: Box, canary: string, keypair: string, allowedEnv: readonly string[]): { check: string; script: string }[] {
  const posixKeypair = keypair.replaceAll("\\", "/");
  return [
    { check: "no network: only the loopback interface", script: 'test "$(ls /sys/class/net)" = lo' },
    { check: "read-only root filesystem", script: "! touch /written 2> /dev/null && ! touch /etc/written 2> /dev/null && ! touch /usr/written 2> /dev/null" },
    { check: "artifact and spec mounted read-only", script: '! touch "$ARTIFACT_PATH/written" 2> /dev/null && ! touch "$SPEC_PATH" 2> /dev/null' },
    { check: "only the in-memory /tmp is writable", script: 'touch /tmp/written && test "$(grep " /tmp " /proc/mounts | cut -d " " -f 3)" = tmpfs' },
    { check: "runs as a user other than root", script: 'test "$(id -u)" != 0' },
    { check: "no capabilities", script: 'grep -q "^CapEff:[[:space:]]*0000000000000000$" /proc/self/status && grep -q "^CapBnd:[[:space:]]*0000000000000000$" /proc/self/status' },
    { check: "no new privileges", script: 'grep -q "^NoNewPrivs:[[:space:]]*1$" /proc/self/status' },
    { check: "seccomp filter on", script: 'grep -q "^Seccomp:[[:space:]]*2$" /proc/self/status' },
    { check: "no docker socket", script: "test ! -e /var/run/docker.sock && test ! -e /run/docker.sock" },
    {
      check: "no host paths beyond the artifact and spec",
      script: `test "$(awk '$5 ~ "^/judge" {print $5}' /proc/self/mountinfo | sort | tr "\\n" " ")" = "/judge/spec /judge/work "`,
    },
    { check: `process limit of ${SANDBOX_PIDS}`, script: `test "$(cat /sys/fs/cgroup/pids.max)" = ${SANDBOX_PIDS}` },
    { check: `memory limit of ${box.memory}`, script: `test "$(cat /sys/fs/cgroup/memory.max)" = ${bytesOf(box.memory)}` },
    { check: `cpu limit of ${box.cpus}`, script: `test "$(cut -d " " -f 1 /sys/fs/cgroup/cpu.max)" = ${Math.round(Number(box.cpus) * 100_000)}` },
    {
      check: "a fork bomb meets the process limit",
      script: `( n=0; while [ $n -lt ${FORK_ATTEMPTS} ]; do sleep 5 & n=$((n + 1)); done ) 2> /dev/null; aborted=$?; read -r name refused < /sys/fs/cgroup/pids.events; [ "$aborted" -ne 0 ] && [ "$refused" -gt 0 ]`,
    },
    {
      check: "no host file, home, wallet or judge keypair is visible",
      script: `test ! -e ${quoted(posixKeypair)} && test ! -e ${quoted(homedir().replaceAll("\\", "/"))} && ! grep -rqsF ${quoted(canary)} / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev`,
    },
    {
      check: "no host environment variable is passed in",
      script: `allowed=${quoted(` ${allowedEnv.join(" ")} `)}; for name in $(env | cut -d = -f 1); do case "$allowed" in *" $name "*) ;; *) exit 1 ;; esac; done`,
    },
  ];
}

export const CONTAINER_ENV = ["HOME", "PATH", "HOSTNAME", "PWD", "OLDPWD", "SHLVL", "_", ENV_SPEC_PATH, ENV_ARTIFACT_PATH, ENV_ARTIFACT_SHA256] as const;

async function allowedEnvOf(image: string, env: NodeJS.ProcessEnv): Promise<string[] | null> {
  const inspected = await docker(["image", "inspect", "--format", "{{json .Config.Env}}", image], env);
  if (inspected.status !== 0) {
    return null;
  }
  try {
    const own = (JSON.parse(inspected.out) as string[] | null) ?? [];
    return [...new Set([...CONTAINER_ENV, ...own.map((entry) => entry.split("=")[0] ?? "")])].filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  } catch {
    return null;
  }
}

async function contained(box: Box, root: { copy: Awaited<ReturnType<typeof copyOf>>; sha256: string }, script: string, timeout: number): Promise<ContainerRun & { gone: boolean; ruled: Ruling }> {
  const name = containerName();
  const env = dockerEnv(process.env);
  const ran = await runContainer(containerArgs({ kind: "docker", ...box }, root.copy, root.sha256, script), name, env, timeout);
  const gone = (await docker(["container", "inspect", name], env)).status !== 0;
  return { ...ran, gone, ruled: containerOutcome(ran, { seconds: timeout, memory: box.memory }) };
}

export async function sandboxDoctor(box: Box, keypair: string | undefined, measure: () => Promise<Mounts | null> = hostMounts, limits: ProbeLimits = PROBE_LIMITS): Promise<Doctor> {
  const keyPath = resolve(expandHome(keypair ?? defaultWallet(homedir()), homedir()));
  const env = dockerEnv(process.env);
  const version = await docker(["version", "--format", "{{.Server.Version}}"], env);
  const mounts = await measure();
  const near = mounts === null ? undefined : mountsNear(mounts);
  const base = { image: box.image, gpu: box.gpu, keypair: { path: keyPath, reachable: true }, mounts, warnings: near === undefined ? [] : [near] };
  if (version.status !== 0) {
    return { docker: null, ...base, checks: [{ check: "docker is usable", ok: false, detail: version.out.slice(0, 300) }], ready: false, next: DOCTOR_NOT_READY };
  }
  const checks: DoctorCheck[] = [{ check: "docker is usable", ok: true, detail: version.out }];
  try {
    await sandboxReady({ kind: "docker", ...box }, env);
    checks.push({ check: "image present and pinned by digest", ok: true });
  } catch (error) {
    checks.push({ check: "image present and pinned by digest", ok: false, detail: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    return { docker: version.out, ...base, checks, ready: false, next: DOCTOR_NOT_READY };
  }
  const canary = `sandbox-doctor-canary-${randomBytes(16).toString("hex")}`;
  const signals = holdSignals();
  const planted = join(tmpdir(), `${canary}.json`);
  const artifact = join(tmpdir(), `sandbox-doctor-${randomBytes(6).toString("hex")}.txt`);
  let copy: Awaited<ReturnType<typeof copyOf>>;
  let sha256: string;
  try {
    await writeFile(planted, JSON.stringify({ canary }));
    await writeFile(artifact, "sandbox doctor\n");
    const read = await readArtifact(artifact);
    sha256 = read.sha256;
    copy = await copyOf(read, new TextEncoder().encode("sandbox doctor spec\n"), undefined, true);
  } catch (error) {
    await removeCopy(planted);
    await removeCopy(artifact);
    signals.release();
    throw error;
  }
  const root = { copy, sha256 };
  let keyHidden = false;
  try {
    const allowed = await allowedEnvOf(box.image, env);
    if (allowed === null) {
      checks.push({ check: "the image's own environment can be read", ok: false });
    }
    for (const probe of probes(box, canary, keyPath, allowed ?? [...CONTAINER_ENV])) {
      if (signals.caught() !== undefined) {
        break;
      }
      const ran = await contained(box, root, probe.script, limits.probeSeconds);
      const ok = ran.ruled.outcome === "pass" && ran.gone;
      checks.push({ check: probe.check, ok, ...(ok ? {} : { detail: !ran.gone ? "the container was left behind" : "reason" in ran.ruled ? ran.ruled.reason : ran.ruled.outcome }) });
      if (probe.check.startsWith("no host file")) {
        keyHidden = ok;
      }
    }
    if (signals.caught() === undefined) {
      const memory = await contained({ ...box, memory: MEMORY_PROBE }, root, quiet("head -c 1073741824 /dev/zero | tail > /dev/null"), limits.probeSeconds);
      checks.push({ check: "a memory bomb is killed at the memory limit and reported as out of memory", ok: memory.state?.oomKilled === true && memory.ruled.outcome === "infra" && memory.gone });
    }
    if (signals.caught() === undefined) {
      const slow = await contained(box, root, "sleep 600", limits.timeoutProbeSeconds);
      checks.push({ check: "a check past its time limit is stopped and its container removed", ok: slow.deadline && slow.ruled.outcome === "infra" && slow.gone });
    }
  } finally {
    await removeCopy(copy.root);
    await removeCopy(planted);
    await removeCopy(artifact);
    signals.release();
  }
  const interrupted = signals.caught();
  if (interrupted !== undefined) {
    throw new JudgeInterrupted(interrupted);
  }
  const ready = checks.every((check) => check.ok);
  return { docker: version.out, ...base, keypair: { path: keyPath, reachable: !keyHidden }, checks, ready, next: ready ? DOCTOR_READY : DOCTOR_NOT_READY };
}
