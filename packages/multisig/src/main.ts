import { parseArgs } from "node:util";
import { type Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { Chain } from "./chain.js";
import { jsonText } from "./engine.js";
import { show } from "./show.js";
import { approve, createMultisig, ENGINE_PROGRAM, execute, type Plan, proposeAuthority, proposeInstructions, proposeUpgrade, Refusal } from "./squads.js";

export type Deps = {
  chain(url: string): Chain;
  keypair(path: string): Promise<Keypair>;
  run(argv: string[]): Promise<string>;
};

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
  "intent-engine-multisig approve --multisig <m> --index <n> --keypair <member> [--yes]",
  "intent-engine-multisig execute --multisig <m> --index <n> --keypair <member> [--yes]",
  "intent-engine-multisig show --multisig <m> [--index <n>]",
  "intent-engine-multisig propose-authority --multisig <m> --new-authority <address> [--program <address>] --keypair <member> [--yes]",
  "every command takes --url devnet|testnet|mainnet-beta|localhost|<rpc url>, default devnet",
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
  "create-key": { type: "string" },
  buffer: { type: "string" },
  spill: { type: "string" },
  program: { type: "string" },
  "new-authority": { type: "string" },
} as const;

type Values = { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string };

const required = (values: Values, name: Exclude<keyof Values, "yes">): string => {
  const value = values[name];
  if (value === undefined || value === "") {
    throw new UsageError(`this command needs --${name}`);
  }
  return value;
};

function address(text: string, name: string): PublicKey {
  try {
    return new PublicKey(text.trim());
  } catch {
    throw new UsageError(`--${name} takes a base58 address, not ${text}`);
  }
}

const key = (values: Values, name: Exclude<keyof Values, "yes">) => address(required(values, name), name);

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

function cluster(given: string): string {
  const url = MONIKERS[given] ?? given;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`--url takes an http or https RPC url, not ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UsageError(`--url takes an http or https RPC url, not ${url}`);
  }
  return `${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname}`;
}

async function transaction(chain: Chain, payer: Keypair, plan: Plan): Promise<VersionedTransaction> {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: await chain.blockhash(),
    instructions: plan.instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const signers = [payer, ...plan.signers.filter((s) => !s.publicKey.equals(payer.publicKey))];
  tx.sign(signers);
  return tx;
}

async function deliver(chain: Chain, url: string, payer: Keypair, plan: Plan, yes: boolean): Promise<object> {
  const tx = await transaction(chain, payer, plan);
  const shown = { cluster: url, ...plan.details, summary: plan.summary };
  if (!yes) {
    const simulated = await chain.simulate(tx);
    return {
      ...shown,
      sent: false,
      simulation: simulated.err === null ? "ok" : simulated.err,
      ...(simulated.err === null ? {} : { logs: simulated.logs.slice(-20) }),
      next: NOT_SENT,
    };
  }
  return { ...shown, sent: true, signature: await chain.send(tx) };
}

async function command(name: string | undefined, values: Values, passed: string[], deps: Deps): Promise<object> {
  const url = cluster(values.url ?? DEVNET);
  const yes = values.yes === true;
  const signer = async () => deps.keypair(required(values, "keypair"));
  switch (name) {
    case "create": {
      const creator = await signer();
      const members = required(values, "members")
        .split(",")
        .map((m) => address(m, "members"));
      const createKey = values["create-key"] === undefined ? creator : await deps.keypair(values["create-key"]);
      const plan = await createMultisig(deps.chain(url), {
        creator: creator.publicKey,
        createKey,
        members,
        threshold: whole(required(values, "threshold"), "threshold", 1, members.length),
        timeLock: values["time-lock"] === undefined ? 0 : whole(values["time-lock"], "time-lock", 0, MAX_TIME_LOCK),
      });
      return deliver(deps.chain(url), url, creator, plan, yes);
    }
    case "propose-upgrade": {
      const member = await signer();
      const chain = deps.chain(url);
      const plan = await proposeUpgrade(chain, {
        multisig: key(values, "multisig"),
        member: member.publicKey,
        program: values.program === undefined ? ENGINE_PROGRAM : key(values, "program"),
        buffer: key(values, "buffer"),
        spill: key(values, "spill"),
      });
      return deliver(chain, url, member, plan, yes);
    }
    case "propose-authority": {
      const member = await signer();
      const chain = deps.chain(url);
      const plan = await proposeAuthority(chain, {
        multisig: key(values, "multisig"),
        member: member.publicKey,
        program: values.program === undefined ? ENGINE_PROGRAM : key(values, "program"),
        next: key(values, "new-authority"),
      });
      return deliver(chain, url, member, plan, yes);
    }
    case "propose-admin": {
      if (passed.length === 0) {
        throw new UsageError("propose-admin runs the intent engine admin command given after --, with --authority <vault>");
      }
      const multisig = key(values, "multisig");
      const member = await signer();
      const stdout = await deps.run(passed);
      const chain = deps.chain(url);
      const plan = await proposeInstructions(chain, { multisig, member: member.publicKey, stdout });
      return deliver(chain, url, member, { ...plan, details: { command: passed, ...plan.details } }, yes);
    }
    case "approve":
    case "execute": {
      const member = await signer();
      const chain = deps.chain(url);
      const input = { multisig: key(values, "multisig"), member: member.publicKey, index: indexOf(values) };
      const plan = name === "approve" ? await approve(chain, input) : await execute(chain, input);
      return deliver(chain, url, member, plan, yes);
    }
    case "show": {
      if (values.yes !== undefined || values.keypair !== undefined) {
        throw new UsageError("show only reads; it takes no --keypair or --yes");
      }
      return show(deps.chain(url), key(values, "multisig"), values.index === undefined ? undefined : indexOf(values));
    }
    default:
      throw new UsageError(name === undefined ? "name a command" : `unknown command ${name}`);
  }
}

export async function main(argv: string[], deps: Deps): Promise<Result> {
  const split = argv.indexOf("--");
  const own = split === -1 ? argv : argv.slice(0, split);
  const passed = split === -1 ? [] : argv.slice(split + 1);
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
    const out = await command(name, parsed.values as Values, passed, deps);
    return { code: EXIT_OK, out: `${jsonText(out, 2)}\n`, err: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UsageError) {
      return { code: EXIT_USAGE, out: "", err: `${jsonText({ error: message, usage: USAGE })}\n` };
    }
    return { code: EXIT_REFUSED, out: "", err: `${jsonText({ error: message, refused: error instanceof Refusal })}\n` };
  }
}
