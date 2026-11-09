import { readFileSync } from "node:fs";

const [mode, arg = ""] = process.argv.slice(2);
const KEY = "[1-9A-HJ-NP-Za-km-z]";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
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
  if (mode === "records") {
    const pattern = new RegExp(`^Sending \\S+ devnet SOL to \`(${KEY}{32,44})\` from \`(${KEY}{32,44})\` in transaction (${KEY}{64,88}), signed after slot (\\d{1,15}) and valid until block height (\\d{1,15})\\.`);
    for (const body of mine) {
      const found = pattern.exec(body);
      if (found) out([found[3], found[1], found[2], found[4], found[5]].join(" "));
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

function history(reply) {
  const page = reply?.result;
  if (reply?.error !== undefined || !Array.isArray(page)) return out("error");
  const tag = new RegExp(`(^|; )\\[\\d+\\] ${arg.replace(/[^a-z0-9 ]/g, "")}($|;)`);
  const lines = [];
  for (const entry of page) {
    if (!new RegExp(`^${KEY}{64,88}$`).test(String(entry?.signature)) || !Number.isSafeInteger(entry?.slot)) return out("error");
    const time = Number.isSafeInteger(entry.blockTime) ? entry.blockTime : -1;
    const hit = typeof entry.memo === "string" && tag.test(entry.memo) ? 1 : 0;
    lines.push(["entry", entry.signature, entry.slot, time, entry.err === null ? 0 : 1, hit].join(" "));
  }
  for (const line of lines) out(line);
  out(`${page.length} ${page.at(-1)?.signature ?? "-"}`);
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
  } else if (mode === "history") {
    history(reply);
  } else {
    issue(reply);
  }
}

if (mode === "key-bytes") {
  out(String(keyBytes(arg)));
} else {
  let reply;
  try {
    reply = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    if (mode === "status" || mode === "history") out(mode === "status" ? "unknown" : "error");
    else stop();
    process.exit(0);
  }
  chain(reply);
}
