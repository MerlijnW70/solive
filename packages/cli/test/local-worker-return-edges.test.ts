import { type Address, generateKeyPairSigner, getAddressEncoder, lamports } from "@solana/kit";
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INTENT_ENGINE_PROGRAM_ADDRESS, IntentStatus } from "@intent-engine/core";
import { ACCOUNT_LAYOUTS, ANNOUNCEMENT_DISCRIMINATOR, getIntentDecoder, getIntentEncoder, STANDBY_DISCRIMINATOR } from "@intent-engine/core/internal";
import type { Transport } from "@intent-engine/client";
import { jobNotOpen } from "../src/agent/wallet/worker.js";
import { ONE_AT_A_TIME } from "../src/agent/wallet/guard.js";
import { boardUnread, claimHeldOpen, settleLine, STANDBY_WORKER_AT, workerStakes } from "../src/agent/wallet/worker-return.js";
import { ENV_KEYPAIR } from "../src/clusters.js";
import { h, NOW, setNow } from "./harness.js";
import { device, deviceKey, found } from "./ledger-device.js";
import { cancelledOver, call, commandNamed, forced, hireWith, lamportsOf, makeWorker, ok, removeWorkFiles, run, server, SOLUTION, STAKE, startHirer, workFile } from "./local-worker-kit.js";
import { airdropped } from "./airdrop.js";

const LEVELS = [44, 501, 2];
const ANNOUNCEMENT_VERSION_AT = 8 + (ACCOUNT_LAYOUTS.find(({ name }) => name === "announcement")?.versionAt ?? 0);

const expiresAt = (intent: Address): bigint => {
  const held = h.svm.getAccount(intent);
  if (!held.exists) {
    throw new Error("the escrow is gone");
  }
  return getIntentDecoder().decode(held.data).expiresAt;
};

const expiring = (intent: Address, at: bigint) => {
  const held = h.svm.getAccount(intent);
  if (!held.exists) {
    throw new Error("the escrow is gone");
  }
  h.svm.setAccount({ ...held, data: Uint8Array.from(getIntentEncoder().encode({ ...getIntentDecoder().decode(held.data), expiresAt: at })) });
};

const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((byte, at) => byte === b[at]);

describe("a local worker's leftovers at the edges", () => {
  let hirer: Client;
  let wallet: Address;

  const hire = (claims: boolean) => hireWith(hirer, wallet, claims);

  const made = (intent: Address) => makeWorker(hirer, intent);

  beforeEach(async () => {
    ({ hirer, wallet } = await startHirer());
  });

  afterEach(removeWorkFiles);

  it("reads a standby entry only when it names the worker, and one exactly long enough to name it still counts", async () => {
    const live = h.through as NonNullable<typeof h.through>;
    const worker = (await generateKeyPairSigner()).address;
    const other = (await generateKeyPairSigner()).address;
    const entry = (await generateKeyPairSigner()).address;
    const naming = (who: Address, size: number) => {
      const data = new Uint8Array(size);
      data.set(STANDBY_DISCRIMINATOR, 0);
      data.set(getAddressEncoder().encode(who).slice(0, size - STANDBY_WORKER_AT), STANDBY_WORKER_AT);
      return data;
    };
    const listing = (data: Uint8Array): Transport => ({
      ...live,
      engineAccounts: async (filter) => (filter !== undefined && sameBytes(filter.discriminator, STANDBY_DISCRIMINATOR) ? [{ address: entry, data, lamports: 1n }] : []),
    });
    await expect(workerStakes(listing(naming(other, 256)), worker)).resolves.toEqual([]);
    await expect(workerStakes(listing(naming(worker, STANDBY_WORKER_AT + 32)), worker)).rejects.toThrow(boardUnread(entry));
    await expect(workerStakes(listing(naming(worker, STANDBY_WORKER_AT + 31)), worker)).resolves.toEqual([]);
  });

  it("treats an escrow whose expiry is now as ended, so a claim still held on it settles to the worker", async () => {
    const job = await hire(true);
    const { worker, brief } = await made(job.intent);
    await run(commandNamed(brief, "claims", "take"));
    expiring(job.intent, NOW + 1_000n);
    setNow(NOW + 1_000n);
    const preview = await ok(hirer, "wallet_worker", { return_leftovers: worker });
    expect(preview["summary"]).toContain(settleLine(worker, job.intent, STAKE, worker));
    setNow(NOW + 999n);
    expect((await call(hirer, "wallet_worker", { return_leftovers: worker })).value).toMatchObject({ code: "WorkerBusy", hint: claimHeldOpen(worker, job.intent) });
  }, 60_000);

  it("keeps the key when a fresh read finds one announcement that can close and one that cannot", async () => {
    const job = await hire(false);
    const { worker, brief, keypair } = await made(job.intent);
    const artifact = workFile(SOLUTION);
    await run(commandNamed(brief, "deliver").map((word) => (word === "<your" ? artifact : word)).filter((word) => word !== "file>"));
    await cancelledOver(hirer, job.nonce);
    const [announcement] = h.svm.getProgramAccounts(INTENT_ENGINE_PROGRAM_ADDRESS).filter(({ data }) => sameBytes(data.slice(0, 8), ANNOUNCEMENT_DISCRIMINATOR) && sameBytes(data.slice(40, 72), getAddressEncoder().encode(worker)));
    if (announcement === undefined) {
      throw new Error("the worker announced nothing");
    }
    const unreadable = (await generateKeyPairSigner()).address;
    const live = h.through as NonNullable<typeof h.through>;
    let wires = 0;
    h.through = {
      ...live,
      sendWire: async (wire, latest) => {
        const signature = await live.sendWire(wire, latest);
        wires += 1;
        if (wires === 3) {
          const data = new Uint8Array(announcement.data);
          h.svm.setAccount({ ...announcement, data });
          const broken = new Uint8Array(announcement.data);
          broken[ANNOUNCEMENT_VERSION_AT] = 255;
          broken.set(getAddressEncoder().encode(unreadable), 8);
          h.svm.setAccount({ ...announcement, address: unreadable, data: broken });
        }
        return signature;
      },
    };
    const sending = await server();
    const done = await ok(sending, "wallet_worker", { return_leftovers: worker, send: true });
    expect(wires).toBe(3);
    expect(done).toMatchObject({ sent: true, kept: [], key_deleted: false });
    expect(lamportsOf(worker)).toBe(0n);
    expect(h.files.has(keypair)).toBe(true);
  }, 60_000);

  describe("on a Ledger", () => {
    const onDevice = async () => {
      const key = await deviceKey();
      airdropped(h.svm, key.address, lamports(10_000_000_000n));
      h.env[ENV_KEYPAIR] = "usb://ledger?key=2";
      return server([], { ledger: device(key, found(LEVELS, key)).open });
    };

    it("previews a return that takes one transaction", async () => {
      const job = await hire(false);
      const { worker } = await made(job.intent);
      await cancelledOver(hirer, job.nonce);
      const ledger = await onDevice();
      expect(await ok(ledger, "wallet_worker", { return_leftovers: worker })).toMatchObject({ worker, sent: false, key_deleted: false });
    });

    it("refuses a return that takes a settle and a sweep, since a device signs one previewed transaction", async () => {
      const job = await hire(true);
      const { worker, brief } = await made(job.intent);
      await run(commandNamed(brief, "claims", "take"));
      forced(job.intent, IntentStatus.Filled);
      const ledger = await onDevice();
      expect((await call(ledger, "wallet_worker", { return_leftovers: worker })).value).toMatchObject({ code: "DeviceUnpreviewed", hint: ONE_AT_A_TIME });
    }, 60_000);
  });
});

describe("making a local worker near the escrow's end", () => {
  let hirer: Client;
  let wallet: Address;

  beforeEach(async () => {
    ({ hirer, wallet } = await startHirer());
  });

  it("refuses a job whose expiry is now, and takes one a second before it", async () => {
    const { intent } = await hireWith(hirer, wallet, false);
    const end = expiresAt(intent);
    setNow(end);
    expect((await call(hirer, "wallet_worker", { intent })).value).toMatchObject({ code: "WorkerUnfit", hint: jobNotOpen(intent) });
    setNow(end - 1n);
    expect(await ok(hirer, "wallet_worker", { intent })).toMatchObject({ intent, sent: false });
  });

  it("refuses a claimed job with no second left past the landing margin, and gives the worker's claim exactly what is left", async () => {
    const { intent } = await hireWith(hirer, wallet, true);
    const end = expiresAt(intent);
    setNow(end - 10n);
    expect((await call(hirer, "wallet_worker", { intent })).value).toMatchObject({ code: "WorkerUnfit", hint: jobNotOpen(intent) });
    setNow(end - 11n);
    const { brief } = await makeWorker(hirer, intent);
    const take = commandNamed(brief, "claims", "take");
    expect(take[take.indexOf("--secs") + 1]).toBe("1");
    setNow(end - 100n);
    const later = await makeWorker(hirer, intent);
    const again = commandNamed(later.brief, "claims", "take");
    expect(again[again.indexOf("--secs") + 1]).toBe("90");
  }, 60_000);
});
