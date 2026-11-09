import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
export const SCRIPT = join(ROOT, "scripts/faucet.sh");
export const PAYER = "CrYx7JA1TRwGtpn9T6C2mVsRgMP7XztGRwZdasV9XSLS";
export const NOW = 1_791_662_400;
export const DAY = 86_400;
export const HOUR = 3_600;

export type Comment = { author: string; body: string };
export type Issue = {
  number: number;
  title: string;
  author: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
  closedAt?: string;
  comments: Comment[];
};
export type Landed = { sig: string; to: string; lamports: number };
export type Run = { code: number; out: string; err: string };

const LOCK = `
const lockOf = (file) => {
  const dir = file + ".lock";
  const until = Date.now() + 60000;
  for (;;) {
    try { fs.mkdirSync(dir); return () => fs.rmdirSync(dir); } catch {
      if (Date.now() > until) throw new Error("lock timeout " + dir);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
};
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
`;

const GH = `#!/usr/bin/env node
const fs = require("node:fs");
${LOCK}
const argv = process.argv.slice(2);
const line = "gh " + argv.join(" ");
fs.appendFileSync(process.env.STUB_LOG, line + "\\n");
if (process.env.STUB_GH_FAIL && line.includes(process.env.STUB_GH_FAIL)) { console.error("stub: gh failed"); process.exit(1); }
const release = lockOf(process.env.STUB_STATE);
try {
  const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, "utf8"));
  const flag = (name) => { const at = argv.indexOf(name); return at < 0 ? undefined : argv[at + 1]; };
  const save = () => fs.writeFileSync(process.env.STUB_STATE, JSON.stringify(state));
  const has = (issue, label) => issue.labels.includes(label);
  const [area, verb] = argv;
  const issue = state.issues.find((each) => each.number === Number(argv[2]));
  if (area === "api") {
    console.log(state.created);
  } else if (area === "label") {
  } else if (verb === "view") {
    if (argv.includes("author")) console.log(issue.author);
    else if (argv.includes("body")) console.log(issue.body);
    else console.log(JSON.stringify({ comments: issue.comments.map((c) => ({ author: { login: c.author }, body: c.body })), labels: issue.labels.map((name) => ({ name })) }));
  } else if (verb === "list") {
    const jq = flag("--jq") || "";
    const search = flag("--search") || "";
    let pool = state.issues.filter((each) => flag("--state") === "all" || each.state === (flag("--state") || "open"));
    if (flag("--label")) pool = pool.filter((each) => has(each, flag("--label")));
    if (flag("--author")) pool = pool.filter((each) => each.author === flag("--author"));
    const phrase = /in:title "([^"]+)"/.exec(search);
    if (phrase) pool = pool.filter((each) => each.title.toLowerCase().includes(phrase[1].toLowerCase()));
    const without = /-label:(\\S+)/.exec(search);
    if (without) pool = pool.filter((each) => !has(each, without[1]));
    if (jq.includes('select(.title == "Devnet SOL")')) pool = pool.filter((each) => each.title === "Devnet SOL");
    if (jq.includes('all(.labels[]; .name != "faucet-sent")')) pool = pool.filter((each) => !has(each, "faucet-sent"));
    if (jq.includes('"faucet-pending"')) pool = pool.filter((each) => has(each, "faucet-sent") || has(each, "faucet-pending"));
    const since = /\\.closedAt >= "([^"]+)"/.exec(jq);
    if (since) pool = pool.filter((each) => (each.closedAt ?? "") >= since[1]);
    const before = /\\.number < (\\d+)/.exec(jq);
    if (before) pool = pool.filter((each) => each.number < Number(before[1]));
    if (jq.startsWith("[")) console.log(pool.length);
    else for (const each of pool) console.log(each.number);
  } else if (verb === "comment") {
    issue.comments.push({ author: "github-actions", body: flag("--body") });
    save();
  } else if (verb === "close") {
    issue.state = "closed";
    issue.closedAt = new Date(Number(process.env.FAUCET_NOW) * 1000).toISOString().replace(".000", "");
    save();
  } else if (verb === "edit") {
    if (flag("--add-label") && !has(issue, flag("--add-label"))) issue.labels.push(flag("--add-label"));
    if (flag("--remove-label")) issue.labels = issue.labels.filter((label) => label !== flag("--remove-label"));
    save();
  }
} finally {
  release();
}
`;

const CHAIN = `
const crypto = require("node:crypto");
const height = () => Number(process.env.STUB_HEIGHT || 2 * Number(process.env.FAUCET_NOW));
const encode = (h) => ("Bhash" + String(h).replaceAll("0", "o")).padEnd(43, "x");
const decode = (hash) => Number((/^Bhash([1-9o]+)x*$/.exec(hash)?.[1] ?? "").replaceAll("o", "0"));
const sigOf = (hash, to, amount, memo) => crypto.createHash("sha256").update(hash + "|" + to + "|" + amount + "|" + memo).digest("hex").replaceAll("0", "z");
`;

const SOLANA = `#!/usr/bin/env node
const fs = require("node:fs");
${LOCK}
${CHAIN}
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, "solana " + argv.join(" ") + "\\n");
const flag = (name) => { const at = argv.indexOf(name); return at < 0 ? undefined : argv[at + 1]; };
const valued = new Set(["--url", "--keypair", "--blockhash", "--from", "--fee-payer", "--signer", "--output", "--commitment", "--with-memo"]);
const free = [];
for (let at = 1; at < argv.length; at += 1) {
  if (valued.has(argv[at])) at += 1;
  else if (!argv[at].startsWith("--")) free.push(argv[at]);
}
const chainFile = process.env.STUB_CHAIN;
const read = () => JSON.parse(fs.readFileSync(chainFile, "utf8"));
const down = process.env.STUB_RPC === "down";
const fail = (text) => { console.error(text); process.exit(1); };
const land = (sig, to, amount) => {
  const release = lockOf(chainFile);
  try {
    const chain = read();
    if (chain.landed.some((each) => each.sig === sig)) fail("Error: This transaction has already been processed");
    chain.landed.push({ sig, to, lamports: Math.round(Number(amount) * 1e9) });
    fs.writeFileSync(chainFile, JSON.stringify(chain));
  } finally {
    release();
  }
};
const [command] = argv;
if (command === "balance") {
  if (argv[1] === "--keypair") { console.log((process.env.STUB_LEFT || "10000000000") + " lamports"); process.exit(0); }
  if (down || argv[1] === process.env.STUB_INVALID) process.exit(1);
  const held = Number(process.env.STUB_HELD || 0) + read().landed.filter((each) => each.to === argv[1]).reduce((sum, each) => sum + each.lamports, 0);
  console.log(held + " lamports");
} else if (command === "block-height") {
  if (down) fail("Error: rpc down");
  console.log(height());
} else if (command === "confirm") {
  if (down || process.env.STUB_CONFIRM === "down") fail("Error: rpc down");
  const found = read().landed.some((each) => each.sig === free[0]);
  console.log(JSON.stringify({ confirmationStatus: found ? "finalized" : null }));
} else if (command === "transfer") {
  const [to, amount] = free;
  const hash = flag("--blockhash");
  if (argv.includes("--sign-only")) {
    if (process.env.STUB_BARRIER) {
      fs.writeFileSync(process.env.STUB_BARRIER + "." + process.pid, "");
      const until = Date.now() + 60000;
      while (fs.readdirSync(process.env.STUB_DIR).filter((name) => name.startsWith("barrier.")).length < 2 && Date.now() < until) pause(10);
    }
    console.log(JSON.stringify({ blockhash: hash, signers: [process.env.STUB_PAYER + "=" + sigOf(hash, to, amount, flag("--with-memo"))] }, null, 2));
    process.exit(0);
  }
  let sig;
  if (flag("--signer")) {
    sig = flag("--signer").split("=")[1];
    if (sig !== sigOf(hash, to, amount, flag("--with-memo"))) fail("Error: presigner error");
    if (height() > decode(hash) + 150) fail("Error: blockhash expired");
  } else {
    sig = sigOf("legacy" + read().landed.length + "." + process.pid, to, amount, "");
  }
  if (process.env.STUB_MARK) fs.writeFileSync(process.env.STUB_MARK, sig);
  const mode = process.env.STUB_SEND || "ok";
  if (down) fail("Error: rpc down");
  if (mode === "hang") {
    const until = Date.now() + 60000;
    while (!fs.existsSync(process.env.STUB_RELEASE) && Date.now() < until) pause(10);
  }
  if (mode === "lost-timeout") fail("Error: timed out");
  land(sig, to, amount);
  if (mode === "land-timeout") fail("Error: timed out");
  if (mode === "garbled") { console.log("garbage"); process.exit(0); }
  console.log(JSON.stringify({ signature: sig }, null, 2));
}
`;

const CURL = `#!/usr/bin/env node
const fs = require("node:fs");
${CHAIN}
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, "curl " + argv.join(" ") + "\\n");
if (process.env.STUB_RPC === "down" || process.env.STUB_BLOCKHASH === "down") process.exit(7);
const body = JSON.parse(argv[argv.indexOf("-d") + 1]);
if (body.method !== "getLatestBlockhash") process.exit(22);
const h = height();
console.log(JSON.stringify({ jsonrpc: "2.0", result: { context: { slot: h }, value: { blockhash: encode(h), lastValidBlockHeight: h + 150 } }, id: body.id }));
`;

export function world(issues: Issue[], created = new Date((NOW - 30 * DAY) * 1000).toISOString()) {
  const dir = mkdtempSync(join(tmpdir(), "faucet-world-"));
  const stateFile = join(dir, "state.json");
  const chainFile = join(dir, "chain.json");
  const log = join(dir, "calls.log");
  writeFileSync(stateFile, JSON.stringify({ created, issues }));
  writeFileSync(chainFile, JSON.stringify({ landed: [] }));
  writeFileSync(log, "");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [name, text] of [["gh", GH], ["solana", SOLANA], ["curl", CURL]] as const) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  const env = (extra: Record<string, string> = {}) => ({
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    STUB_STATE: stateFile,
    STUB_CHAIN: chainFile,
    STUB_LOG: log,
    STUB_DIR: dir,
    STUB_PAYER: PAYER,
    STUB_INVALID: "",
    FAUCET_KEYPAIR: join(dir, "faucet.json"),
    FAUCET_SETTLE: "0",
    ...extra,
  });
  const runEnv = (now: number, extra: Record<string, string>) => env({ FAUCET_NOW: String(now), ...extra });
  return {
    dir,
    env,
    state: () => (JSON.parse(readFileSync(stateFile, "utf8")) as { issues: Issue[] }).issues,
    issue: (number: number) => (JSON.parse(readFileSync(stateFile, "utf8")) as { issues: Issue[] }).issues.find((each) => each.number === number),
    landed: () => (JSON.parse(readFileSync(chainFile, "utf8")) as { landed: Landed[] }).landed,
    calls: () => readFileSync(log, "utf8").split("\n").filter((each) => each !== ""),
    run: (now: number, extra: Record<string, string> = {}): Run => {
      const result = spawnSync("bash", [SCRIPT], { cwd: dir, encoding: "utf8", env: runEnv(now, extra), timeout: 120_000 });
      return { code: result.status ?? -1, out: result.stdout.trim(), err: result.stderr.trim() };
    },
    start: (now: number, extra: Record<string, string> = {}): Promise<Run> =>
      new Promise((resolve) => {
        const child = spawn("bash", [SCRIPT], { cwd: dir, env: runEnv(now, extra) });
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
        child.on("close", (code) => resolve({ code: code ?? -1, out: out.trim(), err: err.trim() }));
      }),
  };
}

export const request = (number: number, address: string, more: Partial<Issue> = {}): Issue => ({
  number,
  title: "Devnet SOL",
  author: `user-${number}`,
  body: `### Wallet address\n\n${address}`,
  labels: ["faucet"],
  state: "open",
  comments: [],
  ...more,
});
