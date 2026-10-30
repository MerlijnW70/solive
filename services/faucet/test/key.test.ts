import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKeyPairSigner, getBase58Decoder, type Address } from "@solana/kit";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { drip } from "../src/drip.js";
import { faucetSigner } from "../src/secret.js";
import { harness, newFaucet, post, type Faucet, type Harness } from "./fake-node.js";

let faucet: Faucet;
let recipient: Address;

beforeAll(async () => {
  faucet = await newFaucet();
  recipient = (await generateKeyPairSigner()).address;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function forms(bytes: number[]): string[] {
  const seed = Uint8Array.from(bytes.slice(0, 32));
  const all = Uint8Array.from(bytes);
  return [
    JSON.stringify(bytes),
    bytes.join(","),
    bytes.slice(0, 32).join(","),
    bytes.slice(0, 32).join(", "),
    Buffer.from(seed).toString("hex"),
    Buffer.from(seed).toString("base64"),
    Buffer.from(all).toString("base64"),
    getBase58Decoder().decode(seed),
    getBase58Decoder().decode(all),
  ];
}

const scenarios: [string, (h: Harness) => void][] = [
  ["success", () => {}],
  ["wrong cluster", (h) => (h.node.genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d")],
  ["node down", (h) => h.node.failing.add("getBalance")],
  ["floor", (h) => h.node.balances.set(faucet.address, 1n)],
  ["send fails", (h) => h.node.failing.add("sendTransaction")],
  ["timeout", (h) => (h.node.statuses = () => null)],
  ["landed with error", (h) => (h.node.statuses = () => ({ confirmationStatus: "confirmed", err: { Custom: 1 } }))],
  ["blockhash fails", (h) => h.node.failing.add("getLatestBlockhash")],
];

describe("the faucet key never appears in a response or a log line", () => {
  for (const [name, setup] of scenarios) {
    it(`stays out of every output when ${name}`, async () => {
      const printed: string[] = [];
      for (const level of ["log", "error", "warn", "info", "debug", "trace"] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          printed.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg) ?? String(arg))).join(" "));
        });
      }
      const h = harness(faucet);
      setup(h);
      const response = await drip(post(recipient), h.deps);
      const output = [JSON.stringify(response), ...h.lines, ...printed].join("\n");
      for (const form of forms(faucet.bytes)) expect(output).not.toContain(form);
      expect(h.lines.length).toBeGreaterThan(0);
    });
  }

  it("stays out of a malformed key's outputs", async () => {
    const broken = faucet.secret.slice(0, -1);
    const printed: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void printed.push(args.join(" ")));
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void printed.push(args.join(" ")));
    const h = harness(faucet, { secret: broken });
    const response = await drip(post(recipient), h.deps);
    const output = [JSON.stringify(response), ...h.lines, ...printed].join("\n");
    expect(output).not.toContain(broken.slice(1, 40));
    expect(output).not.toContain(faucet.bytes.slice(0, 8).join(","));
  });

  it("builds a signer whose private key cannot be exported", async () => {
    const signer = await faucetSigner(faucet.secret);
    expect(signer?.address).toBe(faucet.address);
    expect(signer?.keyPair.privateKey.extractable).toBe(false);
    expect(JSON.stringify(signer)).not.toContain(faucet.bytes.slice(0, 8).join(","));
  });

  it("refuses a key whose public half does not match", async () => {
    const swapped = [...faucet.bytes.slice(0, 32), ...faucet.bytes.slice(0, 32)];
    expect(await faucetSigner(JSON.stringify(swapped))).toBeUndefined();
  });

  it("reads the key only through the request, with no file access in the service", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const sources = [
      ...readdirSync(root + "src").map((name) => readFileSync(root + "src/" + name, "utf8")),
      readFileSync(root + "api/drip.ts", "utf8"),
    ];
    for (const source of sources) {
      expect(source).not.toMatch(/node:fs|from "fs"|writeFile|appendFile|createWriteStream/);
    }
    const reads = sources.join("\n").match(/FAUCET_SECRET/g) ?? [];
    expect(reads).toHaveLength(1);
    expect(sources.join("\n")).toContain('secret: () => process.env["FAUCET_SECRET"]');
  });
});
