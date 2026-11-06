import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announcementCommitment } from "@intent-engine/core/internal";
import type { AnnouncementView, SpecFetch, Transport } from "@intent-engine/client";
import { DEVNET_GENESIS_HASH } from "@intent-engine/client/internal";
import { type Artifact, copyOf, judgeRoot, removeCopy } from "../src/artifact.js";
import { DeliveryUnfit, fetchDelivery, NOT_PUBLIC } from "../src/delivery-fetch.js";
import { sandboxDoctor } from "../src/sandbox-doctor.js";
import { SANDBOX_IMAGE } from "../src/sandbox.js";
import type { Lookup } from "../src/public-address.js";
import { FAST_LIMITS, scriptedDocker } from "./scripted-docker.js";

const faults = vi.hoisted(() => ({ write: false, copy: "" as "" | "fail" | "interrupt" }));

vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      if (faults.write) {
        faults.write = false;
        throw new Error("disk full");
      }
      return real.writeFile(...args);
    },
  };
});

vi.mock("../src/artifact.js", async (original) => {
  const real = await original<typeof import("../src/artifact.js")>();
  return {
    ...real,
    copyOf: async (...args: Parameters<typeof real.copyOf>) => {
      if (faults.copy === "fail") {
        throw new Error("copy failed");
      }
      const copy = await real.copyOf(...args);
      if (faults.copy === "interrupt") {
        process.emit("SIGINT", "SIGINT");
      }
      return copy;
    },
  };
});

const PUBLIC = { genesisHash: async () => DEVNET_GENESIS_HASH } as unknown as Transport;
const open: Lookup = async () => ["93.184.215.14"];
const inside: Lookup = async () => ["10.0.0.7"];
const SALT = new Uint8Array(16).fill(0xab);
const BYTES = new TextEncoder().encode("work\n");
const URL_OF = "https://" + "work.example.org/x/work.txt";
const entry = (path: string) => ({ path, bytes: new Uint8Array([1]), executable: 0 });
const colliding = (): Artifact => ({ sha256: "", single: false, entries: [entry("a"), entry("a/b")] });

async function delivery(url: string, bytes: Uint8Array = BYTES): Promise<{ announcement: AnnouncementView; salt: string; url: string }> {
  const intent = "SysvarRent111111111111111111111111111111111" as Address;
  const worker = "SysvarC1ock11111111111111111111111111111111" as Address;
  const commitment = await announcementCommitment(intent, worker, { delivered: Uint8Array.from(createHash("sha256").update(bytes).digest()), salt: SALT });
  return { announcement: { address: intent, intent, worker, commitment } as unknown as AnnouncementView, salt: Buffer.from(SALT).toString("hex"), url };
}

const serving =
  (bytes: Uint8Array): SpecFetch =>
  async () =>
    new Response(bytes);

const SAVED = { TMPDIR: process.env["TMPDIR"], PATH: process.env["PATH"], XDG_RUNTIME_DIR: process.env["XDG_RUNTIME_DIR"] };
let own = "";
let runtime = "";

const restore = (key: keyof typeof SAVED) => {
  const value = SAVED[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
};

const left = () => readdir(own);

beforeEach(async () => {
  own = await mkdtemp(join(tmpdir(), "temp-cleanup-own-"));
  runtime = await mkdtemp(join(tmpdir(), "temp-cleanup-runtime-"));
  process.env["TMPDIR"] = own;
  process.env["XDG_RUNTIME_DIR"] = runtime;
  faults.write = false;
  faults.copy = "";
});

afterEach(async () => {
  restore("TMPDIR");
  restore("PATH");
  restore("XDG_RUNTIME_DIR");
  faults.write = false;
  faults.copy = "";
  await rm(own, { recursive: true, force: true });
  await rm(runtime, { recursive: true, force: true });
});

describe("a fetched delivery", () => {
  it("lives in one directory that removeCopy takes away", async () => {
    const fetched = await fetchDelivery(serving(BYTES), PUBLIC, await delivery(URL_OF), 5, open);
    expect(await left()).toEqual([fetched.root.slice(own.length + 1)]);
    expect(await removeCopy(fetched.root)).toBeUndefined();
    expect(await left()).toEqual([]);
  });

  it("leaves nothing when the file cannot be written", async () => {
    faults.write = true;
    await expect(fetchDelivery(serving(BYTES), PUBLIC, await delivery(URL_OF), 5, open)).rejects.toThrow("disk full");
    expect(await left()).toEqual([]);
  });

  it("leaves nothing when the url is refused or the bytes do not match the announcement", async () => {
    const refused = await fetchDelivery(serving(BYTES), PUBLIC, await delivery(URL_OF), 5, inside).catch((error: unknown) => error);
    expect((refused as DeliveryUnfit).reason).toBe(NOT_PUBLIC);
    const other = await fetchDelivery(serving(new TextEncoder().encode("other\n")), PUBLIC, await delivery(URL_OF), 5, open).catch((error: unknown) => error);
    expect(other).toBeInstanceOf(DeliveryUnfit);
    expect(await left()).toEqual([]);
  });
});

describe("a judge copy", () => {
  it("is taken away by removeCopy", async () => {
    const root = await judgeRoot("judge-artifact-", false);
    expect(await left()).toHaveLength(1);
    expect(await removeCopy(root)).toBeUndefined();
    expect(await left()).toEqual([]);
  });

  it("leaves nothing when the artifact cannot be written out", async () => {
    await expect(copyOf(colliding(), new TextEncoder().encode("spec\n"))).rejects.toThrow();
    expect(await left()).toEqual([]);
  });

  it("leaves nothing when the check files cannot be written out", async () => {
    const check = { name: "check", read: colliding() };
    await expect(copyOf({ sha256: "", single: true, entries: [entry("one")] }, new TextEncoder().encode("spec\n"), check)).rejects.toThrow();
    expect(await left()).toEqual([]);
  });
});

describe.skipIf(process.platform !== "linux")("the sandbox doctor", () => {
  const BOX = { image: SANDBOX_IMAGE, memory: "1g", cpus: "1", tmp: "256m", gpu: false };

  async function scripted(): Promise<void> {
    const bin = await mkdtemp(join(tmpdir(), "temp-cleanup-bin-"));
    await writeFile(join(bin, "docker"), scriptedDocker(join(bin, "calls.log"), own, {}));
    await chmod(join(bin, "docker"), 0o755);
    process.env["PATH"] = bin;
  }

  it("leaves nothing after a full run", { timeout: 120_000 }, async () => {
    await scripted();
    const found = await sandboxDoctor(BOX, join(own, "judge.json"), async () => null, FAST_LIMITS);
    expect(found.checks.length).toBeGreaterThan(2);
    expect((await left()).filter((name) => name !== "judge.json" && !name.startsWith("temp-cleanup-bin-"))).toEqual([]);
  });

  it("leaves nothing when staging its files fails", async () => {
    await scripted();
    faults.copy = "fail";
    await expect(sandboxDoctor(BOX, join(own, "judge.json"), async () => null, FAST_LIMITS)).rejects.toThrow("copy failed");
    expect((await left()).filter((name) => !name.startsWith("temp-cleanup-bin-"))).toEqual([]);
  });

  it("stops at SIGINT, leaves nothing and exits 130", async () => {
    await scripted();
    faults.copy = "interrupt";
    const others = process.listeners("SIGINT");
    process.removeAllListeners("SIGINT");
    try {
      await expect(sandboxDoctor(BOX, join(own, "judge.json"), async () => null, FAST_LIMITS)).rejects.toMatchObject({ name: "JudgeInterrupted", exitCode: 130 });
    } finally {
      for (const listener of others) {
        process.on("SIGINT", listener as NodeJS.SignalsListener);
      }
    }
    expect(process.listenerCount("SIGINT")).toBe(others.length);
    expect((await left()).filter((name) => !name.startsWith("temp-cleanup-bin-"))).toEqual([]);
  });
});
