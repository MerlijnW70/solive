import type { Address, KeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { EXIT_ALERTED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { BASELINE_ALONE, SINCE_NEEDS_ONCE } from "../src/monitor-args.js";
import { CANNOT_LIST } from "../src/monitor-limits.js";
import { cli, h, transport, type World, world } from "./harness.js";
import { listAccounts } from "./monitor-transport.js";

const BASELINE = "/srv/monitor/limits.json";

type Json = Record<string, unknown>;

const byMint = (a: Json, b: Json) => String(a["mint"]).localeCompare(String(b["mint"]));

describe("monitor of committee floors and mint cap limits", () => {
  let w: World;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    w = await world();
    keys = { "admin.json": w.authority };
    listAccounts();
  });

  const admin = async (...argv: string[]) => {
    const sent = await cli([...argv, "--keypair", "admin.json", "--yes"], keys);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
  };

  const floor = (mint: Address, amount: string) => admin("set-committee-floor", "--mint", mint, "--floor", amount);

  const cap = (mint: Address, max: string, window: string, secs: string, total: string) =>
    admin("set-mint-cap", "--mint", mint, "--max-per-order", max, "--window-cap", window, "--window-secs", secs, "--total-limit", total);

  const write = async () => {
    const written = await cli(["monitor", "--write-baseline", BASELINE], {});
    expect([written.code, written.err]).toEqual([EXIT_OK, ""]);
    return JSON.parse(h.files.get(BASELINE) ?? "{}") as Json;
  };

  const check = async () => {
    const run = await cli(["monitor", "--expect", BASELINE, "--once"], {});
    return { code: run.code, alerts: run.out === "" ? [] : run.each() };
  };

  const slot = () => Number(h.svm.getClock().slot);

  it("the baseline holds every committee floor and every mint cap's limits, and an unchanged world stays quiet", async () => {
    await floor(w.inputMint, "500");
    await cap(w.inputMint, "300", "5000", "3600", "9000");
    await cap(w.outputMint, "10", "10", "60", "0");
    const written = await write();
    expect(Object.keys(written)).toEqual(["program", "config", "committeeFloors", "mintCaps", "upgradeAuthority", "programHash"]);
    expect(written["committeeFloors"]).toEqual({ [w.inputMint]: "500" });
    expect(written["mintCaps"]).toEqual({
      [w.inputMint]: { maxPerOrder: "300", windowCap: "5000", windowSecs: 3600, totalLimit: "9000" },
      [w.outputMint]: { maxPerOrder: "10", windowCap: "10", windowSecs: 60, totalLimit: "0" },
    });
    expect(Object.keys(written["mintCaps"] as Json)).toEqual([w.inputMint, w.outputMint].sort());
    expect(await check()).toEqual({ code: EXIT_OK, alerts: [] });
  });

  it("the monitor alerts when a committee floor is lowered, added or cleared", async () => {
    await floor(w.inputMint, "500");
    await write();
    await floor(w.inputMint, "100");
    await floor(w.outputMint, "7");
    const changed = await check();
    expect(changed.code).toBe(EXIT_ALERTED);
    expect([...changed.alerts].sort(byMint)).toEqual(
      [
        { kind: "committee-floor", field: "floor", expected: "500", observed: "100", slot: slot(), mint: w.inputMint },
        { kind: "committee-floor", field: "floor", expected: "0", observed: "7", slot: slot(), mint: w.outputMint },
      ].sort(byMint),
    );
    await floor(w.outputMint, "0");
    await floor(w.inputMint, "0");
    expect(await check()).toEqual({
      code: EXIT_ALERTED,
      alerts: [{ kind: "committee-floor", field: "floor", expected: "500", observed: "0", slot: slot(), mint: w.inputMint }],
    });
  });

  it("the monitor alerts when a mint cap limit is raised or removed, or a new cap appears", async () => {
    await cap(w.inputMint, "300", "5000", "3600", "9000");
    await write();
    await cap(w.inputMint, "400", "5000", "7200", "0");
    const raised = await check();
    expect(raised).toEqual({
      code: EXIT_ALERTED,
      alerts: [
        { kind: "mint-cap-limit", field: "maxPerOrder", expected: "300", observed: "400", slot: slot(), mint: w.inputMint },
        { kind: "mint-cap-limit", field: "windowSecs", expected: 3600, observed: 7200, slot: slot(), mint: w.inputMint },
        { kind: "mint-cap-limit", field: "totalLimit", expected: "9000", observed: "0", slot: slot(), mint: w.inputMint },
      ],
    });
    await cap(w.inputMint, "300", "5000", "3600", "9000");
    await cap(w.outputMint, "10", "20", "60", "30");
    const added = await check();
    expect(added).toEqual({
      code: EXIT_ALERTED,
      alerts: [
        { kind: "mint-cap-limit", field: "maxPerOrder", expected: "missing", observed: "10", slot: slot(), mint: w.outputMint },
        { kind: "mint-cap-limit", field: "windowCap", expected: "missing", observed: "20", slot: slot(), mint: w.outputMint },
        { kind: "mint-cap-limit", field: "windowSecs", expected: "missing", observed: 60, slot: slot(), mint: w.outputMint },
        { kind: "mint-cap-limit", field: "totalLimit", expected: "missing", observed: "30", slot: slot(), mint: w.outputMint },
      ],
    });
  });

  it("a baseline without the floors or the mint caps is refused", async () => {
    await write();
    const full = JSON.parse(h.files.get(BASELINE) ?? "{}") as Json;
    for (const dropped of ["committeeFloors", "mintCaps"]) {
      h.files.set(BASELINE, JSON.stringify({ ...full, [dropped]: undefined }));
      const run = await cli(["monitor", "--expect", BASELINE, "--once"], {});
      expect([run.code, run.err]).toEqual([EXIT_USAGE, `--expect ${BASELINE} is not a monitor baseline; write one with monitor --write-baseline <file>`]);
    }
    h.files.set(BASELINE, JSON.stringify({ ...full, mintCaps: { [w.inputMint]: { maxPerOrder: "1", windowCap: "1", windowSecs: 60 } } }));
    expect((await cli(["monitor", "--expect", BASELINE, "--once"], {})).code).toBe(EXIT_USAGE);
    h.files.set(BASELINE, JSON.stringify({ ...full, committeeFloors: { [w.inputMint]: 5 } }));
    expect((await cli(["monitor", "--expect", BASELINE, "--once"], {})).code).toBe(EXIT_USAGE);
  });

  it("the monitor refuses a connection that cannot list the program's accounts", async () => {
    await write();
    h.through = transport;
    const written = await cli(["monitor", "--write-baseline", "/srv/monitor/unlisted.json"], {});
    expect(written.code).not.toBe(EXIT_OK);
    expect(written.err).toContain(CANNOT_LIST);
    expect(h.files.has("/srv/monitor/unlisted.json")).toBe(false);
    const run = await check();
    expect(run.code).toBe(EXIT_ALERTED);
    expect(run.alerts).toEqual([{ kind: "rpc", field: "read", expected: "a successful read", observed: CANNOT_LIST, slot: null, rpc: "http://127.0.0.1:8899" }]);
  });

  it("--since works only with --once and within its bounds", async () => {
    await write();
    const refused = async (argv: string[]) => {
      const run = await cli(["monitor", ...argv], {});
      expect(run.code).toBe(EXIT_USAGE);
      return run.err;
    };
    expect(await refused(["--expect", BASELINE, "--since", "3900"])).toBe(SINCE_NEEDS_ONCE);
    expect(await refused(["--expect", BASELINE, "--once", "--since", "0"])).toBe("--since must be an integer from 1 to 86400");
    expect(await refused(["--expect", BASELINE, "--once", "--since", "86401"])).toBe("--since must be an integer from 1 to 86400");
    expect(await refused(["--write-baseline", "/srv/monitor/other.json", "--since", "60"])).toBe(BASELINE_ALONE);
    expect((await cli(["monitor", "--expect", BASELINE, "--once", "--since", "86400"], {})).code).toBe(EXIT_OK);
  });
});
