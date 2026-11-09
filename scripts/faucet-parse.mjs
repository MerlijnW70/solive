import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [mode, ...args] = process.argv.slice(2);
const arg = args[0] ?? "";
const KEY = "[1-9A-HJ-NP-Za-km-z]";
const SIGNATURE = new RegExp(`^${KEY}{64,88}$`);
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PAGE = 1000;
const MAX_PAGES = Number(process.env.FAUCET_SCAN_PAGES ?? 100);
const MAX_TAGGED = 50;
const out = (line) => process.stdout.write(`${line}\n`);
const stop = () => process.exit(1);

function keyBytes(text) {
  let value = 0n;
  for (const c of text) value = value * 58n + BigInt(ALPHABET.indexOf(c));
  let bytes = 0;
  for (; value > 0n; value >>= 8n) bytes += 1;
  for (const c of text) {
    if (c !== "1") break;
    bytes += 1;
  }
  return bytes;
}

function issue(view) {
  const mine = (view.comments ?? []).filter((c) => c.author?.login === process.env.BOT).map((c) => String(c.body ?? ""));
  const time = "(\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ)";
  if (mode === "records") {
    const pattern = new RegExp(
      `^Sending \\S+ devnet SOL to \`(${KEY}{32,44})\` from \`(${KEY}{32,44})\` in transaction (${KEY}{64,88}), signed at ${time} after slot (\\d{1,15}) and wallet transaction (${KEY}{64,88}), valid until block height (\\d{1,15})\\.`,
    );
    for (const body of mine) {
      const found = pattern.exec(body);
      const at = found ? Math.floor(Date.parse(found[4]) / 1000) : NaN;
      if (found && Number.isSafeInteger(at)) out([found[3], found[1], found[2], found[5], found[7], found[6], at].join(" "));
    }
  } else if (mode === "checks") {
    const pattern = new RegExp(`^No transfer from transaction (${KEY}{64,88}) has landed as of ${time}\\.`);
    for (const body of mine) {
      const found = pattern.exec(body);
      const at = found ? Math.floor(Date.parse(found[2]) / 1000) : NaN;
      if (found && Number.isSafeInteger(at)) out(`${found[1]} ${at}`);
    }
  } else if (mode === "markers") {
    const pattern = new RegExp(`^Transaction (${KEY}{64,88}) is on its way\\.$`);
    out([...new Set(mine.map((body) => pattern.exec(body.trim())?.[1]).filter(Boolean))].join(" "));
  } else if (mode === "parks") {
    const marks = mine.map((body) => /Retry after: (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)/.exec(body)?.[1]).filter((mark) => mark !== undefined && Number.isFinite(Date.parse(mark)));
    out(`${marks.length} ${marks.at(-1) ?? ""}`);
  } else if (mode === "labelled") {
    out((view.labels ?? []).some((label) => label.name === arg) ? "yes" : "no");
  } else if (mode === "said") {
    out(mine.some((body) => body.trim() === arg) ? "yes" : "no");
  } else if (mode === "facts") {
    const created = Math.floor(Date.parse(view.createdAt) / 1000);
    if (!Number.isSafeInteger(created)) stop();
    out(`${String(view.state).toLowerCase()} ${created}`);
  } else {
    stop();
  }
}

function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const text = execFileSync("curl", ["-sS", "--max-time", "30", "-H", "Content-Type: application/json", "-d", body, process.env.FAUCET_RPC], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  const reply = JSON.parse(text);
  if (reply.error !== undefined || !("result" in reply)) throw new Error(`${method} failed`);
  return reply.result;
}

function page(payer, options) {
  const entries = rpc("getSignaturesForAddress", [payer, { limit: PAGE, commitment: "finalized", ...options }]);
  if (!Array.isArray(entries)) throw new Error("not a list");
  for (const entry of entries) if (!SIGNATURE.test(String(entry?.signature)) || !Number.isSafeInteger(entry?.slot)) throw new Error("bad entry");
  return entries;
}

function verified(signature, payer, memo, lamports) {
  const tx = rpc("getTransaction", [signature, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
  const message = tx?.transaction?.message;
  if (tx?.meta?.err !== null || !Array.isArray(message?.accountKeys) || !Array.isArray(message?.instructions)) return undefined;
  const first = message.accountKeys[0];
  if (first?.pubkey !== payer || first?.signer !== true) return undefined;
  if (!message.instructions.some((ix) => ix?.program === "spl-memo" && ix.parsed === memo)) return undefined;
  const paid = message.instructions.find(
    (ix) => ix?.program === "system" && ix.parsed?.type === "transfer" && ix.parsed.info?.source === payer && typeof ix.parsed.info?.destination === "string" && ix.parsed.info?.lamports === lamports,
  );
  return paid?.parsed.info.destination;
}

function scan() {
  const [payer, until, since, floor, memo, lamports, wanted = "-"] = args;
  const want = new Set(wanted.split(",").filter((each) => each !== "-"));
  const base = floor === "-" ? {} : { minContextSlot: Number(floor) };
  const tag = new RegExp(`(^|; )\\[\\d+\\] ${memo.replace(/[^a-z0-9 ]/g, "")}($|;)`);
  const seen = [];
  const tagged = [];
  let covered = false;
  let complete = false;
  let before;
  for (let pages = 0; pages < MAX_PAGES && !covered && !complete; pages += 1) {
    const entries = page(payer, { ...base, ...(until === "-" ? {} : { until }), ...(before ? { before } : {}) });
    for (const entry of entries) {
      seen.push(entry);
      const early = since !== "-" && Number.isSafeInteger(entry.blockTime) && entry.blockTime < Number(since);
      if (entry.err === null && !early && typeof entry.memo === "string" && tag.test(entry.memo)) tagged.push(entry.signature);
      if (early) covered = true;
    }
    complete = entries.length < PAGE;
    before = entries.at(-1)?.signature ?? before;
  }
  if (until !== "-" && complete) {
    const next = page(payer, { ...base, limit: 1, ...(before ? { before } : {}) });
    covered = next.length === 1 && next[0].signature === until;
  }
  const checked = tagged.slice(-MAX_TAGGED);
  const hits = checked.map((signature) => [signature, verified(signature, payer, memo, Number(lamports))]).filter(([, to]) => to !== undefined);
  out(`state ${covered ? "covered" : "short"}`);
  if (tagged.length > checked.length) out(`over ${tagged.length - checked.length}`);
  for (const entry of seen) if (want.has(entry.signature)) out(`seen ${entry.signature} ${entry.err === null ? 0 : 1}`);
  for (const [signature, to] of hits) out(`hit ${signature} ${to}`);
}

function chain(reply) {
  if (mode === "status") {
    const failed = reply?.err !== undefined && reply?.err !== null;
    out(reply?.confirmationStatus === "finalized" ? (failed ? "failed" : "landed") : "unknown");
  } else if (mode === "latest") {
    const value = reply?.result?.value;
    const slot = reply?.result?.context?.slot;
    const valid = value?.lastValidBlockHeight;
    if (!new RegExp(`^${KEY}{32,44}$`).test(String(value?.blockhash)) || !Number.isSafeInteger(valid) || !Number.isSafeInteger(slot) || valid < 150 || slot < 0) stop();
    out(`${value.blockhash} ${valid} ${slot}`);
  } else if (mode === "signer") {
    const signers = reply?.signers;
    const found = Array.isArray(signers) && signers.length === 1 ? new RegExp(`^(${KEY}{32,44})=(${KEY}{64,88})$`).exec(signers[0]) : null;
    if (!found) stop();
    out(`${found[1]} ${found[2]}`);
  } else {
    issue(reply);
  }
}

if (mode === "key-bytes") {
  out(String(keyBytes(arg)));
} else if (mode === "scan") {
  try {
    scan();
  } catch {
    out("state error");
  }
} else if (mode === "newest") {
  try {
    const entries = page(arg, { limit: 1 });
    if (entries.length !== 1) stop();
    out(entries[0].signature);
  } catch {
    stop();
  }
} else {
  let reply;
  try {
    reply = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    if (mode === "status") out("unknown");
    else stop();
    process.exit(0);
  }
  chain(reply);
}
