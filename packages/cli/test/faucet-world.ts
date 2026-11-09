import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
export const SCRIPT = join(ROOT, "scripts/faucet.sh");
export const PAYER = "CrYx7JA1TRwGtpn9T6C2mVsRgMP7XztGRwZdasV9XSLS";
export const NOW = 1_791_662_400;
export const DAY = 86_400;
export const HOUR = 3_600;

export type Comment = { author: string; body: string; run?: string; at?: number };
export type Issue = {
  number: number;
  title: string;
  author: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
  createdAt?: string;
  closedAt?: string;
  updatedAt?: string;
  comments: Comment[];
};
export type Landed = { sig: string; from?: string; to: string; lamports: number; slot: number; time?: number; memo: string };
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
if (process.env.STUB_GH_FAIL && line.includes(process.env.STUB_GH_FAIL)) { console.error("stub: gh failed"); process.exit(Number(process.env.STUB_GH_CODE || 1)); }
const release = lockOf(process.env.STUB_STATE);
try {
  const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, "utf8"));
  const flag = (name) => { const at = argv.indexOf(name); return at < 0 ? undefined : argv[at + 1]; };
  const save = () => fs.writeFileSync(process.env.STUB_STATE, JSON.stringify(state));
  const has = (issue, label) => issue.labels.includes(label);
  const visible = (c) => !process.env.STUB_LAG || !c.run || c.run === process.env.RUN_ID || Date.now() - c.at > Number(process.env.STUB_LAG);
  const stamp = new Date((Number(process.env.FAUCET_NOW) || 0) * 1000).toISOString().replace(".000", "");
  const [area, verb] = argv;
  const issue = state.issues.find((each) => each.number === Number(argv[2]));
  if (area === "api") {
    console.log(state.created);
  } else if (area === "label") {
  } else if (area === "run") {
    for (const id of (process.env.STUB_RUNS || process.env.GITHUB_RUN_ID || "").split(",").filter(Boolean)) console.log(id);
  } else if (verb === "view") {
    if (argv.includes("author")) console.log(issue.author);
    else if (argv.includes("body")) console.log(issue.body);
    else console.log(JSON.stringify({
      comments: issue.comments.filter(visible).map((c) => ({ author: { login: c.author }, body: c.body })),
      labels: issue.labels.map((name) => ({ name })),
      state: issue.state.toUpperCase(),
      createdAt: issue.createdAt ?? state.issueCreated,
    }));
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
    const closedSince = /closed:>=(\\S+)/.exec(search);
    if (closedSince) pool = pool.filter((each) => (each.closedAt ?? "") >= closedSince[1]);
    pool = pool.sort((a, b) => b.number - a.number).slice(0, Number(flag("--limit") || 30));
    if (jq.includes('select(.title == "Devnet SOL")')) pool = pool.filter((each) => each.title === "Devnet SOL");
    if (jq.includes('all(.labels[]; .name != "faucet-sent")')) pool = pool.filter((each) => !has(each, "faucet-sent"));
    const since = /\\.closedAt >= "([^"]+)"/.exec(jq);
    if (since) pool = pool.filter((each) => (each.closedAt ?? "") >= since[1]);
    const updated = /\\.updatedAt >= "([^"]+)"/.exec(jq);
    if (updated) pool = pool.filter((each) => (each.updatedAt ?? state.issueCreated) >= updated[1]);
    const before = /\\.number < (\\d+)/.exec(jq);
    if (before) pool = pool.filter((each) => each.number < Number(before[1]));
    if (jq.startsWith("[") || jq === "length") console.log(pool.length);
    else for (const each of pool) console.log(each.number);
  } else if (verb === "comment") {
    issue.comments.push({ author: "github-actions", body: flag("--body"), run: process.env.RUN_ID, at: Date.now() });
    issue.updatedAt = stamp;
    save();
  } else if (verb === "close") {
    issue.state = "closed";
    issue.closedAt = stamp;
    issue.updatedAt = stamp;
    save();
  } else if (verb === "edit") {
    if (flag("--add-label") && !has(issue, flag("--add-label"))) issue.labels.push(flag("--add-label"));
    if (flag("--remove-label")) issue.labels = issue.labels.filter((label) => label !== flag("--remove-label"));
    issue.updatedAt = stamp;
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
const read = () => JSON.parse(fs.readFileSync(process.env.STUB_CHAIN, "utf8"));
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
const down = process.env.STUB_RPC === "down";
const fail = (text) => { console.error(text); process.exit(1); };
const land = (sig, to, amount, memo) => {
  const release = lockOf(chainFile);
  try {
    const chain = read();
    if (chain.landed.some((each) => each.sig === sig)) fail("Error: This transaction has already been processed");
    chain.landed.push({ sig, from: process.env.STUB_PAYER, to, lamports: Math.round(Number(amount) * 1e9), slot: height() + 1, time: Number(process.env.FAUCET_NOW), memo: memo ?? "" });
    fs.writeFileSync(chainFile, JSON.stringify(chain));
  } finally {
    release();
  }
};
const [command] = argv;
if (command === "address") {
  console.log(process.env.STUB_PAYER);
} else if (command === "balance") {
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
  const level = process.env.STUB_CONFIRM === "forget" ? null : found ? (process.env.STUB_CONFIRM === "confirmed" ? "confirmed" : "finalized") : null;
  console.log(JSON.stringify({ confirmationStatus: level }));
} else if (command === "transfer") {
  const [to, amount] = free;
  const hash = flag("--blockhash");
  const memo = flag("--with-memo");
  if (argv.includes("--sign-only")) {
    if (process.env.STUB_BARRIER) {
      fs.writeFileSync(process.env.STUB_BARRIER + "." + process.pid, "");
      const until = Date.now() + 200000;
      while (fs.readdirSync(process.env.STUB_DIR).filter((name) => name.startsWith("barrier.")).length < 2 && Date.now() < until) pause(10);
    }
    console.log(JSON.stringify({ blockhash: hash, signers: [process.env.STUB_PAYER + "=" + sigOf(hash, to, amount, memo)] }, null, 2));
    process.exit(0);
  }
  let sig;
  if (flag("--signer")) {
    sig = flag("--signer").split("=")[1];
    if (sig !== sigOf(hash, to, amount, memo)) fail("Error: presigner error");
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
  land(sig, to, amount, memo);
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
if (process.env.STUB_RPC === "down") process.exit(7);
const body = JSON.parse(argv[argv.indexOf("-d") + 1]);
const reply = (result) => console.log(JSON.stringify({ jsonrpc: "2.0", result, id: body.id }));
const h = height();
if (body.method === "getLatestBlockhash") {
  if (process.env.STUB_BLOCKHASH === "down") process.exit(7);
  reply({ context: { slot: h }, value: { blockhash: encode(h), lastValidBlockHeight: h + 150 } });
} else if (body.method === "getSignaturesForAddress") {
  const [address, options] = body.params;
  const mode = process.env.STUB_HISTORY || "full";
  if (mode === "down") process.exit(7);
  if (mode === "unreachable") { console.log(JSON.stringify({ jsonrpc: "2.0", error: { code: -32019, message: "Failed to query long-term storage; please try again" }, id: body.id })); process.exit(0); }
  if (options.minContextSlot !== undefined && options.minContextSlot > h) { console.log(JSON.stringify({ jsonrpc: "2.0", error: { code: -32016, message: "Minimum context slot has not been reached" }, id: body.id })); process.exit(0); }
  if (address !== process.env.STUB_PAYER || mode === "empty") { reply([]); process.exit(0); }
  const funding = { signature: "F".repeat(64), slot: 1, blockTime: 0, memo: null, err: null };
  const landed = read().landed.map((each, at) => ({ each, at })).filter(({ each }) => each.slot <= h).sort((a, b) => b.each.slot - a.each.slot || b.at - a.at)
    .map(({ each }) => ({ signature: each.sig, slot: each.slot, blockTime: each.time, memo: each.memo ? "[" + each.memo.length + "] " + each.memo : null, err: null }));
  let all = [...landed, funding];
  if (mode === "pruned") all = all.filter((each) => each.slot >= Number(process.env.STUB_PRUNED || h));
  const start = options.before ? all.findIndex((each) => each.signature === options.before) + 1 : 0;
  const stop = options.until ? all.findIndex((each) => each.signature === options.until) : -1;
  reply(all.slice(start, stop >= start ? stop : all.length).slice(0, options.limit));
} else if (body.method === "getTransaction") {
  const entry = read().landed.find((each) => each.sig === body.params[0]);
  if (process.env.STUB_HISTORY === "unreachable") process.exit(7);
  if (!entry) { reply(null); process.exit(0); }
  const from = entry.from ?? "Attacker11111111111111111111111111111111111";
  reply({
    meta: { err: null },
    transaction: { message: {
      accountKeys: [{ pubkey: from, signer: true, writable: true }, { pubkey: entry.to, signer: false, writable: true }],
      instructions: [
        { program: "system", parsed: { type: "transfer", info: { source: from, destination: entry.to, lamports: entry.lamports } } },
        ...(entry.memo ? [{ program: "spl-memo", parsed: entry.memo }] : []),
      ],
    } },
  });
} else {
  process.exit(22);
}
`;

export function world(issues: Issue[], created = new Date((NOW - 30 * DAY) * 1000).toISOString()) {
  const dir = mkdtempSync(join(tmpdir(), "faucet-world-"));
  const stateFile = join(dir, "state.json");
  const chainFile = join(dir, "chain.json");
  const log = join(dir, "calls.log");
  const issueCreated = new Date((NOW - DAY / 2) * 1000).toISOString().replace(".000", "");
  writeFileSync(stateFile, JSON.stringify({ created, issueCreated, issues }));
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
    FAUCET_FINALIZE: "0",
    GITHUB_RUN_ID: "1",
    ...extra,
  });
  const runEnv = (now: number, extra: Record<string, string>) => env({ FAUCET_NOW: String(now), ...extra });
  const script = (extra: Record<string, string>) => extra["FAUCET_SCRIPT"] ?? SCRIPT;
  return {
    dir,
    env,
    state: () => (JSON.parse(readFileSync(stateFile, "utf8")) as { issues: Issue[] }).issues,
    issue: (number: number) => (JSON.parse(readFileSync(stateFile, "utf8")) as { issues: Issue[] }).issues.find((each) => each.number === number),
    edit: (change: (issues: Issue[]) => void) => {
      const state = JSON.parse(readFileSync(stateFile, "utf8")) as { issues: Issue[] };
      change(state.issues);
      writeFileSync(stateFile, JSON.stringify(state));
    },
    landed: () => (JSON.parse(readFileSync(chainFile, "utf8")) as { landed: Landed[] }).landed,
    paid: () => (JSON.parse(readFileSync(chainFile, "utf8")) as { landed: Landed[] }).landed.filter((each) => each.from === PAYER),
    inject: (entries: Landed[]) => {
      const chain = JSON.parse(readFileSync(chainFile, "utf8")) as { landed: Landed[] };
      chain.landed.push(...entries);
      writeFileSync(chainFile, JSON.stringify(chain));
    },
    calls: () => readFileSync(log, "utf8").split("\n").filter((each) => each !== ""),
    run: (now: number, extra: Record<string, string> = {}): Run => {
      const result = spawnSync("bash", [script(extra)], { cwd: dir, encoding: "utf8", env: runEnv(now, extra), timeout: 120_000 });
      return { code: result.status ?? -1, out: result.stdout.trim(), err: result.stderr.trim() };
    },
    start: (now: number, extra: Record<string, string> = {}): Promise<Run> =>
      new Promise((resolve) => {
        const child = spawn("bash", [script(extra)], { cwd: dir, env: runEnv(now, extra) });
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

export const FUNDING = "F".repeat(64);
export const iso = (at: number) => new Date(at * 1000).toISOString().replace(".000", "");

export const record = (address: string, sig: string, slot: number, last: number, at = NOW, anchor = FUNDING) =>
  `Sending 0.5 devnet SOL to \`${address}\` from \`${PAYER}\` in transaction ${sig}, signed at ${iso(at)} after slot ${slot} and wallet transaction ${anchor}, valid until block height ${last}. The faucet checks this transaction before it sends again.`;

export const check = (sig: string, at: number) =>
  `No transfer from transaction ${sig} has landed as of ${iso(at)}. The faucet checks again at least 2 hours later before it sends anything new.`;

export const forged = (sig: string, memo: string, more: Partial<Landed> = {}) => ({ sig, to: PAYER, lamports: 0, slot: 2 * NOW - 10, time: NOW - 10, memo, ...more });

export const bodies = (faucet: ReturnType<typeof world>, number: number, start: string) =>
  (faucet.issue(number)?.comments ?? []).filter((c) => c.author === "github-actions" && c.body.startsWith(start)).map((c) => c.body);
export const answers = (faucet: ReturnType<typeof world>, number: number) => bodies(faucet, number, "Sent ");
export const records = (faucet: ReturnType<typeof world>, number: number) => bodies(faucet, number, "Sending ");
export const sends = (faucet: ReturnType<typeof world>) => faucet.calls().filter((c) => c.startsWith("solana transfer") && !c.includes(" --sign-only "));
