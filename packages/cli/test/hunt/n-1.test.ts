import { describe, expect, it } from "vitest";
import { buildSetCapsRequired, findConfigPda, getConfigDecoder } from "@intent-engine/core/internal";
import { EXIT_OK } from "../../src/main.js";
import { cli, h, send, world } from "../harness.js";
import { listAccounts } from "../monitor-transport.js";

const BASELINE = "/srv/hunt-n/caps-baseline.json";

type Alert = { kind: string } & Record<string, unknown>;

describe("hunt N operations monitor baseline", () => {
  it("N-1: admin flips capsRequired and the monitor does not alert", async () => {
    const w = await world();
    listAccounts();
    const written = await cli(["monitor", "--write-baseline", BASELINE], {});
    expect(written.code).toBe(EXIT_OK);

    const [configAddress] = await findConfigPda();
    const capsRequired = () => {
      const account = h.svm.getAccount(configAddress);
      if (!account.exists) {
        throw new Error("config missing");
      }
      return getConfigDecoder().decode(account.data).capsRequired;
    };

    const before = capsRequired();
    await send(w.authority, [await buildSetCapsRequired({ admin: w.authority, required: before === 0 })]);
    const after = capsRequired();
    expect(after).not.toBe(before);

    const run = await cli(["monitor", "--expect", BASELINE, "--once"], {});
    const alerts = run.out === "" ? [] : (run.each() as Alert[]);
    expect(alerts.map((alert) => alert.kind)).toContain("config");
  });
});
