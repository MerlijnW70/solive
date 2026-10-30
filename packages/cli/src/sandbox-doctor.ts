import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { copyOf, readArtifact, removeCopy } from "./artifact.js";
import { type Check, docker, ENV_ARTIFACT_PATH, ENV_ARTIFACT_SHA256, ENV_SPEC_PATH, runContainer } from "./check-process.js";
import { type Box, containerArgs, containerName, dockerEnv, SANDBOX_PIDS, sandboxReady } from "./sandbox.js";
import { defaultWallet, expandHome } from "./wallet.js";

export type DoctorCheck = { check: string; ok: boolean; detail?: string };

export type Doctor = {
  docker: string | null;
  image: string;
  gpu: boolean;
  keypair: { path: string; reachable: boolean };
  checks: DoctorCheck[];
  ready: boolean;
  next: string;
};

export const DOCTOR_READY = "every isolation check passed on this machine; judge untrusted work with --sandbox docker and a digest-pinned --sandbox-image";
export const DOCTOR_NOT_READY = "one or more isolation checks failed on this machine, so do not judge untrusted work here until each one passes";

const PROBE_SECONDS = 60;
const TIMEOUT_PROBE_SECONDS = 3;
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

async function contained(box: Box, root: { copy: Awaited<ReturnType<typeof copyOf>>; sha256: string }, script: string, timeout: number): Promise<Check & { gone: boolean }> {
  const name = containerName();
  const env = dockerEnv(process.env);
  const ran = await runContainer(containerArgs({ kind: "docker", ...box }, root.copy, root.sha256, script), name, env, timeout);
  const gone = (await docker(["container", "inspect", name], env)).status !== 0;
  return { ...ran, gone };
}

export async function sandboxDoctor(box: Box, keypair: string | undefined): Promise<Doctor> {
  const keyPath = resolve(expandHome(keypair ?? defaultWallet(homedir()), homedir()));
  const env = dockerEnv(process.env);
  const version = await docker(["version", "--format", "{{.Server.Version}}"], env);
  const base = { image: box.image, gpu: box.gpu, keypair: { path: keyPath, reachable: true } };
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
  const planted = join(tmpdir(), `${canary}.json`);
  await writeFile(planted, JSON.stringify({ canary }));
  const artifact = join(tmpdir(), `sandbox-doctor-${randomBytes(6).toString("hex")}.txt`);
  await writeFile(artifact, "sandbox doctor\n");
  const read = await readArtifact(artifact);
  const copy = await copyOf(read, new TextEncoder().encode("sandbox doctor spec\n"));
  const root = { copy, sha256: read.sha256 };
  let keyHidden = false;
  try {
    const allowed = await allowedEnvOf(box.image, env);
    if (allowed === null) {
      checks.push({ check: "the image's own environment can be read", ok: false });
    }
    for (const probe of probes(box, canary, keyPath, allowed ?? [...CONTAINER_ENV])) {
      const ran = await contained(box, root, probe.script, PROBE_SECONDS);
      const ok = ran.exitCode === 0 && ran.gone && ran.infra === undefined;
      checks.push({ check: probe.check, ok, ...(ok ? {} : { detail: ran.infra ?? (ran.gone ? `exit ${ran.exitCode ?? "none"}` : "the container was left behind") }) });
      if (probe.check.startsWith("no host file")) {
        keyHidden = ok;
      }
    }
    const memory = await contained({ ...box, memory: MEMORY_PROBE }, root, quiet("head -c 1073741824 /dev/zero | tail > /dev/null"), PROBE_SECONDS);
    checks.push({ check: "a memory bomb is killed at the memory limit and reported as out of memory", ok: memory.oom === true && memory.gone });
    const slow = await contained(box, root, "sleep 600", TIMEOUT_PROBE_SECONDS);
    checks.push({ check: "a check past its time limit is stopped and its container removed", ok: slow.timedOut && slow.gone });
  } finally {
    await removeCopy(copy.root);
    await rm(planted, { force: true });
    await rm(artifact, { force: true });
  }
  const ready = checks.every((check) => check.ok);
  return { docker: version.out, ...base, keypair: { path: keyPath, reachable: !keyHidden }, checks, ready, next: ready ? DOCTOR_READY : DOCTOR_NOT_READY };
}
