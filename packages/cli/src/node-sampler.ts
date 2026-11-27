import { nextDue, sampleGapMs, sampleMeanMs } from "./verdict-model.js";

export const NODE_TASKS = `
const running = () => readdirSync("/proc").filter((pid) => /^\\d{1,10}$/.test(pid) && pid !== "1" && pid !== String(process.pid));
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
`;

export const NODE_SAMPLER = `
const { readdirSync, readFileSync } = require("node:fs");
const { randomBytes } = require("node:crypto");
const { parentPort, workerData } = require("node:worker_threads");
const { gate, plan, config } = workerData;
${NODE_TASKS}
const nextDue = ${nextDue};
const sampleGapMs = ${sampleGapMs};
const sampleMeanMs = ${sampleMeanMs};
const now = () => performance.timeOrigin + performance.now();
const spent = () => {
  const used = process.cpuUsage();
  return (used.user + used.system) / 1000;
};
const unit = () => (randomBytes(6).readUIntBE(0, 6) + 1) / 2 ** 48;
const mean = (costMs) => sampleMeanMs(costMs, plan[1], config.sampleLoad, config.sampleFewestMs, config.sampleMs);
for (;;) {
  Atomics.wait(gate, 0, 0);
  const round = Atomics.load(gate, 0);
  let weight = mean(0);
  let before = spent();
  let due = plan[0] + sampleGapMs(unit(), weight);
  while (Atomics.load(gate, 0) === round) {
    const left = due - now();
    if (left > 0) {
      Atomics.wait(gate, 0, round, left);
      continue;
    }
    const at = now();
    const state = taskState();
    const used = spent();
    const next = mean(used - before);
    before = used;
    parentPort.postMessage([round, due, at, state, weight]);
    due = nextDue(due, at, state !== null, sampleGapMs(unit(), next), config.sampleMs);
    weight = next;
  }
}
`;
