export const NODE_READY = '"ready"';

export const NODE_UNCOUNTED = '"uncounted"';

export const NODE_UNLOCKED = '"unlocked"';

export const NODE_UNPROBED = '"unprobed"';

export const NODE_UNMETERED = '"unmetered"';

export const STARTED_FD = 3;

export const CASE_OOM_SCORE = 1000;

export const KEEPER_OOM_SCORE = -1000;

export const KEEPERS_EXPOSED = "the plain Node launcher could not take itself and the container's init out of the kernel's out-of-memory choice, so a case's memory kill could end the launcher instead, and no case was run";

export const UNPREPARED = "unprepared";

export const SAME_UID = "the plain Node launcher runs under the uid its cases would run under, so a case could reach it, and no case was run";

export const NODE_LAUNCHER = `
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const caseFile = process.argv[2];
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let config;
const sweep = () => {
  try {
    process.kill(-1, "SIGKILL");
  } catch {}
};
const pids = () => {
  try {
    return readFileSync(config.procs, "utf8").split("\\n").filter((pid) => pid !== "" && pid !== "1" && pid !== String(process.pid));
  } catch {
    return null;
  }
};
const others = () => {
  const list = pids();
  return list === null ? null : list.length;
};
const running = () => readdirSync("/proc").filter((pid) => /^\\d{1,10}$/.test(pid) && pid !== "1" && pid !== String(process.pid));
const usage = () => {
  try {
    const found = /^usage_usec (\\d{1,20})$/m.exec(readFileSync(config.cpuStat, "utf8"));
    return found === null ? null : Number(found[1]);
  } catch {
    return null;
  }
};
const own = () => {
  const at = process.cpuUsage();
  return at.user + at.system;
};
const taskState = () => {
  let list;
  try {
    list = running();
  } catch {
    return null;
  }
  let disk = false;
  for (const pid of list) {
    let tasks = [];
    try {
      tasks = readdirSync("/proc/" + pid + "/task");
    } catch {}
    for (const task of tasks) {
      try {
        const stat = readFileSync("/proc/" + pid + "/task/" + task + "/stat", "utf8");
        const state = stat.charAt(stat.lastIndexOf(")") + 2);
        if (state === "R") return "run";
        if (state === "D") disk = true;
      } catch {}
    }
  }
  return disk ? "disk" : "idle";
};
const charged = (clock) => clock.usedMs + clock.idleMs + Math.max(0, clock.ioMs - config.caseMs);
const settle = async () => {
  const until = performance.now() + config.settleMs;
  for (;;) {
    sweep();
    const left = others();
    if (left === 0) return true;
    if (left === null || performance.now() >= until) return false;
    await new Promise((done) => setTimeout(done, 5));
  }
};
const memoryEvents = () => {
  try {
    const text = readFileSync(config.events, "utf8");
    const oom = /^oom (\\d{1,15})$/m.exec(text);
    const oomKill = /^oom_kill (\\d{1,15})$/m.exec(text);
    return oom === null || oomKill === null ? null : { oom: Number(oom[1]), oomKill: Number(oomKill[1]) };
  } catch {
    return null;
  }
};
const keepers = () => {
  for (const pid of ["self", "1"]) {
    try {
      writeFileSync("/proc/" + pid + "/oom_score_adj", "${KEEPER_OOM_SCORE}");
      if (readFileSync("/proc/" + pid + "/oom_score_adj", "utf8").trim() !== "${KEEPER_OOM_SCORE}") return false;
    } catch {
      return false;
    }
  }
  return true;
};
const scoreLock = () => {
  const probe = spawnSync(process.execPath, ["--disable-sigusr1", caseFile], { input: JSON.stringify({ probe: true, token: "", json: "[]", zeros: [], path: config.path, uid: config.uid, gid: config.gid }), encoding: "utf8", timeout: config.probeMs, killSignal: "SIGKILL", stdio: ["pipe", "pipe", "ignore"] });
  if (probe.status === 0) return String(probe.stdout).trim() === "${CASE_OOM_SCORE}" ? "locked" : "unlocked";
  return probe.status === 1 ? "unlocked" : "unknown";
};
const runCase = (token, json, zeros) =>
  new Promise((done) => {
    const child = spawn(process.execPath, ["--disable-sigusr1", "--max-old-space-size=" + config.heapMb, "--random-seed=" + config.seed, caseFile], { stdio: ["pipe", "pipe", "ignore", "pipe"], detached: true });
    const out = [];
    let bytes = 0;
    let over = false;
    let timedOut = false;
    let code = null;
    let signal = null;
    const clock = { started: false, metered: true, usedMs: 0, idleMs: 0, ioMs: 0, stoppedBy: null };
    let from = null;
    let last = 0;
    let lastState = "run";
    let sampler;
    let exited = false;
    const stopBy = (cause) => {
      if (exited) return;
      clock.stoppedBy ??= cause;
      timedOut = true;
      child.kill("SIGKILL");
    };
    const read = (final) => {
      if (from === null) return;
      const now = performance.now();
      const state = final ? lastState : taskState();
      if (state === null) clock.metered = false;
      if (state === lastState && state === "idle") clock.idleMs += now - last;
      if (state === lastState && state === "disk") clock.ioMs += now - last;
      last = now;
      lastState = state ?? "run";
      const cpu = usage();
      if (cpu === null) clock.metered = false;
      else clock.usedMs = Math.max(clock.usedMs, (cpu - from.cpu - (own() - from.own)) / 1000);
    };
    const tick = () => {
      sampler = setTimeout(() => {
        if (exited) return;
        read(false);
        if (charged(clock) >= config.caseMs || !clock.metered) stopBy("budget");
        else tick();
      }, config.sampleMs);
    };
    child.stdio[${STARTED_FD}].once("data", () => {
      const cpu = usage();
      if (cpu === null) clock.metered = false;
      from = { cpu: cpu ?? 0, own: own() };
      last = performance.now();
      clock.started = true;
      if (!exited) tick();
    });
    child.stdio[${STARTED_FD}].on("error", () => undefined);
    const timer = setTimeout(() => stopBy("backstop"), config.backstopMs);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > config.outputBytes) {
        over = true;
        child.kill("SIGKILL");
        return;
      }
      if (!over) out.push(chunk);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify({ token, json, zeros, path: config.path, uid: config.uid, gid: config.gid }));
    child.once("exit", (exitCode, endedBy) => {
      clearTimeout(timer);
      clearTimeout(sampler);
      read(true);
      exited = true;
      from = null;
      code = exitCode;
      signal = endedBy;
      sweep();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(sampler);
      sweep();
      done({ token, out: "", code: null, signal: null, timedOut, over, failed: String(error && error.message ? error.message : error) });
    });
    child.once("close", () => {
      read(true);
      done({ token, out: over ? "" : Buffer.concat(out).toString("base64"), code, signal, timedOut, over, clock });
    });
  });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (config === undefined) {
    config = message;
    if (process.getuid() === config.uid || process.getgid() === config.gid) {
      process.stderr.write(${JSON.stringify(SAME_UID)} + "\\n");
      process.exit(78);
    }
    if (!keepers()) {
      process.stderr.write(${JSON.stringify(KEEPERS_EXPOSED)} + "\\n");
      process.exit(70);
    }
    if (config.pinned === true && memoryEvents() === null) {
      process.stdout.write(${JSON.stringify(NODE_UNCOUNTED)} + "\\n");
      process.exit(0);
    }
    const lock = config.pinned === true ? scoreLock() : "locked";
    if (lock !== "locked") {
      process.stdout.write((lock === "unlocked" ? ${JSON.stringify(NODE_UNLOCKED)} : ${JSON.stringify(NODE_UNPROBED)}) + "\\n");
      process.exit(0);
    }
    if (usage() === null || taskState() === null) {
      process.stdout.write(${JSON.stringify(NODE_UNMETERED)} + "\\n");
      process.exit(0);
    }
    process.stdout.write(${JSON.stringify(NODE_READY)} + "\\n");
    continue;
  }
  const oomBefore = memoryEvents();
  const result = await runCase(message.token, message.json, message.zeros);
  const settled = await settle();
  process.stdout.write(JSON.stringify({ ...result, oomBefore, oomAfter: memoryEvents(), settled }) + "\\n");
}
`;

export const NODE_CASE = `
import { spawnSync } from "node:child_process";
import { closeSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
const write = writeSync;
const from = Buffer.from;
const stringify = JSON.stringify;
const apply = Reflect.apply;
const exit = process.exit.bind(process);
const input = JSON.parse(readFileSync(0, "utf8"));
const token = "" + input.token;
const args = JSON.parse("" + input.json);
const zeros = input.zeros;
for (let at = 0; at < zeros.length; at += 1) args[zeros[at]] = -0;
const url = pathToFileURL("" + input.path).href;
const put = (text) => {
  const bytes = from(text, "utf8");
  let at = 0;
  while (at < bytes.length) {
    try {
      at += write(1, bytes, at, bytes.length - at);
    } catch (error) {
      if (error === null || typeof error !== "object" || error.code !== "EAGAIN") exit(70);
    }
  }
};
const say = (verdict, kind, value) => {
  put("\\n" + token + "[" + stringify(verdict) + "," + stringify(kind) + "," + stringify(value) + "]" + token + "\\n");
  exit(0);
};
const describe = (error) => {
  try {
    const message = error !== null && typeof error === "object" ? error.message : error;
    return typeof message === "string" ? message : "a value that is not an Error";
  } catch {
    return "a value that is not an Error";
  }
};
const prepare = () => {
  try {
    writeFileSync("/proc/self/oom_score_adj", "${CASE_OOM_SCORE}");
    process.setgroups([]);
    process.setgid(input.gid);
    process.setuid(input.uid);
  } catch (error) {
    return describe(error);
  }
  const ids = [process.getuid(), process.geteuid(), process.getgid(), process.getegid()].join(" ");
  const score = readFileSync("/proc/self/oom_score_adj", "utf8").trim();
  return ids === [input.uid, input.uid, input.gid, input.gid].join(" ") && score === "${CASE_OOM_SCORE}" ? "" : "the case runs as " + ids + " with out-of-memory score " + score;
};
const unprepared = prepare();
if (input.probe === true) {
  if (unprepared === "") put(String(spawnSync("/bin/sh", ["-c", "echo 0 > /proc/self/oom_score_adj; cat /proc/self/oom_score_adj"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout));
  exit(unprepared === "" ? 0 : 1);
}
if (unprepared !== "") say(${JSON.stringify(UNPREPARED)}, "string", unprepared);
try {
  writeSync(${STARTED_FD}, "s");
  closeSync(${STARTED_FD});
} catch (error) {
  say(${JSON.stringify(UNPREPARED)}, "string", "the case could not tell the launcher that it started: " + describe(error));
}
let fn;
try {
  fn = (await import(url)).default;
} catch (error) {
  say("no-module", "string", describe(error));
}
if (typeof fn !== "function") say("no-module", "string", "the delivery has no default export function");
let got;
let threw = false;
let reason = "";
try {
  got = apply(fn, undefined, args);
} catch (error) {
  threw = true;
  reason = describe(error);
}
if (threw) say("threw", "string", reason);
const kind = got === null ? "null" : typeof got;
if (kind === "string") say("answer", kind, got);
if (kind === "number" || kind === "boolean") say("answer", kind, "" + got);
if (kind === "null") say("answer", kind, null);
say("not-primitive", kind, null);
`;
