import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const PROGRAM = "GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU";
const RENT_SYSVAR = "SysvarRent111111111111111111111111111111111";
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PAUSE_MS = 1_500;
const TRIES = 8;
const BATCH = 100;

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const url = option("--url", "https://" + "api.devnet.solana.com");
const out = option("--out", "tests/svm/fixtures/devnet.json");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function rpc(method, params) {
  for (let attempt = 1; ; attempt++) {
    await sleep(PAUSE_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (response.ok) {
        const body = await response.json();
        if (body.error === undefined) {
          return body.result;
        }
        if (attempt >= TRIES) {
          throw new Error(`${method}: ${JSON.stringify(body.error)}`);
        }
      } else if (attempt >= TRIES) {
        throw new Error(`${method}: HTTP ${response.status}`);
      }
    } catch (error) {
      if (attempt >= TRIES) {
        throw error;
      }
    }
    await sleep(PAUSE_MS * 2 ** attempt);
  }
}

const decode58 = (text) => {
  let n = 0n;
  for (const c of text) {
    n = n * 58n + BigInt(ALPHABET.indexOf(c));
  }
  const bytes = [];
  for (; n > 0n; n >>= 8n) {
    bytes.unshift(Number(n & 0xffn));
  }
  const zeros = text.length - text.replace(/^1+/, "").length;
  return Buffer.from([...new Array(zeros).fill(0), ...bytes]);
};

const encode58 = (bytes) => {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let text = "";
  for (; n > 0n; n /= 58n) {
    text = ALPHABET[Number(n % 58n)] + text;
  }
  const zeros = bytes.findIndex((b) => b !== 0);
  return "1".repeat(zeros === -1 ? bytes.length : zeros) + text;
};

const P = 2n ** 255n - 19n;
const mod = (a) => ((a % P) + P) % P;
const pow = (base, exp) => {
  let result = 1n;
  for (let b = mod(base), e = exp; e > 0n; e >>= 1n, b = mod(b * b)) {
    if (e & 1n) {
      result = mod(result * b);
    }
  }
  return result;
};
const D = mod(-121665n * pow(121666n, P - 2n));

const onCurve = (bytes) => {
  const y = BigInt("0x" + Buffer.from(bytes).reverse().toString("hex")) & ((1n << 255n) - 1n);
  if (y >= P) {
    return false;
  }
  const u = mod(y * y - 1n);
  const v = mod(D * y * y + 1n);
  const x = mod(u * pow(v, 3n) * pow(mod(u * pow(v, 7n)), (P - 5n) / 8n));
  const check = mod(v * x * x);
  return check === u || check === mod(-u);
};

const findPda = (seeds, program) => {
  for (let bump = 255; bump >= 0; bump--) {
    const hash = createHash("sha256");
    for (const seed of [...seeds, Buffer.from([bump]), decode58(program), Buffer.from("ProgramDerivedAddress")]) {
      hash.update(seed);
    }
    const key = hash.digest();
    if (!onCurve(key)) {
      return encode58([...key]);
    }
  }
  throw new Error("no program address");
};

const INTENT_DISCRIMINATOR = createHash("sha256").update("account:Intent").digest().subarray(0, 8);
const INPUT_MINT_AT = 8 + 32;

const owned = await rpc("getProgramAccounts", [PROGRAM, { encoding: "base64", commitment: "confirmed", withContext: true }]);
const slot = owned.context.slot;
const time = await rpc("getBlockTime", [slot]).catch(() => null);
const accounts = owned.value
  .map(({ pubkey, account }) => ({ address: pubkey, lamports: account.lamports, data: account.data[0] }))
  .sort((a, b) => a.address.localeCompare(b.address));

const related = new Set();
for (const account of accounts) {
  const data = Buffer.from(account.data, "base64");
  if (data.subarray(0, 8).equals(INTENT_DISCRIMINATOR)) {
    related.add(findPda([Buffer.from("vault"), decode58(account.address)], PROGRAM));
    related.add(encode58([...data.subarray(INPUT_MINT_AT, INPUT_MINT_AT + 32)]));
  }
}

const wanted = [RENT_SYSVAR, ...[...related].sort()];
const found = [];
for (let at = 0; at < wanted.length; at += BATCH) {
  const chunk = wanted.slice(at, at + BATCH);
  const { value } = await rpc("getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed" }]);
  value.forEach((account, i) => {
    if (account !== null) {
      found.push({ address: chunk[i], owner: account.owner, lamports: account.lamports, data: account.data[0] });
    }
  });
}

const rent = found.find((account) => account.address === RENT_SYSVAR);
if (rent === undefined) {
  throw new Error("the rent sysvar is missing");
}
const tokens = found.filter((account) => TOKEN_PROGRAMS.includes(account.owner));
const fixture = { url, program: PROGRAM, slot, time, rent: rent.data, accounts, tokens };
writeFileSync(out, JSON.stringify(fixture, null, 1) + "\n");
console.log(`${out}: ${accounts.length} program accounts and ${tokens.length} token accounts and mints at slot ${slot}`);
