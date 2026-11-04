import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner } from "@solana/kit";
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findConfigPda, getConfigDecoder, getConfigEncoder } from "@intent-engine/core/internal";
import { MAX_SPEC_BYTES } from "@intent-engine/client/internal";
import { artifactUnfit, boundedRead } from "../src/agent/wallet/judge-work.js";
import { ESCROW_EXPIRES_IN } from "../src/agent/wallet/escrow.js";
import { jobListed, jobNotOpen, jobSpecDiffers, WORKER_ON_DEVICE } from "../src/agent/wallet/worker.js";
import { AgentRefusal } from "../src/agent/problems.js";
import { salesPath } from "../src/agent/sales.js";
import { ENV_KEYPAIR } from "../src/clusters.js";
import { h, NOW, runtime, saleBook, setNow } from "./harness.js";
import { approved } from "./approved.js";
import { device, deviceKey, found } from "./ledger-device.js";
import { call, hireWith, lamportsOf, makeWorker, ok, removeWorkFiles, run, server, sha, SPEC, SPEC_URL, startHirer, WALLET, workerFiles, workFile } from "./local-worker-kit.js";

const ANNOUNCE_FEE = 12_345;

describe("the local worker's guards", () => {
  let hirer: Client;
  let wallet: Address;

  const hire = (claims: boolean, client: Client = hirer) => hireWith(client, wallet, claims);

  const sales = () => {
    try {
      return JSON.parse(readFileSync(join(h.saleRoot, salesPath(WALLET)), "utf8")) as unknown[];
    } catch {
      return [];
    }
  };

  beforeEach(async () => {
    ({ hirer, wallet } = await startHirer());
  });

  afterEach(removeWorkFiles);

  it("saves the key as a secret, so the tool never overwrites a file already at its path and sends nothing", async () => {
    const { intent } = await hire(false);
    const base = runtime({});
    const taken: string[] = [];
    const racing = await server([], {
      saveText: async (path, text, secret) => {
        if (path.includes("/workers/") && !path.endsWith(".job.json")) {
          taken.push(path);
          h.files.set(path, "theirs");
        }
        return base.saveText(path, text, secret);
      },
    });
    const before = lamportsOf(wallet);
    expect((await call(racing, "wallet_worker", await approved(racing, "wallet_worker", { intent }))).error).toBe(true);
    expect(taken).toHaveLength(1);
    expect(h.files.get(taken[0] as string)).toBe("theirs");
    expect(workerFiles().filter((path) => path.endsWith(".job.json"))).toEqual([]);
    expect(lamportsOf(wallet)).toBe(before);
  });

  it("checks the hourly limit again under the sale book's lock, and then removes the key it made", async () => {
    const { intent } = await hire(false);
    const shown = await ok(hirer, "wallet_worker", { intent });
    const amount = Number((shown["funding"] as string).replace(" SOL", ""));
    const limit = ["--wallet-per-hour", `SOL=${(amount * 1.5).toFixed(9)}`];
    await makeWorker(await server(limit), intent);
    const keys = workerFiles();
    const stale = await server(limit, { saleBook: { ...saleBook, read: async () => [] } });
    const before = lamportsOf(wallet);
    expect((await call(stale, "wallet_worker", await approved(stale, "wallet_worker", { intent }))).value).toMatchObject({ code: "WalletHourLimit" });
    expect(workerFiles()).toEqual(keys);
    expect(sales()).toHaveLength(1);
    expect(lamportsOf(wallet)).toBe(before);
  });

  it("funds the announce fee too", async () => {
    const first = await makeWorker(hirer, (await hire(false)).intent);
    const [config] = await findConfigPda();
    const view = h.svm.getAccount(config);
    if (!view.exists) {
      throw new Error("no config");
    }
    const decoded = getConfigDecoder().decode(view.data);
    h.svm.setAccount({ ...view, data: Uint8Array.from(getConfigEncoder().encode({ ...decoded, announceFee: ANNOUNCE_FEE })) });
    const second = await makeWorker(hirer, (await hire(false)).intent);
    expect(lamportsOf(second.worker) - lamportsOf(first.worker)).toBe(BigInt(ANNOUNCE_FEE));
    expect(second.value["summary"].join(" ")).toContain("announce fee");
  });

  it("refuses a job past its expiry and one whose spec no longer matches, making no key", async () => {
    const stale = await hire(false);
    h.specPages.set(SPEC_URL, new TextEncoder().encode("another spec"));
    expect((await call(hirer, "wallet_worker", { intent: stale.intent, send: true })).value).toMatchObject({ code: "WorkerUnfit", hint: jobSpecDiffers(stale.intent, sha(new TextEncoder().encode("another spec"))) });
    const late = await hire(false);
    setNow(NOW + BigInt(ESCROW_EXPIRES_IN) + 600n);
    expect((await call(hirer, "wallet_worker", { intent: late.intent, send: true })).value).toMatchObject({ code: "WorkerUnfit", hint: jobNotOpen(late.intent) });
    expect(workerFiles()).toEqual([]);
  });

  it("removes the key and refunds the sale when the send is refused before it lands", async () => {
    const { intent } = await hire(false);
    const live = h.through as NonNullable<typeof h.through>;
    h.through = {
      ...live,
      sendWire: async () => {
        throw new AgentRefusal("Failed", "the node refused it");
      },
    };
    const refusing = await server(["--wallet-per-hour", "SOL=10"]);
    const before = lamportsOf(wallet);
    expect((await call(refusing, "wallet_worker", await approved(refusing, "wallet_worker", { intent }))).error).toBe(true);
    expect(workerFiles()).toEqual([]);
    expect(sales()).toEqual([]);
    expect(lamportsOf(wallet)).toBe(before);
  });

  it("refuses a Ledger wallet before reading the job", async () => {
    const key = await deviceKey();
    h.env[ENV_KEYPAIR] = "usb://ledger?key=4";
    const ledger = device(key, found([44, 501, 4], key));
    const onDevice = await server([], { ledger: ledger.open });
    expect((await call(onDevice, "wallet_worker", { intent: wallet })).value).toMatchObject({ code: "DeviceUnpreviewed", hint: WORKER_ON_DEVICE });
    expect(workerFiles()).toEqual([]);
  });

  it("refuses a job whose claims are listed to other wallets, moving nothing", async () => {
    const bare = await ok(hirer, "wallet_escrow", await approved(hirer, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: sha(SPEC), spec_url: SPEC_URL }));
    const other = (await generateKeyPairSigner()).address;
    h.specPages.set(SPEC_URL, SPEC);
    await run(["claims", "open", "--keypair", WALLET, "--url", "devnet", "--nonce", bare["nonce"] as string, "--max-secs", "3600", "--stake", "0.01", "--workers", other, "--yes"]);
    const funded = lamportsOf(wallet);
    const intent = bare["intent"] as Address;
    expect((await call(hirer, "wallet_worker", { intent, send: true })).value).toMatchObject({ code: "WorkerUnfit", hint: jobListed(intent) });
    expect(lamportsOf(wallet)).toBe(funded);
    expect(workerFiles()).toEqual([]);
  }, 60_000);

  it("reads an artifact only up to the limit, refuses a larger one or a folder, and reduces hidden characters in the path it echoes", async () => {
    const { intent } = await hire(false);
    const large = workFile(new Uint8Array(MAX_SPEC_BYTES + 1), "large.mjs");
    expect((await call(hirer, "wallet_judge_work", { intent, artifact: large })).value).toMatchObject({ code: "NotJudged", hint: artifactUnfit(large) });
    const fits = workFile(new Uint8Array(MAX_SPEC_BYTES), "fits.mjs");
    expect((await call(hirer, "wallet_judge_work", { intent, artifact: fits })).value).toMatchObject({ code: "NotAnnounced" });
    const folder = mkdtempSync(join(tmpdir(), "local-folder-"));
    try {
      expect((await call(hirer, "wallet_judge_work", { intent, artifact: folder })).value).toMatchObject({ code: "NotJudged" });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
    const odd = workFile(new TextEncoder().encode("export default () => 1;\n"), "a‮\nb.mjs");
    const refused = (await call(hirer, "wallet_judge_work", { intent, artifact: odd })).value;
    expect(refused).toMatchObject({ code: "NotAnnounced" });
    expect(refused["hint"]).not.toContain("‮");
    expect(refused["hint"]).not.toContain("\n");
  });

  it.skipIf(process.platform === "win32")("refuses a named pipe at once instead of waiting for a writer", async () => {
    const folder = mkdtempSync(join(tmpdir(), "local-fifo-"));
    try {
      const pipe = join(folder, "work.mjs");
      execFileSync("mkfifo", [pipe]);
      expect(await boundedRead(pipe, MAX_SPEC_BYTES)).toBeNull();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
