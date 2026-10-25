import { getBase58Decoder, getBase64Decoder, getBase64Encoder } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import type { Transport } from "@intent-engine/client";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultWallet } from "../../src/wallet.js";
import { h, HOME, transport, world } from "../harness.js";
import { connect, ok, preset } from "../agent-wallet-kit.js";

type Seen = { where: string; value: unknown };

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function encodings(secret: Uint8Array): string[] {
  const seed = secret.subarray(0, 32);
  return [secret, seed].flatMap((bytes) => [
    JSON.stringify([...bytes]).slice(1, -1),
    hex(bytes),
    getBase58Decoder().decode(bytes),
    getBase64Decoder().decode(bytes),
    Buffer.from(bytes).toString("base64url"),
  ]);
}

const holds = (haystack: Uint8Array, needle: Uint8Array) => {
  for (let at = 0; at + needle.length <= haystack.length; at++) {
    if (needle.every((b, i) => haystack[at + i] === b)) {
      return true;
    }
  }
  return false;
};

function decodedBase64(text: string): Uint8Array | null {
  if (text.length < 44 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    return null;
  }
  try {
    return Uint8Array.from(getBase64Encoder().encode(text));
  } catch {
    return null;
  }
}

function leaks(value: unknown, secret: Uint8Array, texts: string[], depth = 0): boolean {
  const seed = secret.subarray(0, 32);
  if (depth > 12 || value === null || value === undefined) {
    return false;
  }
  if (value instanceof Uint8Array) {
    return holds(value, seed);
  }
  if (typeof value === "string") {
    const bytes = decodedBase64(value);
    return texts.some((text) => value.includes(text)) || (bytes !== null && holds(bytes, seed));
  }
  if (Array.isArray(value)) {
    const numbers = value.every((v) => typeof v === "number");
    return (numbers && holds(Uint8Array.from(value as number[]), seed)) || value.some((v) => leaks(v, secret, texts, depth + 1));
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((v) => leaks(v, secret, texts, depth + 1));
  }
  return false;
}

function recording(seen: Seen[]): Transport {
  return new Proxy(transport, {
    get(target, key, receiver) {
      const held = Reflect.get(target, key, receiver) as unknown;
      if (typeof held !== "function") {
        return held;
      }
      return (...args: unknown[]) => {
        seen.push({ where: `rpc ${String(key)}`, value: args });
        return (held as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

describe("CAT incident keys: Slope, DEXX, Solareum and Thunder Terminal against the MCP wallet", () => {
  const seen: Seen[] = [];
  let client: Client;
  let secret: Uint8Array;

  beforeAll(async () => {
    await world();
    h.files.clear();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    h.through = recording(seen);
    client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    const made = await ok(client, "wallet_setup");
    seen.push({ where: "wallet_setup", value: made });
    const saved = h.files.get(defaultWallet(HOME));
    if (saved === undefined) {
      throw new Error("the wallet saved no key file");
    }
    secret = Uint8Array.from(JSON.parse(saved) as number[]);
    expect(secret).toHaveLength(64);
    const steps: [string, object][] = [
      ["wallet_setup", {}],
      ["wallet_balance", {}],
      ["wallet_swap", { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5", exact: true }],
      ["wallet_swap", { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5", exact: true, send: true }],
      ["wallet_intents", {}],
      ["wallet_cancel", { nonce: "0", send: true }],
      ["wallet_escrow", { sell: "SOL", amount: "0.05", attestor: made["address"], min_result: "1", max_result: "1", spec_hash: "ab".repeat(32), send: true }],
      ["wallet_history", {}],
    ];
    for (const [name, args] of steps) {
      seen.push({ where: name, value: await ok(client, name, args) });
    }
  });

  it("CAT Slope: no byte of the wallet's key reaches the node, a transaction, a fetch or any tool's answer", () => {
    const texts = encodings(secret);
    const wires = [...h.submitted, ...h.wires].map((wire) => ({ where: "wire", value: wire }));
    const fetched = h.fetched.map((f) => ({ where: `fetch ${f.url}`, value: f }));
    const everything = [...seen, ...wires, ...fetched];
    expect(seen.filter((s) => s.where.startsWith("rpc ")).length).toBeGreaterThan(10);
    expect(h.submitted.length + h.wires.length).toBeGreaterThan(0);
    expect(everything.filter((s) => leaks(s.value, secret, texts)).map((s) => s.where)).toEqual([]);
    expect(leaks({ planted: hex(secret.subarray(0, 32)) }, secret, texts)).toBe(true);
    expect(leaks([{ ix: secret.slice(0, 40) }], secret, texts)).toBe(true);
  });

  it("CAT DEXX: no wallet tool exports, shows or returns the key", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(20);
    expect(tools.map((t) => t.name).filter((name) => /export|reveal|secret|private|seed|mnemonic|keypair/i.test(name))).toEqual([]);
    const fields = (value: unknown): string[] =>
      value !== null && typeof value === "object" ? Object.entries(value).flatMap(([k, v]) => [k, ...fields(v)]) : [];
    const answered = seen.filter((s) => !s.where.startsWith("rpc ")).flatMap((s) => fields(s.value));
    expect(answered.filter((k) => /secret|private|seed|mnemonic/i.test(k))).toEqual([]);
  });

  it("CAT Solareum and Thunder Terminal: no tool takes a key as input, so no key is handed to a hosted bot or database", async () => {
    const { tools } = await client.listTools();
    const inputs = tools.flatMap((t) => Object.keys((t.inputSchema.properties ?? {}) as Record<string, unknown>).map((p) => `${t.name}.${p}`));
    expect(inputs.length).toBeGreaterThan(40);
    expect(inputs.filter((p) => /secret|private|mnemonic|keypair|seed_?phrase|\.seed$/i.test(p))).toEqual([]);    expect(h.files.get(defaultWallet(HOME))).toBe(JSON.stringify([...secret]));
  });
});
