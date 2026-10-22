import { parseArgs } from "node:util";
import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  isAddress,
  isTransactionWithinSizeLimit,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionPartialSigner,
} from "@solana/kit";
import type { Chain } from "./chain.js";
import { jsonText } from "./engine.js";
import { isDevice, isLedgerPath, LEDGER_FORMS, LedgerError, LedgerPathError, messageHash, parseLedgerPath } from "./ledger.js";
import { show } from "./show.js";
import {
  approve,
  createMultisig,
  ENGINE_PROGRAM,
  execute,
  type Plan,
  proposeAuthority,
  proposeInstructions,
  proposeTimeLock,
  proposeUpgrade,
  Refusal,
  reject,
} from "./squads.js";
import { vault } from "./vault.js";

export type Deps = {
  chain(url: string): Chain;
  keypair(path: string): Promise<TransactionPartialSigner>;
  run(argv: string[]): Promise<string>;
  notify?(text: string): void;
};

type Notify = (text: string) => void;

export type Result = { code: number; out: string; err: string };

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;
export const DEVNET = "https://api.devnet.solana.com";
export const NOT_SENT = "nothing was sent; check the summary and pass --yes to sign and send";
export const MAX_TIME_LOCK = 7_776_000;

export const USAGE = [
  "intent-engine-multisig create --members <a,b,c> --threshold <n> [--time-lock <seconds>] [--create-key <keypair>] --keypair <creator> [--yes]",
  "intent-engine-multisig propose-upgrade --multisig <m> --buffer <address> --spill <address> [--program <address>] --keypair <member> [--yes]",
  "intent-engine-multisig propose-admin --multisig <m> --keypair <member> [--yes] -- <intent engine admin command with --authority <vault>>",
  "intent-engine-multisig propose-time-lock --multisig <m> --seconds <n> --keypair <member> [--yes]",
  "intent-engine-multisig approve --multisig <m> --index <n> [--allow-config] --keypair <member> [--yes]",
  "intent-engine-multisig execute --multisig <m> --index <n> [--expect-buffer-hash <hex>] [--allow-config] --keypair <member> [--yes]",
  "intent-engine-multisig reject --multisig <m> --index <n> --keypair <member> [--yes]",
  "intent-engine-multisig show --multisig <m> [--index <n>]",
  "intent-engine-multisig vault --multisig <m>",
  "intent-engine-multisig propose-authority --multisig <m> --new-authority <address> [--program <address>] --keypair <member> [--yes]",
  "every command takes --url devnet|testnet|mainnet-beta|localhost|<rpc url>, default devnet",
  `--keypair and --create-key take a keypair file or a Ledger: ${LEDGER_FORMS.join(", ")}`,
];

class UsageError extends Error {}

const OPTIONS = {
  url: { type: "string" },
  keypair: { type: "string" },
  yes: { type: "boolean" },
  multisig: { type: "string" },
  index: { type: "string" },
  members: { type: "string" },
  threshold: { type: "string" },
  "time-lock": { type: "string" },
  seconds: { type: "string" },
  "create-key": { type: "string" },
  buffer: { type: "string" },
  spill: { type: "string" },
  program: { type: "string" },
  "new-authority": { type: "string" },
  "allow-config": { type: "boolean" },
  "expect-buffer-hash": { type: "string" },
} as const;

type Values = { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string };

type Flag = "yes" | "allow-config";

const required = (values: Values, name: Exclude<keyof Values, Flag>): string => {
  const value = values[name];
  if (value === undefined || value === "") {
    throw new UsageError(`this command needs --${name}`);
  }
  return value;
};

function address(text: string, name: string): Address {
  const trimmed = text.trim();
  if (!isAddress(trimmed)) {
    throw new UsageError(`--${name} takes a base58 address, not ${text}`);
  }
  return trimmed;
}

const key = (values: Values, name: Exclude<keyof Values, Flag>) => address(required(values, name), name);

function whole(text: string, name: string, min: number, max: number): number {
  const value = Number(text);
  if (!/^\d+$/.test(text) || value < min || value > max) {
    throw new UsageError(`--${name} takes a whole number from ${min} to ${max}, not ${text}`);
  }
  return value;
}

function indexOf(values: Values): bigint {
  const text = required(values, "index");
  if (!/^[1-9]\d{0,18}$/.test(text)) {
    throw new UsageError(`--index takes a proposal number from 1, not ${text}`);
  }
  return BigInt(text);
}

const MONIKERS: Record<string, string> = {
  devnet: DEVNET,
  testnet: "https://api.testnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  localhost: "http://127.0.0.1:8899",
};

type Cluster = { url: string; shown: string };

const NOT_A_URL = `--url takes ${Object.keys(MONIKERS).join(", ")} or an http or https RPC url`;

function cluster(given: string): Cluster {
  const url = MONIKERS[given] ?? given;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(NOT_A_URL);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UsageError(NOT_A_URL);
  }
  return { url, shown: [parsed.protocol, "", parsed.host].join("/") };
}

function hashes(values: Values): string[] {
  const given = values["expect-buffer-hash"];
  if (given === undefined) {
    return [];
  }
  const list = given.split(",").map((h) => h.trim().toLowerCase());
  if (list.some((h) => !/^[0-9a-f]{64}$/.test(h))) {
    throw new UsageError(`--expect-buffer-hash takes the 64 hex digit sha256 that approve printed as buffer_hash, not ${given}`);
  }
  return list;
}

type Signable = Parameters<TransactionPartialSigner["signTransactions"]>[0][number];

async function transaction(chain: Chain, payer: TransactionPartialSigner, plan: Plan): Promise<Signable> {
  const latest = await chain.blockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(plan.instructions, m),
  );
  const compiled = compileTransaction(message);
  if (!isTransactionWithinSizeLimit(compiled)) {
    throw new Refusal("the transaction is larger than a Solana transaction may be; nothing was signed or sent");
  }
  return compiled;
}

async function signWith(signers: TransactionPartialSigner[], unsigned: Signable): Promise<Signable> {
  let tx = unsigned;
  for (const signer of signers) {
    const [signatures] = await signer.signTransactions([tx]);
    tx = Object.freeze({ ...tx, signatures: Object.freeze({ ...tx.signatures, ...signatures }) });
  }
  return tx;
}

const deviceNotice = (summary: string[], hash: string, devices: string[]): string =>
  [
    ...summary,
    `message hash: ${hash}`,
    `${devices.join(" and ")} will ask to sign a message hash: compare it with ${hash} on the device screen and press approve only if it matches`,
    "",
  ].join("\n");

async function deliver(chain: Chain, url: Cluster, payer: TransactionPartialSigner, plan: Plan, yes: boolean, notify: Notify): Promise<object> {
  const unsigned = await transaction(chain, payer, plan);
  const signers = [payer, ...plan.signers.filter((s) => s.address !== payer.address)];
  const devices = signers.filter(isDevice);
  const hash = messageHash(new Uint8Array(unsigned.messageBytes));
  const shown = { cluster: url.shown, ...plan.details, summary: plan.summary, message_hash: hash };
  if (!yes) {
    const tx = await signWith(signers.filter((s) => !isDevice(s)), unsigned);
    const simulated = await chain.simulate(tx);
    return {
      ...shown,
      sent: false,
      simulation: simulated.err === null ? "ok" : simulated.err,
      ...(simulated.err === null ? {} : { logs: simulated.logs.slice(-20) }),
      next: NOT_SENT,
    };
  }
  if (devices.length > 0) {
    notify(deviceNotice(plan.summary, hash, devices.map((d) => d.device)));
  }
  const tx = await signWith(signers, unsigned);
  await plan.recheck?.();
  return { ...shown, sent: true, signature: await chain.send(tx) };
}

function keyPath(path: string, name: "keypair" | "create-key"): string {
  if (isLedgerPath(path)) {
    try {
      parseLedgerPath(path);
    } catch (error) {
      throw new UsageError(`--${name} ${error instanceof LedgerPathError ? error.message : String(error)}`);
    }
  }
  return path;
}

async function command(name: string | undefined, values: Values, passed: string[], deps: Deps, notify: Notify): Promise<object> {
  const target = cluster(values.url ?? DEVNET);
  const { url } = target;
  const yes = values.yes === true;
  const signer = async () => deps.keypair(keyPath(required(values, "keypair"), "keypair"));
  switch (name) {
    case "create": {
      const creator = await signer();
      const members = required(values, "members")
        .split(",")
        .map((m) => address(m, "members"));
      const createKey = values["create-key"] === undefined ? creator : await deps.keypair(keyPath(values["create-key"], "create-key"));
      const plan = await createMultisig(deps.chain(url), {
        creator: creator.address,
        createKey,
        members,
        threshold: whole(required(values, "threshold"), "threshold", 1, members.length),
        timeLock: values["time-lock"] === undefined ? 0 : whole(values["time-lock"], "time-lock", 0, MAX_TIME_LOCK),
      });
      return deliver(deps.chain(url), target, creator, plan, yes, notify);
    }
    case "propose-upgrade": {
      const member = await signer();
      const chain = deps.chain(url);
      const plan = await proposeUpgrade(chain, {
        multisig: key(values, "multisig"),
        member: member.address,
        program: values.program === undefined ? ENGINE_PROGRAM : key(values, "program"),
        buffer: key(values, "buffer"),
        spill: key(values, "spill"),
      });
      return deliver(chain, target, member, plan, yes, notify);
    }
    case "propose-authority": {
      const member = await signer();
      const chain = deps.chain(url);
      const plan = await proposeAuthority(chain, {
        multisig: key(values, "multisig"),
        member: member.address,
        program: values.program === undefined ? ENGINE_PROGRAM : key(values, "program"),
        next: key(values, "new-authority"),
      });
      return deliver(chain, target, member, plan, yes, notify);
    }
    case "propose-time-lock": {
      const multisig = key(values, "multisig");
      const seconds = whole(required(values, "seconds"), "seconds", 0, MAX_TIME_LOCK);
      const member = await signer();
      const chain = deps.chain(url);
      const plan = await proposeTimeLock(chain, { multisig, member: member.address, seconds });
      return deliver(chain, target, member, plan, yes, notify);
    }
    case "propose-admin": {
      if (passed.length === 0) {
        throw new UsageError("propose-admin runs the intent engine admin command given after --, with --authority <vault>");
      }
      const multisig = key(values, "multisig");
      const member = await signer();
      const stdout = await deps.run(passed);
      const chain = deps.chain(url);
      const plan = await proposeInstructions(chain, { multisig, member: member.address, stdout });
      return deliver(chain, target, member, { ...plan, details: { command: passed, ...plan.details } }, yes, notify);
    }
    case "approve":
    case "execute":
    case "reject": {
      const expectBufferHashes = hashes(values);
      if (name !== "execute" && expectBufferHashes.length > 0) {
        throw new UsageError("only execute takes --expect-buffer-hash");
      }
      if (name === "reject" && values["allow-config"] !== undefined) {
        throw new UsageError("reject takes no --allow-config");
      }
      const member = await signer();
      const chain = deps.chain(url);
      const input = { multisig: key(values, "multisig"), member: member.address, index: indexOf(values) };
      const allowConfig = values["allow-config"] === true;
      const plan =
        name === "approve"
          ? await approve(chain, { ...input, allowConfig })
          : name === "execute"
            ? await execute(chain, { ...input, allowConfig, expectBufferHashes })
            : await reject(chain, input);
      return deliver(chain, target, member, plan, yes, notify);
    }
    case "show": {
      if (values.yes !== undefined || values.keypair !== undefined || values["allow-config"] !== undefined || values["expect-buffer-hash"] !== undefined) {
        throw new UsageError("show only reads; it takes no --keypair, --yes, --allow-config or --expect-buffer-hash");
      }
      return show(deps.chain(url), key(values, "multisig"), values.index === undefined ? undefined : indexOf(values));
    }
    case "vault": {
      if (values.yes !== undefined || values.keypair !== undefined || values["allow-config"] !== undefined || values["expect-buffer-hash"] !== undefined || values.index !== undefined) {
        throw new UsageError("vault only reads the multisig; it takes no --keypair, --yes, --index, --allow-config or --expect-buffer-hash");
      }
      return vault(deps.chain(url), key(values, "multisig"));
    }
    default:
      throw new UsageError(name === undefined ? "name a command" : `unknown command ${name}`);
  }
}

export async function main(argv: string[], deps: Deps): Promise<Result> {
  const split = argv.indexOf("--");
  const own = split === -1 ? argv : argv.slice(0, split);
  const passed = split === -1 ? [] : argv.slice(split + 1);
  const notes: string[] = [];
  const notify: Notify = deps.notify === undefined ? (text) => notes.push(text) : (text) => deps.notify?.(text);
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: own, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    const [name, ...extra] = parsed.positionals;
    if (extra.length > 0) {
      throw new UsageError(`unexpected ${extra.join(" ")}`);
    }
    if (split !== -1 && name !== "propose-admin") {
      throw new UsageError("only propose-admin takes a command after --");
    }
    const out = await command(name, parsed.values as Values, passed, deps, notify);
    return { code: EXIT_OK, out: `${jsonText(out, 2)}\n`, err: notes.join("") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UsageError) {
      return { code: EXIT_USAGE, out: "", err: `${notes.join("")}${jsonText({ error: message, usage: USAGE })}\n` };
    }
    const shown = error instanceof Refusal && error.shown !== undefined ? error.shown : {};
    return { code: EXIT_REFUSED, out: "", err: `${notes.join("")}${jsonText({ error: message, refused: error instanceof Refusal || error instanceof LedgerError, ...shown })}\n` };
  }
}
