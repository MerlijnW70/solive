import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Address, generateKeyPairSigner, getAddressEncoder } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { testSignature } from "@intent-engine/client/testing";
import {
  type ConfigArgs,
  EVENT_IX_TAG,
  findConfigPda,
  findProgramDataAddress,
  getConfigDecoder,
  getConfigEncoder,
  getIntentCreatedEventEncoder,
  getIntentFilledEventEncoder,
  INTENT_ENGINE_PROGRAM_ADDRESS,
} from "@intent-engine/core/internal";
import type { EngineTransaction, Transport } from "@intent-engine/client";
import { EXIT_ALERTED, EXIT_OK, EXIT_USAGE, main } from "../src/main.js";
import { MONITOR_NEEDS_BASELINE } from "../src/monitor-args.js";
import { cli, enginePath, h, NOW, runtime, world } from "./harness.js";
import { listAccounts, listing } from "./monitor-transport.js";

const BASELINE = "/srv/monitor/baseline.json";
const SECRET_PATH = "/hooks/T0001/s3cret-token";
const WEBHOOK = "https://alerts.example.com" + SECRET_PATH;
const RECENT = NOW + 1_000n;

type Alert = { kind: string; field: string; expected: unknown; observed: unknown; slot: number | null } & Record<string, unknown>;

async function changeConfig(change: Partial<ConfigArgs>): Promise<void> {
  const [address] = await findConfigPda();
  const account = h.svm.getAccount(address);
  if (!account.exists) {
    throw new Error("config missing");
  }
  const config = getConfigDecoder().decode(account.data);
  h.svm.setAccount({ ...account, data: new Uint8Array(getConfigEncoder().encode({ ...config, ...change })) });
}

async function changeProgramData(edit: (data: Uint8Array) => void): Promise<void> {
  const account = h.svm.getAccount(await findProgramDataAddress());
  if (!account.exists) {
    throw new Error("program data missing");
  }
  const data = new Uint8Array(account.data);
  edit(data);
  h.svm.setAccount({ ...account, data });
}

const advance = () => h.svm.warpToSlot(h.svm.getClock().slot + 1n);

async function watch(argv: string[], polls: number, between: (poll: number) => void | Promise<void> = advance) {
  const rt = runtime({});
  let poll = 0;
  rt.sleep = async (seconds) => {
    h.sleeps.push(seconds);
    poll++;
    await between(poll);
    return poll < polls;
  };
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, rt, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out, err: err.join("\n"), alerts: out.map((o) => JSON.parse(o) as Alert) };
}

async function baseline(): Promise<Record<string, unknown>> {
  const written = await cli(["monitor", "--write-baseline", BASELINE], {});
  expect(written.err).toBe("");
  expect(written.code).toBe(EXIT_OK);
  return JSON.parse(h.files.get(BASELINE) ?? "{}") as Record<string, unknown>;
}

const once = (...extra: string[]) => watch(["monitor", "--expect", BASELINE, "--once", ...extra], 1);

function event(bytes: ArrayLike<number>): Uint8Array {
  return new Uint8Array([...EVENT_IX_TAG, ...Array.from(bytes)]);
}

function created(intent: Address, inputMint: Address): Uint8Array {
  return event(
    getIntentCreatedEventEncoder().encode({
      intent,
      owner: intent,
      nonce: 0n,
      kind: 1,
      inputMint,
      outputMint: inputMint,
      receiver: intent,
      escrowed: 0n,
      expiresAt: 0n,
      rentPayer: intent,
      flags: 0,
      bounty: 0,
      createFee: 0,
    }),
  );
}

function filled(intent: Address, amountIn: bigint): Uint8Array {
  return event(
    getIntentFilledEventEncoder().encode({
      intent,
      owner: intent,
      solver: intent,
      receiver: intent,
      solverInput: intent,
      amountIn,
      delivered: amountIn,
      required: amountIn,
      fee: 0n,
      net: amountIn,
      filled: amountIn,
      remaining: 0n,
      partnerFee: 0n,
    }),
  );
}

async function fillTx(label: string, inputMint: Address, amountIn: bigint, slot: bigint): Promise<EngineTransaction> {
  const intent = (await generateKeyPairSigner()).address;
  return { signature: testSignature(label), slot, blockTime: RECENT, failed: false, emitted: [created(intent, inputMint), filled(intent, amountIn)] };
}

describe("monitor", () => {
  beforeEach(async () => {
    await world();
    listAccounts();
  });

  it("the monitor alerts when the config changes", async () => {
    const written = await baseline();
    expect(written["program"]).toBe(INTENT_ENGINE_PROGRAM_ADDRESS);
    const pending = (await generateKeyPairSigner()).address;
    await changeConfig({ feeBps: 7, paused: 3, pendingAdmin: pending, crankBounty: 9, fillDisabledKinds: 2n });
    const { code, alerts } = await once();
    expect(code).toBe(EXIT_ALERTED);
    const slot = Number(h.svm.getClock().slot);
    expect(alerts.filter((a) => a.kind !== "config")).toEqual([]);
    const config = written["config"] as Record<string, unknown>;
    expect(alerts).toEqual([
      { kind: "config", field: "pendingAdmin", expected: config["pendingAdmin"], observed: pending, slot },
      { kind: "config", field: "feeBps", expected: 5, observed: 7, slot },
      { kind: "config", field: "crankBounty", expected: config["crankBounty"], observed: 9, slot },
      { kind: "config", field: "fillDisabledKinds", expected: config["fillDisabledKinds"], observed: "2", slot },
      { kind: "config", field: "paused", expected: 0, observed: 3, slot },
    ]);
  });

  it("the monitor alerts when the upgrade authority or program hash changes", async () => {
    const written = await baseline();
    const elf = readFileSync(enginePath);
    let end = elf.length;
    while (end > 0 && elf[end - 1] === 0) {
      end--;
    }
    expect(written["programHash"]).toBe(createHash("sha256").update(elf.subarray(0, end)).digest("hex"));
    const thief = (await generateKeyPairSigner()).address;
    await changeProgramData((data) => data.set(getAddressEncoder().encode(thief), 13));
    const first = await once();
    expect(first.code).toBe(EXIT_ALERTED);
    expect(first.alerts).toEqual([
      { kind: "upgrade-authority", field: "upgradeAuthority", expected: written["upgradeAuthority"], observed: thief, slot: Number(h.svm.getClock().slot) },
    ]);
    await changeProgramData((data) => {
      data[12] = 0;
      data[200] = (data[200] ?? 0) ^ 0xff;
    });
    const second = await once();
    expect(second.code).toBe(EXIT_ALERTED);
    expect(second.alerts.map((a) => [a.kind, a.observed])).toEqual([
      ["upgrade-authority", "none"],
      ["program-hash", second.alerts[1]?.observed],
    ]);
    expect(second.alerts[1]?.expected).toBe(written["programHash"]);
    expect(second.alerts[1]?.observed).toMatch(/^[0-9a-f]{64}$/);
    expect(second.alerts[1]?.observed).not.toBe(written["programHash"]);
  });

  it("the monitor alerts on a fill above its limit and on a burst of fills", async () => {
    await baseline();
    const watched = (await generateKeyPairSigner()).address;
    const other = (await generateKeyPairSigner()).address;
    const big = await fillTx("big", watched, 5_001n, 40n);
    h.engineLog = [
      big,
      await fillTx("small-1", watched, 5_000n, 41n),
      await fillTx("small-2", other, 9_000_000n, 42n),
      await fillTx("small-3", watched, 1n, 43n),
      { ...(await fillTx("failed", watched, 9_000_000n, 44n)), failed: true },
      { ...(await fillTx("old", watched, 9_000_000n, 1n)), blockTime: RECENT - 3_600n },
    ];
    const { code, alerts } = await once("--max-fill", `${watched}=5000`, "--max-fills", "3", "--max-fill", `${other}=9000000`);
    expect(code).toBe(EXIT_ALERTED);
    const intent = alerts[0]?.["intent"];
    expect(alerts).toEqual([
      { kind: "fill-amount", field: watched, expected: "5000", observed: "5001", slot: 40, intent, signature: testSignature("big") },
      { kind: "fill-rate", field: "fills", expected: 3, observed: 4, slot: 43, interval: 30 },
    ]);
    const quiet = await once("--max-fill", `${watched}=5001`, "--max-fills", "4");
    expect(quiet.alerts).toEqual([]);
    expect(quiet.code).toBe(EXIT_OK);
  });

  it("the monitor with --once reads fills as far back as --since", async () => {
    await baseline();
    const mint = (await generateKeyPairSigner()).address;
    h.engineLog = [
      { ...(await fillTx("hour-old", mint, 5_001n, 7n)), blockTime: RECENT - 3_600n },
      { ...(await fillTx("too-old", mint, 9_000n, 6n)), blockTime: RECENT - 3_901n },
    ];
    expect(await once("--max-fill", `${mint}=5000`)).toMatchObject({ code: EXIT_OK, alerts: [] });
    const { code, alerts } = await once("--max-fill", `${mint}=5000`, "--since", "3900");
    expect(code).toBe(EXIT_ALERTED);
    expect(alerts).toEqual([{ kind: "fill-amount", field: mint, expected: "5000", observed: "5001", slot: 7, intent: alerts[0]?.["intent"], signature: testSignature("hour-old") }]);
  });

  it("the monitor stays quiet when nothing changed", async () => {
    await baseline();
    const mint = (await generateKeyPairSigner()).address;
    h.engineLog = [await fillTx("one", mint, 10n, 5n)];
    const first = await once("--max-fill", `${mint}=10`, "--max-fills", "1");
    expect(first).toMatchObject({ code: EXIT_OK, alerts: [] });
    const running = await watch(["monitor", "--expect", BASELINE, "--interval", "5", "--max-fill", `${mint}=10`, "--max-fills", "1"], 6);
    expect(running.out).toEqual([]);
    expect(running.code).toBe(EXIT_OK);
    expect(h.sleeps.slice(-6)).toEqual([5, 5, 5, 5, 5, 5]);
    expect(h.wires).toEqual([]);
    expect(h.submitted).toEqual([]);
  });

  it("the monitor alerts once per change, not on every poll", async () => {
    await baseline();
    await changeConfig({ feeBps: 7 });
    const run = await watch(["monitor", "--expect", BASELINE], 6, async (poll) => {
      advance();
      if (poll === 2) {
        await changeConfig({ feeBps: 8 });
      }
      if (poll === 3) {
        await changeConfig({ feeBps: 5 });
      }
      if (poll === 4) {
        await changeConfig({ feeBps: 7 });
      }
    });
    expect(run.code).toBe(EXIT_ALERTED);
    expect(run.alerts.map((a) => [a.field, a.expected, a.observed])).toEqual([
      ["feeBps", 5, 7],
      ["feeBps", 5, 8],
      ["feeBps", 5, 7],
    ]);
  });

  it("the monitor alerts when its rpc fails or stalls", async () => {
    await baseline();
    let down = true;
    const failing: Transport = {
      ...listing,
      getAccounts: async (addresses) => {
        if (down) {
          throw new Error("fetch to https://rpc.example.com/key-abc123 failed");
        }
        return listing.getAccounts(addresses);
      },
    };
    h.through = failing;
    const failed = await once();
    expect(failed.code).toBe(EXIT_ALERTED);
    expect(failed.alerts).toEqual([
      { kind: "rpc", field: "read", expected: "a successful read", observed: "fetch to https://rpc.example.com/key-abc123 failed", slot: null, rpc: "http://127.0.0.1:8899" },
    ]);
    const outage = await watch(["monitor", "--expect", BASELINE, "--url", "https://rpc.example.com/key-abc123"], 5, (poll) => {
      advance();
      down = poll !== 2;
    });
    expect(outage.alerts.map((a) => [a.kind, a.field])).toEqual([
      ["rpc", "read"],
      ["rpc", "read"],
    ]);
    expect(JSON.stringify(outage)).not.toContain("key-abc123");
    expect(outage.alerts[1]?.slot).toBe(Number(h.svm.getClock().slot) - 3);
    down = false;
    const stalled = await watch(["monitor", "--expect", BASELINE], 8, () => undefined);
    const slot = Number(h.svm.getClock().slot);
    expect(stalled.code).toBe(EXIT_ALERTED);
    expect(stalled.alerts).toEqual([{ kind: "rpc", field: "slot", expected: `a slot above ${slot}`, observed: slot, slot, intervals: 3 }]);
    expect(stalled.out).toHaveLength(1);
  });

  it("the monitor posts alerts to its webhook without printing the url", async () => {
    await baseline();
    await changeConfig({ feeBps: 7 });
    h.jupiterReplies = [{ status: 500, body: {} }];
    const run = await watch(["monitor", "--expect", BASELINE, "--webhook", WEBHOOK], 3, async (poll) => {
      advance();
      if (poll === 1) {
        await changeConfig({ feeBps: 7, paused: 1 });
      }
    });
    expect(run.alerts.map((a) => a.field)).toEqual(["feeBps", "paused"]);
    expect(h.fetched.map((f) => f.url)).toEqual([WEBHOOK, WEBHOOK]);
    expect(h.fetched.map((f) => JSON.parse(f.body ?? "{}") as Alert)).toEqual(run.alerts);
    expect(h.fetched[0]?.headers).toEqual({ "content-type": "application/json" });
    expect(run.err).toContain("https://alerts.example.com");
    expect(run.err).toContain("answered 500");
    expect(run.err).toContain("answered 503");
    expect(`${run.out.join("\n")}\n${run.err}`).not.toContain(SECRET_PATH);
    expect(`${run.out.join("\n")}\n${run.err}`).not.toContain("s3cret");
    const bad = await cli(["monitor", "--expect", BASELINE, "--webhook", "http://alerts.example.com" + SECRET_PATH], {});
    expect(bad.code).toBe(EXIT_USAGE);
    expect(bad.err).toBe("--webhook must be an https url");
  });

  it("the monitor refuses to start without a baseline", async () => {
    const bare = await cli(["monitor"], {});
    expect(bare.code).toBe(EXIT_USAGE);
    expect(bare.err).toBe(MONITOR_NEEDS_BASELINE);
    expect(bare.err).toContain("--write-baseline");
    expect(bare.out).toBe("");
    const absent = await cli(["monitor", "--expect", BASELINE, "--once"], {});
    expect(absent.code).toBe(EXIT_USAGE);
    expect(absent.err).toContain("--write-baseline");
    h.files.set(BASELINE, "{\"program\":\"x\"}");
    const broken = await cli(["monitor", "--expect", BASELINE, "--once"], {});
    expect(broken.code).toBe(EXIT_USAGE);
    expect(broken.err).toContain("is not a monitor baseline");
    const overwrite = await cli(["monitor", "--write-baseline", BASELINE], {});
    expect(overwrite.code).toBe(EXIT_USAGE);
    expect(overwrite.err).toContain("never overwrites");
    expect(h.files.get(BASELINE)).toBe("{\"program\":\"x\"}");
    const mixed = await cli(["monitor", "--write-baseline", "/srv/other.json", "--once"], {});
    expect(mixed.code).toBe(EXIT_USAGE);
    expect((await cli(["monitor", "--expect", BASELINE, "--interval", "4"], {})).err).toBe("--interval must be an integer from 5 to 3600");
    expect((await cli(["monitor", "--expect", BASELINE, "--keypair", "k.json"], {})).err).toBe("monitor does not take --keypair");
    expect(h.wires).toEqual([]);
  });
});
