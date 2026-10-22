import type { Address, KeyPairSigner } from "@solana/kit";
import type { EngineAccountFilter, Transport } from "@intent-engine/client";
import { getMintCapSize, isMintCapData, MINT_CAP_DISCRIMINATOR } from "@intent-engine/core";
import { beforeEach, describe, expect, it } from "vitest";
import { EXIT_OK } from "../src/main.js";
import { MINT_CAP_FILTER } from "../src/monitor-limits.js";
import { cli, h, type World, world } from "./harness.js";
import { listing, matches } from "./monitor-transport.js";

const BASELINE = "/srv/monitor/filtered.json";

type Listed = Awaited<ReturnType<NonNullable<Transport["engineAccounts"]>>>;

const listAll = (filter?: EngineAccountFilter): Promise<Listed> => {
  if (listing.engineAccounts === undefined) {
    throw new Error("the test transport lists accounts");
  }
  return listing.engineAccounts(filter);
};

describe("monitor reads only mint cap accounts", () => {
  let w: World;
  let keys: Record<string, KeyPairSigner>;
  let asked: (EngineAccountFilter | undefined)[];
  let returned: Listed;

  beforeEach(async () => {
    w = await world();
    keys = { "admin.json": w.authority };
    asked = [];
    returned = [];
    const recording: Transport = {
      ...listing,
      engineAccounts: async (filter) => {
        asked.push(filter);
        const found = await listAll(filter);
        returned.push(...found);
        return found;
      },
    };
    h.through = recording;
  });

  const cap = async (mint: Address) => {
    const sent = await cli(
      ["set-mint-cap", "--mint", mint, "--max-per-order", "5", "--window-cap", "50", "--window-secs", "60", "--total-limit", "500", "--keypair", "admin.json", "--yes"],
      keys,
    );
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
  };

  it("the filter names the mint cap discriminator and its fixed size", () => {
    expect(MINT_CAP_FILTER).toEqual({ discriminator: MINT_CAP_DISCRIMINATOR, dataSize: getMintCapSize() });
  });

  it("the monitor asks for mint cap accounts only and gets no other engine account", async () => {
    await cap(w.inputMint);
    await cap(w.outputMint);
    asked = [];
    returned = [];
    const written = await cli(["monitor", "--write-baseline", BASELINE], {});
    expect([written.code, written.err]).toEqual([EXIT_OK, ""]);
    expect(asked).toEqual([MINT_CAP_FILTER]);
    expect(returned.map((a) => isMintCapData(a.data))).toEqual([true, true]);
    expect(returned.every((a) => a.data.length === getMintCapSize())).toBe(true);
    const all = await listAll();
    expect(all.length).toBeGreaterThan(returned.length);
    expect(all.some((a) => !isMintCapData(a.data))).toBe(true);
    const run = await cli(["monitor", "--expect", BASELINE, "--once"], {});
    expect([run.code, run.out]).toEqual([EXIT_OK, ""]);
    expect(asked.slice(1)).toEqual([MINT_CAP_FILTER]);
  });

  it("the test transport drops accounts of another size or discriminator, as a node does", () => {
    const exact = new Uint8Array(getMintCapSize());
    exact.set(MINT_CAP_DISCRIMINATOR);
    const longer = new Uint8Array(getMintCapSize() + 1);
    longer.set(MINT_CAP_DISCRIMINATOR);
    const other = new Uint8Array(getMintCapSize());
    expect(matches(MINT_CAP_FILTER, exact)).toBe(true);
    expect(matches(MINT_CAP_FILTER, longer)).toBe(false);
    expect(matches(MINT_CAP_FILTER, other)).toBe(false);
    expect(matches({ discriminator: MINT_CAP_DISCRIMINATOR }, longer)).toBe(true);
    expect(matches({ discriminator: MINT_CAP_DISCRIMINATOR }, MINT_CAP_DISCRIMINATOR.slice(0, 4))).toBe(false);
    expect(matches(undefined, other)).toBe(true);
  });
});
