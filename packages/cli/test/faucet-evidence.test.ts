import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { answers, HOUR, NOW, records, request, SCRIPT, sends, world } from "./faucet-world.js";

const ADDRESS = "4JUfAhAtwAccPT4T8cmsxQBpBwNiaUJgwWt5c5bsvKAo";
const OTHER = "DyZVZ5Zp5kgXoCkUXLQKWf5J1ytwnWwzR7sKTYSkYaZw";
const ambiguous = { STUB_SEND: "land-timeout", STUB_CONFIRM: "down" };
const iso = (at: number) => new Date(at * 1000).toISOString().replace(".000", "");
const sentToday = (count: number) =>
  Array.from({ length: count }, (_, at) => request(100 + at, OTHER, { labels: ["faucet", "faucet-sent"], state: "closed" as const, closedAt: iso(NOW - HOUR) }));

describe("the issue faucet decides a send is dead only on positive evidence", { timeout: 240_000 }, () => {
  it("finds a landed transfer in the payer's history when the status read wrongly says null", () => {
    const faucet = world([request(7, ADDRESS)]);
    expect(faucet.run(NOW, ambiguous).code).toBe(3);
    const run = faucet.run(NOW + HOUR, { STUB_CONFIRM: "forget" });
    expect(run.code).toBe(0);
    expect(faucet.landed()).toHaveLength(1);
    expect(sends(faucet)).toHaveLength(1);
    expect(answers(faucet, 7)).toHaveLength(1);
  });

  for (const history of ["unreachable", "empty", "pruned", "down"]) {
    it(`stays pending and never sends again when the status reads null and the history is ${history}`, () => {
      const faucet = world([request(7, ADDRESS)]);
      faucet.run(NOW, ambiguous);
      const blind = faucet.run(NOW + HOUR, { STUB_CONFIRM: "forget", STUB_HISTORY: history });
      expect(blind.code).toBe(3);
      expect(blind.out).toContain("Pending: request 7 waits for transaction ");
      expect(sends(faucet)).toHaveLength(1);
      expect(faucet.issue(7)?.labels).toContain("faucet-pending");
      expect(faucet.run(NOW + 2 * HOUR, { STUB_CONFIRM: "forget" }).code).toBe(0);
      expect(faucet.landed()).toHaveLength(1);
      expect(answers(faucet, 7)).toHaveLength(1);
    });
  }

  it("retries a transfer that never landed only once the history covers its whole validity window", () => {
    const faucet = world([request(7, ADDRESS)]);
    faucet.run(NOW, { STUB_SEND: "lost-timeout" });
    expect(faucet.run(NOW + HOUR, { STUB_HISTORY: "empty" }).code).toBe(3);
    expect(sends(faucet)).toHaveLength(1);
    expect(faucet.run(NOW + 2 * HOUR).code).toBe(0);
    expect(faucet.landed()).toHaveLength(1);
  });

  it("answers once and sends once when Sent was told, the label edit failed, and the next status read is null", () => {
    const faucet = world([request(7, ADDRESS)]);
    expect(faucet.run(NOW, { STUB_GH_FAIL: "--add-label faucet-sent" }).code).toBe(1);
    expect(faucet.run(NOW + HOUR, { STUB_CONFIRM: "forget", STUB_HISTORY: "unreachable" }).code).toBe(3);
    expect(faucet.run(NOW + 2 * HOUR, { STUB_CONFIRM: "forget" }).code).toBe(0);
    expect(faucet.landed()).toHaveLength(1);
    expect(answers(faucet, 7)).toHaveLength(1);
    expect(faucet.issue(7)?.state).toBe("closed");
  });

  it("answers Sent only for a finalized transfer, not a confirmed one", () => {
    const faucet = world([request(7, ADDRESS)]);
    const run = faucet.run(NOW, { STUB_CONFIRM: "confirmed" });
    expect(run.code).toBe(3);
    expect(answers(faucet, 7)).toEqual([]);
    expect(faucet.issue(7)?.state).toBe("open");
    expect(faucet.run(NOW + HOUR).code).toBe(0);
    expect(answers(faucet, 7)).toHaveLength(1);
    expect(faucet.landed()).toHaveLength(1);
  });
});

describe("the issue faucet counts attempts, closed requests and lost records honestly", { timeout: 240_000 }, () => {
  it("counts only transfers it sent as tries, not records of runs that stepped aside", async () => {
    const faucet = world([request(7, ADDRESS)]);
    const extra = { STUB_BARRIER: join(faucet.dir, "barrier") };
    await Promise.all([faucet.start(NOW, extra), faucet.start(NOW, extra)]);
    faucet.run(NOW + HOUR, { STUB_SEND: "lost-timeout" });
    faucet.run(NOW + 2 * HOUR, { STUB_SEND: "lost-timeout" });
    const third = faucet.run(NOW + 3 * HOUR);
    expect(records(faucet, 7)).toHaveLength(5);
    expect(sends(faucet)).toHaveLength(3);
    expect(third.out).not.toContain("tried 3 times");
    expect(faucet.landed()).toHaveLength(1);
    expect(answers(faucet, 7)).toHaveLength(1);
  });

  it("counts a pending request its author closed toward the cap, then answers it", () => {
    const faucet = world([...sentToday(49), request(7, ADDRESS)]);
    expect(faucet.run(NOW, ambiguous).code).toBe(3);
    faucet.edit((issues) => {
      Object.assign(issues.find((each) => each.number === 7) ?? {}, { state: "closed", closedAt: iso(NOW) });
      issues.push(request(300, OTHER, { author: "late" }));
    });
    expect(faucet.run(NOW, { STUB_CONFIRM: "down" }).code).toBe(3);
    expect(faucet.issue(300)?.comments.at(-1)?.body).toBe("Refused: the faucet sent its daily limit. Try again tomorrow, or request devnet SOL at https://faucet.solana.com.");
    expect(faucet.run(NOW + 60).code).toBe(0);
    expect(faucet.landed()).toHaveLength(1);
    expect(answers(faucet, 7)).toHaveLength(1);
    expect(faucet.issue(7)?.labels).toEqual(["faucet", "faucet-sent"]);
  });

  it("tells the author of a closed request whose transfer never landed that nothing was sent, and sends nothing more", () => {
    const faucet = world([request(7, ADDRESS)]);
    faucet.run(NOW, { STUB_SEND: "lost-timeout" });
    faucet.edit((issues) => Object.assign(issues[0] ?? {}, { state: "closed" }));
    expect(faucet.run(NOW + HOUR).code).toBe(0);
    expect(faucet.issue(7)?.comments.at(-1)?.body).toBe("Nothing was sent: this request was closed before its transfer landed.");
    expect(faucet.issue(7)?.labels).toEqual(["faucet"]);
    expect(faucet.run(NOW + 2 * HOUR).out).toBe("");
    expect(sends(faucet)).toHaveLength(1);
  });

  it("finds a landed transfer by its memo when the record comment was deleted", () => {
    const faucet = world([request(7, ADDRESS)]);
    faucet.run(NOW, ambiguous);
    faucet.edit((issues) => Object.assign(issues[0] ?? {}, { comments: [] }));
    expect(faucet.run(NOW + HOUR).code).toBe(0);
    expect(faucet.landed()).toHaveLength(1);
    expect(answers(faucet, 7)).toHaveLength(1);
  });

  it("finds a landed transfer by its memo before it sends, when the record and the label were both removed", () => {
    const faucet = world([request(7, ADDRESS)]);
    faucet.run(NOW, ambiguous);
    faucet.edit((issues) => Object.assign(issues[0] ?? {}, { comments: [], labels: ["faucet"] }));
    expect(faucet.run(NOW + HOUR).code).toBe(0);
    expect(sends(faucet)).toHaveLength(1);
    expect(answers(faucet, 7)).toHaveLength(1);
  });

  it("never sends blindly for a pending label without a record when devnet shows no transfer", () => {
    const faucet = world([request(7, ADDRESS)]);
    faucet.run(NOW, { STUB_SEND: "lost-timeout" });
    faucet.edit((issues) => Object.assign(issues[0] ?? {}, { comments: [] }));
    const run = faucet.run(NOW + HOUR);
    expect(run.code).toBe(3);
    expect(run.out).toContain("carries faucet-pending but no transfer record");
    expect(sends(faucet)).toHaveLength(1);
  });

  it("resolves a pending request that more than 100 newer issues push out of the open list", () => {
    const faucet = world([request(5, ADDRESS)]);
    faucet.run(NOW, ambiguous);
    faucet.edit((issues) => {
      for (let at = 0; at < 150; at += 1) issues.push(request(1000 + at, OTHER, { labels: ["faucet", "faucet-sent"] }));
    });
    expect(faucet.run(NOW + HOUR).code).toBe(0);
    expect(answers(faucet, 5)).toHaveLength(1);
    expect(faucet.issue(5)?.state).toBe("closed");
  });
});

describe("the issue faucet runs one at a time and exits with a documented code", { timeout: 240_000 }, () => {
  it("sends nothing while another faucet run is in progress, even when GitHub shows comments late", async () => {
    const faucet = world([request(7, ADDRESS)]);
    const runs = await Promise.all([
      faucet.start(NOW, { GITHUB_RUN_ID: "11", RUN_ID: "a", STUB_RUNS: "11,12", STUB_LAG: "60000", FAUCET_SETTLE: "1" }),
      faucet.start(NOW, { GITHUB_RUN_ID: "12", RUN_ID: "b", STUB_RUNS: "11,12", STUB_LAG: "60000", FAUCET_SETTLE: "1", STUB_HEIGHT: String(2 * NOW + 1) }),
    ]);
    expect(runs.map((r) => r.code)).toEqual([3, 3]);
    expect(sends(faucet)).toEqual([]);
  });

  it("refuses to run outside the workflow or without its concurrency group", () => {
    const faucet = world([request(7, ADDRESS)]);
    const copy = join(faucet.dir, "copy");
    mkdirSync(join(copy, "scripts"), { recursive: true });
    mkdirSync(join(copy, ".github/workflows"), { recursive: true });
    for (const name of ["faucet.sh", "faucet-parse.mjs"]) copyFileSync(join(SCRIPT, "..", name), join(copy, "scripts", name));
    const workflow = readFileSync(join(SCRIPT, "../../.github/workflows/faucet.yml"), "utf8");
    writeFileSync(join(copy, ".github/workflows/faucet.yml"), workflow.replace("cancel-in-progress: false", "cancel-in-progress: true"));
    const run = faucet.run(NOW, { FAUCET_SCRIPT: join(copy, "scripts/faucet.sh") });
    expect(run.code).toBe(2);
    expect(run.err).toContain("concurrency group");
    writeFileSync(join(copy, ".github/workflows/faucet.yml"), workflow);
    expect(faucet.run(NOW, { FAUCET_SCRIPT: join(copy, "scripts/faucet.sh") }).code).toBe(0);
    expect(faucet.run(NOW + HOUR, { GITHUB_RUN_ID: "" }).code).toBe(2);
  });

  it("maps every failing path to a documented exit code", () => {
    const fresh = () => world([request(7, ADDRESS)]);
    expect(fresh().run(NOW).code).toBe(0);
    expect(fresh().run(NOW, { FAUCET_URL: "nope" }).code).toBe(2);
    expect(fresh().run(NOW, ambiguous).code).toBe(3);
    expect(fresh().run(NOW, { STUB_GH_FAIL: "--label faucet-pending --state all", STUB_GH_CODE: "4" }).code).toBe(1);
    expect(fresh().run(NOW, { STUB_GH_FAIL: "gh run list", STUB_GH_CODE: "8" }).code).toBe(1);
    expect(fresh().run(NOW, { STUB_GH_FAIL: "--add-label faucet-sent", STUB_GH_CODE: "4" }).code).toBe(1);
    const closed = fresh();
    expect(closed.run(NOW, { STUB_GH_FAIL: "--label faucet-sent --state closed" }).code).toBe(1);
    expect(sends(closed)).toEqual([]);
  });
});
