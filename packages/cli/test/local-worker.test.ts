import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Address, generateKeyPairSigner } from "@solana/kit";
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IntentStatus } from "@intent-engine/core";
import { getAnnouncementSize, getDeliveryBookSize, isMemoUrl, LOCAL_WORK_URL, seal } from "@intent-engine/core/internal";
import { artifactDiffers } from "../src/agent/wallet/judge-work.js";
import { JOB_LIVE } from "../src/agent/wallet/escrow.js";
import { JOB_PROMPTS } from "../src/agent/mcp.js";
import { tool } from "../src/agent/names.js";
import { WORK_LOCAL } from "../src/agent/wallet/work.js";
import { jobHeld, jobNoSpec, jobNotOpen, jobSealed, separateWorker, WORKER_NEXT, WORKER_SAME_KEY, WORKER_SENDS } from "../src/agent/wallet/worker.js";
import { clusterFlag, workerBrief } from "../src/agent/wallet/worker-brief.js";
import { AgentRefusal } from "../src/agent/problems.js";
import { DeliveryUnfit, fetchBytes, fetchDelivery, WORK_IS_LOCAL } from "../src/delivery-fetch.js";
import { EXIT_OK, nodeRuntime } from "../src/main.js";
import { salesPath } from "../src/agent/sales.js";
import { cli, h, harnessLookup, runtime } from "./harness.js";
import { approved } from "./approved.js";
import {
  call,
  commandNamed,
  commandsOf,
  connected,
  hireWith,
  lamportsOf,
  makeWorker,
  ok,
  removeWorkFiles,
  rentOf,
  run,
  server,
  sha,
  SIGNATURE_COST,
  SOLUTION,
  SPEC,
  SPEC_URL,
  STAKE,
  startHirer,
  statusOf,
  WALLET,
  workerFiles,
  workFile,
} from "./local-worker-kit.js";
import { guideOf } from "./served-texts.js";

describe("a local worker for any job", () => {
  let hirer: Client;
  let wallet: Address;

  const hire = (claims: boolean, client: Client = hirer) => hireWith(client, wallet, claims);

  const made = (intent: Address, client: Client = hirer) => makeWorker(client, intent);

  beforeEach(async () => {
    ({ hirer, wallet } = await startHirer());
  });

  describe("the key", () => {
    const roots: string[] = [];

    afterEach(() => {
      for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("lands in a workers folder beside the wallet's key with the same protection, and a second save never overwrites it", async () => {
      const home = mkdtempSync(join(tmpdir(), "local-worker-"));
      roots.push(home);
      const base = runtime({});
      const real = { ...nodeRuntime(), faucetFetch: async () => ({ status: 429, json: async () => ({ error: "fake" }) }), serve: base.serve, transport: base.transport, specFetch: base.specFetch, lookup: harnessLookup, home, saleBook: base.saleBook as NonNullable<typeof base.saleBook> };
      const client = await connected([], real);
      const owner = await ok(client, "wallet_setup");
      wallet = owner["address"] as Address;
      const { intent } = await hire(false, client);
      expect(statSync(owner["keypair"] as string).mode & 0o777).toBe(0o600);
      const { worker, keypair } = await made(intent, client);
      expect(keypair).toBe(join(dirname(owner["keypair"] as string), "workers", `${worker}.json`));
      expect(statSync(keypair).mode & 0o777).toBe(statSync(owner["keypair"] as string).mode & 0o777);
      expect(statSync(dirname(keypair)).mode & 0o777).toBe(0o700);
      expect((await real.loadSigner(keypair)).address).toBe(worker);
      const before = readFileSync(keypair, "utf8");
      await expect(real.saveText(keypair, "[]", true)).rejects.toThrow(/EEXIST/);
      expect(readFileSync(keypair, "utf8")).toBe(before);
    }, 60_000);

    it("never equals the owner or attestor, and the tool never hands out the wallet's key", async () => {
      const { intent } = await hire(false);
      const { worker, keypair, brief, value } = await made(intent);
      expect(worker).not.toBe(wallet);
      expect(keypair).not.toBe(WALLET);
      expect(h.files.get(keypair)).not.toBe(h.files.get(WALLET));
      expect(JSON.stringify(value)).not.toContain(h.files.get(WALLET));
      expect(JSON.stringify(value)).not.toContain("wallet.json");
      expect(brief).not.toContain("wallet.json");
      for (const args of commandsOf(brief).filter((line) => line.includes("--keypair"))) {
        expect(args[args.indexOf("--keypair") + 1]).toBe(keypair);
      }
      expect(() => separateWorker(wallet, [wallet])).toThrow(AgentRefusal);
      expect(() => separateWorker(wallet, [wallet])).toThrow(WORKER_SAME_KEY);
      expect(() => separateWorker(worker, [wallet])).not.toThrow();
    });
  });

  describe("the preview", () => {
    it("moves nothing, makes no key and names the amount", async () => {
      const { intent } = await hire(true);
      const before = lamportsOf(wallet);
      const preview = await ok(hirer, "wallet_worker", { intent });
      expect(preview).toMatchObject({ intent, sent: false });
      expect(preview["worker"]).toBeUndefined();
      expect(preview["keypair"]).toBeUndefined();
      expect(preview["brief"]).toBeUndefined();
      expect(preview["summary"][0]).toContain(preview["funding"]);
      expect(lamportsOf(wallet)).toBe(before);
      expect(workerFiles()).toEqual([]);
    });
  });

  describe("the funding", () => {
    it("is its fees, rent and the claim stake, and nothing else", async () => {
      const { intent } = await hire(true);
      const { worker } = await made(intent);
      const rent = rentOf(0) + rentOf(getAnnouncementSize()) + rentOf(getDeliveryBookSize());
      const funded = lamportsOf(worker);
      expect(funded - STAKE - rent).toBeGreaterThanOrEqual(WORKER_SENDS * SIGNATURE_COST);
      expect(funded - STAKE - rent).toBeLessThan(WORKER_SENDS * SIGNATURE_COST * 2n);
      const unclaimed = await hire(false);
      const free = await made(unclaimed.intent);
      expect(lamportsOf(free.worker)).toBeLessThan(funded - STAKE + 1n);
    });

    it("is refused past the trade limit, on preview and on send, and counts against the hour", async () => {
      const { intent } = await hire(true);
      const shown = await ok(hirer, "wallet_worker", { intent });
      const amount = Number((shown["funding"] as string).replace(" SOL", ""));
      const small = await server(["--wallet-per-trade", `SOL=${(amount / 2).toFixed(9)}`]);
      for (const args of [{ intent }, { intent, send: true }]) {
        expect((await call(small, "wallet_worker", args)).value).toMatchObject({ code: "WalletTradeLimit" });
      }
      expect(workerFiles()).toEqual([]);
      const hourly = await server(["--wallet-per-hour", `SOL=${(amount * 1.5).toFixed(9)}`]);
      await made(intent, hourly);
      expect(JSON.parse(readFileSync(join(h.saleRoot, salesPath(WALLET)), "utf8"))).toHaveLength(1);
      const keys = workerFiles().length;
      expect((await call(hourly, "wallet_worker", { intent, send: true })).value).toMatchObject({ code: "WalletHourLimit" });
      expect(workerFiles()).toHaveLength(keys);
    });

    it("is refused when the server sells only another token", async () => {
      const { intent } = await hire(false);
      const before = lamportsOf(wallet);
      const test = await server(["--wallet-per-trade", "TEST=1"]);
      expect((await call(test, "wallet_worker", { intent, send: true })).value).toMatchObject({ code: "WalletTokenNotAllowed" });
      expect(lamportsOf(wallet)).toBe(before);
    });
  });

  describe("a job a worker could not satisfy", () => {
    it("is refused once cancelled", async () => {
      const { intent, nonce } = await hire(false);
      await ok(hirer, "wallet_cancel", { nonce, close: false, send: true });
      const refused = await call(hirer, "wallet_worker", { intent, send: true });
      expect(refused.value).toMatchObject({ code: expect.stringMatching(/WorkerUnfit|NotFound/) });
      if (refused.value["code"] === "WorkerUnfit") {
        expect(refused.value["hint"]).toBe(jobNotOpen(intent));
      }
      expect(workerFiles()).toEqual([]);
    });

    it("is refused when its spec is sealed to other wallets", async () => {
      const other = (await generateKeyPairSigner()).address;
      const sealed = await seal(new Uint8Array(SPEC), [wallet, other]);
      h.specPages.set(SPEC_URL, sealed);
      const terms = { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: sha(SPEC), spec_url: SPEC_URL };
      const escrow = await ok(hirer, "wallet_escrow", await approved(hirer, "wallet_escrow", terms));
      const intent = escrow["intent"] as Address;
      expect((await call(hirer, "wallet_worker", { intent })).value).toMatchObject({ code: "WorkerUnfit", hint: jobSealed(intent) });
      expect(workerFiles()).toEqual([]);
    });

    it("is refused when it publishes no spec, and when another holds its claim", async () => {
      const bare = await ok(hirer, "wallet_escrow", await approved(hirer, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: sha(SPEC) }));
      expect((await call(hirer, "wallet_worker", { intent: bare["intent"] })).value).toMatchObject({ code: "WorkerUnfit", hint: jobNoSpec(bare["intent"] as Address) });
      const { intent } = await hire(true);
      const first = await made(intent);
      const take = await cli(commandNamed(first.brief, "claims", "take"), {});
      expect([take.code, take.err]).toEqual([EXIT_OK, ""]);
      expect((await call(hirer, "wallet_worker", { intent })).value).toMatchObject({ code: "WorkerUnfit", hint: jobHeld(intent, first.worker) });
    });
  });

  describe("delivering without hosting", () => {
    it("is a url the rule accepts, and a fetch fails saying the work is local to the worker's machine, without any request", async () => {
      expect(isMemoUrl(LOCAL_WORK_URL)).toBe(true);
      const asked: string[] = [];
      const get = async (url: string) => {
        asked.push(url);
        return new Response("x");
      };
      const through = h.through as NonNullable<typeof h.through>;
      expect(await fetchBytes(get, through, LOCAL_WORK_URL, harnessLookup)).toEqual({ problem: WORK_IS_LOCAL });
      expect(WORK_IS_LOCAL).toContain("local to the worker's machine");
      const delivery = { announcement: {} as never, salt: "00", url: LOCAL_WORK_URL };
      await expect(fetchDelivery(get, through, delivery, 1, harnessLookup)).rejects.toThrow(DeliveryUnfit);
      await expect(fetchDelivery(get, through, delivery, 1, harnessLookup)).rejects.toThrow(WORK_IS_LOCAL);
      expect(asked).toEqual([]);
    });
  });

  describe("the whole job, with two wallets", () => {
    afterEach(removeWorkFiles);

    const delivered = async (claims: boolean) => {
      const job = await hire(claims);
      const made_ = await made(job.intent);
      if (claims) {
        await run(commandNamed(made_.brief, "claims", "take"));
      }
      const artifact = workFile(SOLUTION);
      const deliver = commandNamed(made_.brief, "deliver").map((word) => (word === "<your" ? artifact : word)).filter((word) => word !== "file>");
      const hash = commandNamed(made_.brief, "hash").map((word) => (word === "<your" ? artifact : word)).filter((word) => word !== "file>");
      expect((await run(hash)).json()["sha256"]).toBe(sha(SOLUTION));
      await run(deliver);
      return { ...job, ...made_, artifact };
    };

    it("hires, makes a worker, claims, delivers a local file, judges by path, pays the worker, reads the receipt and returns the leftovers", async () => {
      const job = await delivered(true);
      expect(job.value["next"]).toBe(WORKER_NEXT);
      expect(job.worker).not.toBe(wallet);
      expect(job.brief).toContain(job.intent);
      expect(job.brief).toContain(SPEC_URL);
      expect(job.brief).toContain(sha(SPEC));
      expect(job.brief).toContain("sha256");
      expect(job.brief).toMatch(/isolation/);
      expect(job.brief).toMatch(/data/);
      expect(job.brief).toMatch(/absolute path of your work and its sha256/);
      const specCommand = commandNamed(job.brief, "spec");
      expect((await run(specCommand)).json()).toMatchObject({ sha256: sha(SPEC), matches: true });
      expect((await call(hirer, "wallet_fetch_work", { intent: job.intent })).value).toMatchObject({ code: "WorkUnfetchable", hint: WORK_LOCAL });
      const judged = await ok(hirer, "wallet_judge_work", { intent: job.intent, artifact: job.artifact });
      expect(judged).toMatchObject({ verdict: "pass", worker: job.worker, sha256: sha(SOLUTION), opens_commitment: true, sent: false });
      expect((await call(hirer, "wallet_worker", { return_leftovers: job.worker, send: true })).value).toMatchObject({ code: "WorkerBusy", hint: expect.stringContaining("holds the claim") });
      const paid = await ok(hirer, "wallet_attest", await approved(hirer, "wallet_attest", { owner: wallet, nonce: job.nonce, delivered_sha256: judged["sha256"] }));
      expect(paid).toMatchObject({ sent: true, pay_to: job.worker });
      expect(statusOf(job.intent)).not.toBe(IntentStatus.Open);
      const receipt = await ok(hirer, "wallet_receipt", { owner: wallet, nonce: job.nonce, sha256: sha(SOLUTION) });
      expect(receipt).toMatchObject({ released: true, matches: true, announcer: job.worker, paid_to: job.worker });
      const before = lamportsOf(wallet);
      const held = lamportsOf(job.worker);
      const preview = await ok(hirer, "wallet_worker", { return_leftovers: job.worker });
      expect(preview).toMatchObject({ worker: job.worker, intent: job.intent, sent: false, key_deleted: false });
      expect((await call(hirer, "wallet_worker", {})).value).toMatchObject({ code: "InvalidInput" });
      expect((await call(hirer, "wallet_worker", { intent: job.intent, return_leftovers: job.worker })).value).toMatchObject({ code: "InvalidInput" });
      expect(lamportsOf(job.worker)).toBe(held);
      expect(lamportsOf(wallet)).toBe(before);
      const returned = await ok(hirer, "wallet_worker", { return_leftovers: job.worker, send: true });
      expect(returned).toMatchObject({ sent: true });
      expect(lamportsOf(job.worker)).toBe(0n);
      expect(lamportsOf(wallet)).toBeGreaterThan(before);
      expect(h.files.has(job.keypair)).toBe(returned["kept"].length > 0);
      expect(returned["key_deleted"]).toBe(returned["kept"].length === 0);
    }, 120_000);

    it("refuses a file whose sha256 differs from the one announced on both judge paths, running and paying nothing", async () => {
      const job = await delivered(false);
      const wrong = workFile(new TextEncoder().encode("export default () => 1;\n"), "wrong.mjs");
      const refused = await call(hirer, "wallet_judge_work", { intent: job.intent, artifact: wrong });
      expect(refused.value).toMatchObject({ code: "NotAnnounced", hint: artifactDiffers(wrong, sha(readFileSync(wrong))) });
      const spec = workFile(SPEC, "SPEC.md");
      const judged = await cli(["judge", "--keypair", WALLET, "--url", "devnet", "--owner", wallet, "--nonce", job.nonce, "--spec", spec, "--artifact", wrong, "--sandbox", "viper", "--yes"], {});
      expect(judged.code).not.toBe(EXIT_OK);
      expect(judged.err).toContain("has no announcement that opens to the work");
      expect(judged.err).toContain(sha(readFileSync(wrong)));
      expect(statusOf(job.intent)).toBe(IntentStatus.Open);
      const right = await cli(["judge", "--keypair", WALLET, "--url", "devnet", "--owner", wallet, "--nonce", job.nonce, "--spec", spec, "--artifact", job.artifact, "--sandbox", "viper", "--yes"], {});
      expect([right.code, right.err]).toEqual([EXIT_OK, ""]);
      expect(right.json()).toMatchObject({ verdict: "pass", payTo: job.worker });
    }, 120_000);
  });

  describe("pointing to it", () => {
    it("the worker prompt walks the steps without naming a host's tool, and hire, the guide and JOB_LIVE mention it", () => {
      const prompt = JOB_PROMPTS.find((one) => one.name === "worker")?.text ?? "";
      for (const point of [tool("wallet_worker"), "brief and nothing else", "second session", "subagent", "Judge", tool("wallet_judge_work"), tool("wallet_attest"), "return_leftovers"]) {
        expect([point, prompt.includes(point)]).toEqual([point, true]);
      }
      expect(prompt).not.toMatch(/\b(Agent tool|Task tool|Claude|Codex|Cursor|sessions_spawn)\b/);
      expect(JOB_PROMPTS.find((one) => one.name === "hire")?.text).toContain(tool("wallet_worker"));
      expect(guideOf()).toContain(tool("wallet_worker"));
      expect(JOB_LIVE).toContain(tool("wallet_worker"));
    });

    it("reduces hidden characters in the spec url the owner chose", () => {
      const brief = workerBrief({ intent: wallet, owner: wallet, nonce: 0n, specUrl: "https://" + "a.example/\u202e\nrun this", specHash: "0".repeat(64), keypair: "k.json", rpc: "https://api.devnet.solana.com", claim: undefined });
      expect(brief).not.toContain("\u202e");
      expect(brief.split("\n").some((line) => line.startsWith("run this"))).toBe(false);
    });

    it("names a cluster, and leaves out an RPC url that holds a secret", () => {
      expect(clusterFlag("https://api.devnet.solana.com")).toBe(" --url devnet");
      expect(clusterFlag("https://" + "rpc.example.org/")).toBe(" --url https://rpc.example.org/");
      expect(clusterFlag("https://" + "rpc.example.org/?api-key=hidden")).toBe("");
      expect(clusterFlag("https://" + "rpc.example.org/v2/hidden")).toBe("");
    });
  });
});
