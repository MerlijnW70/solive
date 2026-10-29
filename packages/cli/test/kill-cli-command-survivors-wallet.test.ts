import { generateKeyPairSigner, type Address, type KeyPairSigner, lamports } from "@solana/kit";
import { formatAmount } from "@intent-engine/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLUSTERS } from "../src/args.js";
import { FlowRefused } from "../src/flows.js";
import type { Launched } from "../src/launch.js";
import { EXIT_OK, main } from "../src/main.js";
import { belowRent, newWallet, walletExists } from "../src/wallet-commands.js";
import { CLI_SMALL_START, CLI_START, ENOUGH_TO_START, FUND_BELOW, holdsEnough, refusedEnough, SWAP_START } from "../src/wallet.js";
import { cli, h, runtime, world, type World } from "./harness.js";
import { NPM_REGISTRY } from "../src/npm-registry.js";

const SIGNED_IN: Launched = { code: 0, output: "Logged in to github.com" };
const HTTPS: Launched = { code: 0, output: `${NPM_REGISTRY}\n` };
const sol = (amount: bigint) => formatAmount(amount, 9);

async function run(argv: string[], replies: Launched[] = []) {
  const launched: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const rt = {
    ...runtime({}),
    launch: async (program: string, args: readonly string[]) => {
      if (program === "npm") {
        return HTTPS;
      }
      launched.push([program, ...args]);
      const reply = replies.shift();
      if (reply === undefined) {
        throw new Error("no reply for " + program);
      }
      return reply;
    },
  };
  const code = await main(argv, rt, { out: (t) => out.push(t), err: (t) => err.push(t) }).finally(() => stderr.mockRestore());
  return { code, launched, err: err.join("\n"), json: () => JSON.parse(out.join("\n")) as Record<string, unknown> };
}

describe("setup thresholds", () => {
  beforeEach(async () => {
    await world();
    h.airdropRefused = true;
  });

  it("asks devnet for no airdrop when the wallet holds exactly the funding floor", async () => {
    const address = (await run(["setup"])).json()["address"] as Address;
    h.svm.airdrop(address, lamports(FUND_BELOW));
    h.airdrops.length = 0;
    const held = (await run(["setup"])).json();
    expect(h.airdrops).toStrictEqual([]);
    expect(held).toMatchObject({ sol: sol(FUND_BELOW), next: holdsEnough(sol(FUND_BELOW), CLI_START) });
  });

  it("asks for an airdrop one lamport below the funding floor", async () => {
    const address = (await run(["setup"])).json()["address"] as Address;
    h.svm.airdrop(address, lamports(FUND_BELOW - 1n));
    h.airdrops.length = 0;
    await run(["setup"]);
    expect(h.airdrops.length).toBeGreaterThan(0);
  });

  it("does not call a mainnet wallet at the funding floor unfunded", async () => {
    const keypair = ["--url", "mainnet-beta", "--keypair", "main.json"];
    const address = (await run(["setup", ...keypair])).json()["address"] as Address;
    h.svm.airdrop(address, lamports(FUND_BELOW));
    const held = (await run(["setup", ...keypair])).json();
    expect(held["url"]).toBe(CLUSTERS["mainnet-beta"]);
    expect(held["next"]).toBe(holdsEnough(sol(FUND_BELOW), CLI_START));
  });

  it("offers the starter swap hint from the exact amount that pays for it", async () => {
    const address = (await run(["setup"])).json()["address"] as Address;
    h.svm.airdrop(address, lamports(SWAP_START - 1n));
    expect((await run(["setup"])).json()["next"]).toBe(refusedEnough(sol(SWAP_START - 1n), CLI_SMALL_START));
    h.svm.airdrop(address, lamports(1n));
    expect((await run(["setup"])).json()["next"]).toBe(refusedEnough(sol(SWAP_START), CLI_START));
  });
});

describe("setup --faucet thresholds", () => {
  beforeEach(async () => {
    await world();
    h.airdropRefused = true;
  });

  it("files nothing for a wallet at exactly enough to start", async () => {
    const address = (await run(["setup"])).json()["address"] as Address;
    h.svm.airdrop(address, lamports(ENOUGH_TO_START));
    const ran = await run(["setup", "--faucet"]);
    expect([ran.code, ran.err, ran.launched]).toStrictEqual([EXIT_OK, "", []]);
    expect(ran.json()["next"]).toBe(refusedEnough(sol(ENOUGH_TO_START), CLI_SMALL_START));
  });

  it("stops waiting for the faucet the moment the wallet holds exactly enough to start", async () => {
    const address = (await run(["setup"])).json()["address"] as Address;
    h.rounds = 5;
    h.onSleep.push(() => h.svm.airdrop(address, lamports(ENOUGH_TO_START)));
    const ran = await run(["setup", "--faucet"], [SIGNED_IN, { code: 0, output: "https://" + "example.org/issues/1\n" }]);
    expect(ran.code).toBe(EXIT_OK);
    expect(h.sleeps).toHaveLength(1);
    expect(ran.json()["sol"]).toBe(sol(ENOUGH_TO_START));
  });
});

describe("new-wallet and send-sol survivors", () => {
  let w: World;
  const keys = (): Record<string, KeyPairSigner> => ({ "owner.json": w.owner });

  beforeEach(async () => {
    w = await world();
  });

  it("saves the key exclusively and turns only an EEXIST failure into a refusal", async () => {
    const saves: [string, boolean][] = [];
    const failing = (error: unknown) => ({
      ...runtime({}),
      readText: async (): Promise<string> => {
        throw new Error("absent");
      },
      saveText: async (path: string, _text: string, secret: boolean): Promise<void> => {
        saves.push([path, secret]);
        throw error;
      },
    });
    await expect(newWallet("k.json", failing(Object.assign(new Error("exists"), { code: "EEXIST" })))).rejects.toStrictEqual(new FlowRefused(walletExists("k.json")));
    const other = Object.assign(new Error("denied"), { code: "EACCES" });
    await expect(newWallet("k.json", failing(other))).rejects.toBe(other);
    const bare = new Error("no code");
    await expect(newWallet("k.json", failing(bare))).rejects.toBe(bare);
    expect(saves).toStrictEqual([
      ["k.json", true],
      ["k.json", true],
      ["k.json", true],
    ]);
  });

  it("sends exactly the amount a new wallet needs to exist, and refuses one lamport less", async () => {
    const least = h.svm.minimumBalanceForRentExemption(0n);
    const send = async (amount: bigint) => cli(["send-sol", "--keypair", "owner.json", "--to", (await generateKeyPairSigner()).address, "--amount", sol(amount), "--yes"], keys());
    const exact = await send(least);
    expect([exact.code, exact.err, exact.json()["sent"]]).toStrictEqual([EXIT_OK, "", true]);
    const less = await cli(["send-sol", "--keypair", "owner.json", "--to", (await generateKeyPairSigner()).address, "--amount", sol(least - 1n), "--yes"], keys());
    expect(less.err).toMatch(/^\S+ holds no SOL yet, and a new wallet needs at least /);
    expect(belowRent("A" as Address, least)).toContain(sol(least));
  });
});
