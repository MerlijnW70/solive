import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Address, createKeyPairSignerFromPrivateKeyBytes, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { NATIVE_MINT } from "@intent-engine/core";
import { PRODUCT_REPOSITORY } from "@intent-engine/core/internal";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testSignature } from "@intent-engine/client/testing";
import { FAUCET_DEVNET_ONLY } from "../src/args.js";
import {
  FAUCET_INTERVAL_MINUTES,
  FAUCET_MINUTE,
  FAUCET_POLL_SECONDS,
  FAUCET_RUN_MINUTES,
  FAUCET_SCHEDULE,
  FAUCET_TITLE,
  FAUCET_WAIT_MINUTES,
  faucetPending,
  faucetWaiting,
  GH_HINT,
  GH_MISSING,
  GH_SIGNED_OUT,
  ghFailed,
} from "../src/faucet.js";
import type { Launched } from "../src/launch.js";
import { NPM_REGISTRY, plainRegistry, REGISTRY_ARGS, REGISTRY_TIMEOUT_MS, USE_HTTPS } from "../src/npm-registry.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, main } from "../src/main.js";
import {
  AIRDROP,
  AIRDROPS,
  airdropRefused,
  CLI_SMALL_START,
  CLI_START,
  ENOUGH_TO_START,
  faucetLink,
  fundingSteps,
  GH_WAY,
  otherWays,
  PUBLIC_FAUCET,
  heldRefused,
  holdsEnough,
  LAMPORTS_PER_SOL,
  refusedEnough,
  smallerAirdrop,
  SWAP_START,
} from "../src/wallet.js";
import { h, runtime, transport, world, type World } from "./harness.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}/${path}`, "utf8");
const WORKFLOW = read(".github/workflows/faucet.yml");
const FORM = read(".github/ISSUE_TEMPLATE/faucet.yml");
const FAUCET_SCRIPT = read("scripts/faucet.sh");
const GUIDE = read("docs/first-job.md");
const ISSUE = PRODUCT_REPOSITORY + "/issues/41";
const SOL = (text: string) => {
  const [whole = "0", part = ""] = text.split(".");
  return BigInt(whole) * LAMPORTS_PER_SOL + BigInt(part.padEnd(9, "0").slice(0, 9));
};

type Reply = Launched | null;

const HTTPS_REGISTRY: Reply = { code: 0, output: `${NPM_REGISTRY}\n` };

async function run(argv: string[], replies: Reply[] = [], npm: Reply | Error = HTTPS_REGISTRY) {
  const launched: string[][] = [];
  const asked: { args: string[]; timeoutMs: number | undefined }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const notes: string[] = [];
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((text) => notes.push(String(text)) > 0);
  const rt = {
    ...runtime({}),
    launch: async (program: string, args: readonly string[], timeoutMs?: number) => {
      if (program === "npm") {
        asked.push({ args: [...args], timeoutMs });
        if (npm instanceof Error) {
          throw npm;
        }
        return npm;
      }
      launched.push([program, ...args]);
      const reply = replies.shift();
      if (reply === undefined) {
        throw new Error(`no reply for ${program} ${args.join(" ")}`);
      }
      return reply;
    },
  };
  const code = await main(argv, rt, { out: (t) => out.push(t), err: (t) => err.push(t) }).finally(() => stderr.mockRestore());
  return { code, launched, asked, err: err.join("\n"), notes: notes.join(""), json: () => JSON.parse(out.join("\n")) as Record<string, unknown> };
}

const refusing = (above: bigint) => {
  h.through = {
    ...transport,
    airdrop: async (address, amount) => {
      h.airdrops.push({ address, lamports: amount });
      if (amount > above) {
        throw new Error("429 Too Many Requests");
      }
      h.svm.airdrop(address, lamports(amount));
      return testSignature(`airdrop ${address} ${amount}`);
    },
  };
};

const SIGNED_IN: Reply = { code: 0, output: "Logged in to github.com" };
const FILED: Reply = { code: 0, output: `\nCreating issue in owner/repo\n\n${ISSUE}\n` };

function preset(at: Address): void {
  const space = BigInt(getMintSize());
  h.svm.setAccount({
    address: at,
    data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() })),
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

describe("setup when devnet refuses", () => {
  let w: World;

  beforeEach(async () => {
    w = await world();
  });

  it("asks for smaller airdrops in turn and says which amount it got", async () => {
    refusing(AIRDROP / 4n);
    const made = await run(["setup"]);
    expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
    const address = made.json()["address"] as Address;
    expect(h.airdrops).toEqual(AIRDROPS.slice(0, 3).map((amount) => ({ address, lamports: amount })));
    expect(made.json()).toMatchObject({ sol: "0.25", airdrop: "0.25", next: smallerAirdrop(AIRDROP / 4n) + holdsEnough("0.25", CLI_START) });
    expect(made.json()["next"]).toMatch(/^devnet refused 1 SOL and sent 0\.25 SOL; your wallet holds 0\.25 SOL, enough to start; /);
    expect(AIRDROPS[0]).toBe(AIRDROP);
    expect(AIRDROPS.every((amount, i) => i === 0 || amount < (AIRDROPS[i - 1] ?? 0n))).toBe(true);
    expect(AIRDROPS.at(-1) ?? 0n).toBeGreaterThanOrEqual(ENOUGH_TO_START);
  });

  it("tries every amount before pointing to the faucet, and names the option that files the request", async () => {
    refusing(0n);
    const made = await run(["setup"]);
    const address = made.json()["address"] as Address;
    expect(h.airdrops.map((a) => a.lamports)).toEqual([...AIRDROPS]);
    expect(made.launched).toEqual([]);
    expect(made.json()).toMatchObject({ sol: "0", next: airdropRefused(address) });
    expect(made.json()["airdrop"]).toBeUndefined();
    expect(made.json()["other_ways"]).toEqual(otherWays(address, GH_HINT));
    expect(made.json()["other_ways"]).toContain(GH_WAY);
    expect((made.json()["other_ways"] as string[])[0]).toContain("in a browser, as a public GitHub issue that needs a GitHub account");
    expect(made.json()["next"]).toContain(PUBLIC_FAUCET);
    expect(made.json()["next"]).not.toContain("--faucet");
    expect(made.json()["next"]).toContain("devnet refused the airdrop");
  });

  it("names the faucet option only on devnet, where the faucet sends", async () => {
    refusing(0n);
    const made = await run(["setup", "--url", "localnet"]);
    expect(made.json()).toMatchObject({ next: airdropRefused(made.json()["address"] as string) });
    expect(made.json()["next"]).not.toContain("--faucet");
    expect(made.json()["other_ways"]).toEqual(otherWays(made.json()["address"] as string, ""));
    expect(made.json()["other_ways"]).not.toContain(GH_WAY);
  });

  it("counts the SOL the first paid job guide needs as enough to start and sends that wallet nowhere near the faucet", async () => {
    const need = /This guide needs ([\d.]+) SOL in your wallet\./.exec(GUIDE)?.[1] ?? "missing";
    refusing(0n);
    const address = (await run(["setup"])).json()["address"] as Address;
    h.svm.airdrop(address, lamports(SOL(need)));
    const held = (await run(["setup"])).json();
    expect(held).toMatchObject({ sol: need, next: refusedEnough(need, CLI_SMALL_START) });
    expect(held["next"]).not.toContain(faucetLink(address));
    expect(held["next"]).not.toContain(fundingSteps(address));
    expect(held["next"]).not.toContain("less than");
    expect(held["next"]).toContain("follow the first paid job guide");
  });

  it("still points a wallet below that amount to the faucet", async () => {
    refusing(0n);
    const address = (await run(["setup"])).json()["address"] as Address;
    h.svm.airdrop(address, lamports(ENOUGH_TO_START - 1n));
    const held = (await run(["setup"])).json();
    expect(held).toMatchObject({ sol: "0.059999999", next: heldRefused("0.059999999", address) });
  });

  it("offers the starter swap only to a wallet that can pay for it", async () => {
    expect(CLI_SMALL_START).toBe("follow the first paid job guide; a 0.05 SOL swap needs 0.1 SOL");
    preset(NATIVE_MINT);
    const signer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(9));
    h.svm.airdrop(signer.address, lamports(SWAP_START));
    const swap = ["create", "swap", "--keypair", "owner.json", "--input-mint", "SOL", "--output-mint", w.outputMint, "--expires-in", "3600", "--amount-in", "0.05", "--min-out", "0.000005", "--yes"];
    const out: string[] = [];
    const err: string[] = [];
    expect(await main(swap, runtime({ "owner.json": signer }), { out: (t) => out.push(t), err: (t) => err.push(t) })).toBe(EXIT_OK);
    expect(err).toEqual([]);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ sent: true });
  });
});

describe("setup --faucet", () => {
  beforeEach(async () => {
    await world();
    refusing(0n);
  });

  it("files the faucet request with the GitHub CLI, says how long it waits, and waits for the SOL", async () => {
    const address = (await run(["setup"])).json()["address"] as Address;
    h.rounds = 100;
    h.onSleep.push(
      () => undefined,
      () => h.svm.airdrop(address, lamports(LAMPORTS_PER_SOL / 2n)),
    );
    const ran = await run(["setup", "--faucet"], [SIGNED_IN, FILED]);
    expect([ran.code, ran.err]).toEqual([EXIT_OK, ""]);
    expect(ran.json()["address"]).toBe(address);
    const [owner, name] = new URL(PRODUCT_REPOSITORY).pathname.split("/").filter((p) => p !== "");
    expect(ran.launched).toEqual([
      ["gh", "auth", "status", "--hostname", "github.com"],
      ["gh", "issue", "create", "--repo", `${owner}/${name}`, "--title", FAUCET_TITLE, "--body", address],
    ]);
    expect(ran.notes).toBe(`${faucetWaiting(ISSUE)}\n`);
    expect(ran.notes).toContain(`waiting up to ${FAUCET_WAIT_MINUTES} minutes`);
    expect(h.sleeps).toEqual([FAUCET_POLL_SECONDS, FAUCET_POLL_SECONDS]);
    expect(ran.json()).toMatchObject({ sol: "0.5", faucet_request: ISSUE, next: refusedEnough("0.5", CLI_START) });
  });

  it("stops waiting once the bound passes, and says where the faucet answers", async () => {
    h.rounds = 10_000;
    for (let i = 0; i < 1_000; i++) {
      h.onSleep.push(() => {
        h.clock += BigInt(FAUCET_POLL_SECONDS);
      });
    }
    const ran = await run(["setup", "--faucet"], [SIGNED_IN, FILED]);
    expect(ran.code).toBe(EXIT_OK);
    expect(h.sleeps).toHaveLength((FAUCET_WAIT_MINUTES * 60) / FAUCET_POLL_SECONDS);
    expect(ran.json()).toMatchObject({ sol: "0", faucet_request: ISSUE, next: faucetPending(ISSUE) });
  });

  it("without the GitHub CLI prints the link and says the request needs a browser and a GitHub account", async () => {
    const ran = await run(["setup", "--faucet"], [null]);
    const address = ran.json()["address"] as Address;
    expect(ran.launched).toEqual([["gh", "auth", "status", "--hostname", "github.com"]]);
    expect(h.sleeps).toEqual([]);
    expect(ran.notes).toBe("");
    expect(ran.json()).toMatchObject({ sol: "0", next: airdropRefused(address) });
    expect(ran.json()["other_ways"]).toEqual(otherWays(address, GH_MISSING));
    expect((ran.json()["other_ways"] as string[])[0]).toContain("open " + faucetLink(address) + " to file a faucet request in a browser");
    expect(ran.json()["faucet_request"]).toBeUndefined();
  });

  it("with the GitHub CLI signed out prints the link and how to sign in", async () => {
    const ran = await run(["setup", "--faucet"], [{ code: 1, output: "You are not logged into any GitHub hosts" }]);
    const address = ran.json()["address"] as Address;
    expect(ran.launched).toHaveLength(1);
    expect(ran.json()).toMatchObject({ next: airdropRefused(address) });
  });

  it("fails with what the GitHub CLI said when it cannot file the request", async () => {
    const ran = await run(["setup", "--faucet"], [SIGNED_IN, { code: 1, output: "could not create issue: HTTP 404\n" }]);
    expect(ran.code).toBe(EXIT_FAILED);
    expect(ran.err).toBe(ghFailed(1, "could not create issue: HTTP 404"));
    expect(h.sleeps).toEqual([]);
  });

  it("files nothing for a wallet that already holds enough", async () => {
    refusing(AIRDROP);
    const ran = await run(["setup", "--faucet"]);
    expect(ran.launched).toEqual([]);
    expect(ran.json()).toMatchObject({ sol: "1", next: holdsEnough("1", CLI_START) });
  });

  it("works only on devnet", async () => {
    for (const url of ["localnet", "mainnet-beta"]) {
      const ran = await run(["setup", "--faucet", "--url", url]);
      expect([ran.code, ran.err, ran.launched]).toEqual([EXIT_USAGE, FAUCET_DEVNET_ONLY, []]);
    }
  });
});

describe("the faucet text", () => {
  it("matches the faucet workflow's schedule and the request form", () => {
    const cron = /^ {2}schedule:\n {4}- cron: "([\d,]+) \* \* \* \*"\n/m.exec(WORKFLOW)?.[1] ?? "";
    const minutes = cron.split(",").map(Number);
    const timeout = /^ {4}timeout-minutes: (\d+)$/m.exec(WORKFLOW)?.[1];
    expect(minutes[0]).toBe(FAUCET_MINUTE);
    expect(minutes.map((m, i) => ((minutes[i + 1] ?? (minutes[0] ?? 0) + 60) - m))).toEqual(minutes.map(() => FAUCET_INTERVAL_MINUTES));
    expect(FAUCET_INTERVAL_MINUTES).toBeLessThan(60);
    expect(FAUCET_INTERVAL_MINUTES).toBeGreaterThanOrEqual(5);
    expect(Number(timeout)).toBe(FAUCET_RUN_MINUTES);
    expect(FAUCET_WAIT_MINUTES).toBe(FAUCET_INTERVAL_MINUTES + FAUCET_RUN_MINUTES);
    expect(FAUCET_SCHEDULE).toBe("the faucet answers new requests at least every 15 minutes, so SOL arrives within 25 minutes");
    const steps = fundingSteps("ADDRESS");
    expect(steps).toContain(FAUCET_SCHEDULE);
    expect(steps).toContain("as a public GitHub issue that needs a GitHub account");
    expect(FORM).toContain(`\ntitle: ${FAUCET_TITLE}\n`);
    expect(FORM).toContain("\nlabels: [faucet]\n");
  });

  it("serves a request filed without the form, by its title", () => {
    expect(WORKFLOW).toContain(`github.event.issue.title == '${FAUCET_TITLE}'`);
    expect(FAUCET_SCRIPT).toContain(`select(.title == "${FAUCET_TITLE}")`);
    expect(FAUCET_SCRIPT.indexOf("--add-label faucet ")).toBeLessThan(FAUCET_SCRIPT.indexOf("waiting=$(gh issue list --label faucet"));
  });
});
