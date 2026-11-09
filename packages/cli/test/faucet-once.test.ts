import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { answers, bodies, check, DAY, HOUR, NOW, record, records, request, ROOT, SCRIPT, world } from "./faucet-world.js";

const ADDRESS = "4JUfAhAtwAccPT4T8cmsxQBpBwNiaUJgwWt5c5bsvKAo";
const OTHER = "DyZVZ5Zp5kgXoCkUXLQKWf5J1ytwnWwzR7sKTYSkYaZw";
const SOL = 1_000_000_000;
const FOREIGN = "5".repeat(64);
const until = async (check: () => boolean) => {
  const end = Date.now() + 60_000;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((done) => setTimeout(done, 20));
  }
};

describe("the issue faucet pays each request at most once", { timeout: 240_000 }, () => {
  it("pays once across three runs when the transfer lands but the command times out and its status cannot be read", () => {
    const faucet = world([request(7, ADDRESS)]);
    const first = faucet.run(NOW, { STUB_SEND: "land-timeout", STUB_CONFIRM: "down" });
    expect(first.code).toBe(3);
    expect(faucet.landed()).toHaveLength(1);
    expect(faucet.issue(7)?.state).toBe("open");
    expect(faucet.issue(7)?.labels).toContain("faucet-pending");
    expect(records(faucet, 7)).toEqual([record(ADDRESS, faucet.landed()[0]?.sig ?? "", 2 * NOW, 2 * NOW + 150)]);
    expect(answers(faucet, 7)).toEqual([]);
    const second = faucet.run(NOW + HOUR);
    expect(second.code).toBe(0);
    const third = faucet.run(NOW + 2 * HOUR);
    expect(third).toEqual({ code: 0, out: "", err: "" });
    expect(faucet.landed()).toHaveLength(1);
    const sig = faucet.landed()[0]?.sig ?? "";
    expect(answers(faucet, 7)).toEqual([`Sent 0.5 devnet SOL to \`${ADDRESS}\`: https://explorer.solana.com/tx/${sig}?cluster=devnet`]);
    expect(faucet.issue(7)?.state).toBe("closed");
    expect(faucet.issue(7)?.labels).toEqual(["faucet", "faucet-sent"]);
  });

  it("answers in the same run when the transfer lands but the command times out", () => {
    const faucet = world([request(7, ADDRESS)]);
    const run = faucet.run(NOW, { STUB_SEND: "land-timeout" });
    expect(run.code).toBe(0);
    expect(faucet.landed()).toHaveLength(1);
    expect(run.out).toBe(`Sent 0.5 devnet SOL to \`${ADDRESS}\`: https://explorer.solana.com/tx/${faucet.landed()[0]?.sig}?cluster=devnet`);
    expect(faucet.issue(7)?.state).toBe("closed");
  });

  it("answers with the signature it signed when the transfer prints garbage", () => {
    const faucet = world([request(7, ADDRESS)]);
    const run = faucet.run(NOW, { STUB_SEND: "garbled" });
    expect(run.code).toBe(0);
    expect(faucet.landed()).toHaveLength(1);
    expect(run.out).toContain(`/tx/${faucet.landed()[0]?.sig}?cluster=devnet`);
  });

  it("leaves a transfer that timed out before it was sent alone until its blockhash expired, then retries once", () => {
    const faucet = world([request(7, ADDRESS)]);
    expect(faucet.run(NOW, { STUB_SEND: "lost-timeout" }).code).toBe(3);
    expect(faucet.issue(7)?.labels).toContain("faucet-pending");
    const again = faucet.run(NOW);
    expect(again.code).toBe(3);
    expect(again.out).toContain("Pending: request 7 waits for transaction ");
    expect(records(faucet, 7)).toHaveLength(1);
    expect(faucet.landed()).toEqual([]);
    expect(faucet.run(NOW + HOUR).code).toBe(3);
    expect(faucet.landed()).toEqual([]);
    expect(bodies(faucet, 7, "No transfer from transaction ")).toHaveLength(1);
    expect(faucet.run(NOW + 2 * HOUR).code).toBe(3);
    const retry = faucet.run(NOW + 3 * HOUR);
    expect(retry.code).toBe(0);
    expect(faucet.landed()).toHaveLength(1);
    expect(records(faucet, 7)).toHaveLength(2);
    expect(answers(faucet, 7)).toHaveLength(1);
    expect(faucet.issue(7)?.labels).toEqual(["faucet", "faucet-sent"]);
    expect(faucet.run(NOW + 4 * HOUR).out).toBe("");
    expect(faucet.landed()).toHaveLength(1);
  });

  it("counts pending sends toward the daily cap", () => {
    const closedAt = new Date((NOW - HOUR) * 1000).toISOString().replace(".000", "");
    const done = Array.from({ length: 49 }, (_, at) => request(100 + at, OTHER, { labels: ["faucet", "faucet-sent"], state: "closed" as const, closedAt }));
    const pending = request(200, OTHER, { labels: ["faucet", "faucet-pending"], comments: [{ author: "github-actions", body: record(OTHER, FOREIGN, 2 * NOW, 2 * NOW + 150) }] });
    const faucet = world([...done, pending, request(201, ADDRESS)]);
    const run = faucet.run(NOW);
    expect(run.code).toBe(3);
    expect(faucet.landed()).toEqual([]);
    expect(faucet.calls().filter((c) => c.startsWith("solana transfer"))).toEqual([]);
    expect(faucet.issue(201)?.state).toBe("closed");
    expect(faucet.issue(201)?.comments.at(-1)?.body).toBe("Refused: the faucet sent its daily limit. Try again tomorrow, or request devnet SOL at https://faucet.solana.com.");
    expect(faucet.issue(200)?.state).toBe("open");
  });

  it("resolves pending requests before it serves new ones, so an expired transfer stops counting toward the cap", () => {
    const closedAt = new Date((NOW - HOUR) * 1000).toISOString().replace(".000", "");
    const done = Array.from({ length: 49 }, (_, at) => request(100 + at, OTHER, { labels: ["faucet", "faucet-sent"], state: "closed" as const, closedAt }));
    const expired = request(300, OTHER, { labels: ["faucet", "faucet-pending"], comments: [
        { author: "github-actions", body: record(OTHER, FOREIGN, 2 * NOW - 1200, 2 * NOW - 1000, NOW - 4 * HOUR) },
        { author: "github-actions", body: check(FOREIGN, NOW - 3 * HOUR) },
      ] });
    const faucet = world([...done, request(299, ADDRESS), expired]);
    expect(faucet.run(NOW).code).toBe(0);
    expect(faucet.landed().map((each) => each.to)).toEqual([ADDRESS]);
    expect(faucet.issue(299)?.labels).toContain("faucet-sent");
    expect(faucet.issue(300)?.comments.at(-1)?.body).toBe("Refused: the faucet sent its daily limit. Try again tomorrow, or request devnet SOL at https://faucet.solana.com.");
    expect(faucet.issue(300)?.labels).toEqual(["faucet"]);
  });

  it("leaves a request alone while another run's transfer for it is in flight", async () => {
    const faucet = world([request(7, ADDRESS)]);
    const mark = join(faucet.dir, "mark");
    const release = join(faucet.dir, "release");
    const first = faucet.start(NOW, { STUB_SEND: "hang", STUB_MARK: mark, STUB_RELEASE: release });
    await until(() => existsSync(mark));
    const overlap = faucet.run(NOW, { STUB_HEIGHT: String(2 * NOW + 1) });
    expect(overlap.code).toBe(3);
    writeFileSync(release, "");
    expect((await first).code).toBe(0);
    expect(faucet.landed()).toHaveLength(1);
    expect(answers(faucet, 7)).toHaveLength(1);
  });

  it("pays once when two runs reach the send at the same moment", async () => {
    const faucet = world([request(7, ADDRESS)]);
    const barrier = join(faucet.dir, "barrier");
    const runs = await Promise.all([
      faucet.start(NOW, { STUB_BARRIER: barrier, STUB_HEIGHT: String(2 * NOW) }),
      faucet.start(NOW, { STUB_BARRIER: barrier, STUB_HEIGHT: String(2 * NOW + 1) }),
    ]);
    expect(faucet.landed()).toHaveLength(1);
    expect(runs.map((r) => r.code).sort()).toEqual([0, 3]);
    expect(answers(faucet, 7)).toHaveLength(1);
    expect(faucet.run(NOW + HOUR).code).toBe(0);
    expect(faucet.landed()).toHaveLength(1);
  });

  it("pays once, and answers once, when two runs sign the same transaction at the same moment", async () => {
    const faucet = world([request(7, ADDRESS)]);
    const extra = { STUB_BARRIER: join(faucet.dir, "barrier") };
    const runs = await Promise.all([faucet.start(NOW, extra), faucet.start(NOW, extra)]);
    expect(runs.map((r) => r.code)).toEqual([3, 3]);
    expect(faucet.landed()).toEqual([]);
    expect(faucet.run(NOW + HOUR).code).toBe(3);
    expect(faucet.run(NOW + 3 * HOUR).code).toBe(0);
    expect(faucet.landed()).toHaveLength(1);
    expect(answers(faucet, 7)).toHaveLength(1);
    expect(faucet.run(NOW + 4 * HOUR).out).toBe("");
  });

  it("leaves a pending request alone during an RPC outage and answers it once devnet is back", () => {
    const faucet = world([request(7, ADDRESS)]);
    faucet.run(NOW, { STUB_SEND: "land-timeout", STUB_CONFIRM: "down" });
    const comments = faucet.issue(7)?.comments.length;
    const outage = faucet.run(NOW + HOUR, { STUB_RPC: "down" });
    expect(outage.code).toBe(3);
    expect(faucet.issue(7)?.comments.length).toBe(comments);
    expect(faucet.issue(7)?.state).toBe("open");
    expect(faucet.run(NOW + 2 * HOUR).code).toBe(0);
    expect(faucet.landed()).toHaveLength(1);
    expect(answers(faucet, 7)).toHaveLength(1);
  });

  it("answers once and never sends again when the label edit fails after a landed transfer", () => {
    const faucet = world([request(7, ADDRESS)]);
    expect(faucet.run(NOW, { STUB_GH_FAIL: "--add-label faucet-sent" }).code).toBe(1);
    expect(faucet.landed()).toHaveLength(1);
    expect(faucet.run(NOW + HOUR).code).toBe(0);
    expect(faucet.landed()).toHaveLength(1);
    expect(answers(faucet, 7)).toHaveLength(1);
    expect(faucet.issue(7)?.state).toBe("closed");
  });

  it("sends nothing when the pending label cannot be set, and retries after the record expired", () => {
    const faucet = world([request(7, ADDRESS)]);
    expect(faucet.run(NOW, { STUB_GH_FAIL: "--add-label faucet-pending" }).code).toBe(1);
    expect(faucet.calls().filter((c) => c.startsWith("solana transfer") && !c.includes("--sign-only"))).toEqual([]);
    expect(records(faucet, 7)).toHaveLength(1);
    expect(faucet.run(NOW + HOUR).code).toBe(3);
    expect(faucet.run(NOW + 3 * HOUR).code).toBe(0);
    expect(faucet.landed()).toHaveLength(1);
  });

  it("decides by signature, not balance, for a wallet that holds SOL from elsewhere", () => {
    const faucet = world([request(7, ADDRESS)]);
    const held = { STUB_HELD: String(0.4 * SOL) };
    faucet.run(NOW, { ...held, STUB_SEND: "land-timeout", STUB_CONFIRM: "down" });
    expect(faucet.run(NOW + HOUR, held).code).toBe(0);
    expect(faucet.run(NOW + 2 * HOUR, held).code).toBe(0);
    expect(faucet.landed()).toHaveLength(1);
    const other = world([request(8, ADDRESS)]);
    const rich = { STUB_HELD: String(0.6 * SOL) };
    other.run(NOW, { ...rich, STUB_SEND: "lost-timeout" });
    expect(other.run(NOW + HOUR, rich).code).toBe(3);
    expect(other.run(NOW + 3 * HOUR, rich).code).toBe(0);
    expect(other.landed()).toHaveLength(1);
  });

  it("refuses honestly after three transfers that never landed, and never leaves the request open", () => {
    const faucet = world([request(7, ADDRESS)]);
    const lost = { STUB_SEND: "lost-timeout" };
    for (const at of [0, 3, 6, 9, 12, 15]) expect(faucet.run(NOW + at * HOUR, lost).code).toBe(3);
    const last = faucet.run(NOW + 18 * HOUR, lost);
    expect(last.code).toBe(0);
    expect(last.out).toBe(`Refused: the faucet tried 3 times to send to \`${ADDRESS}\` and no transfer landed. Nothing was sent. File a new request to try again.`);
    expect(records(faucet, 7)).toHaveLength(3);
    expect(faucet.landed()).toEqual([]);
    expect(faucet.issue(7)?.state).toBe("closed");
    expect(faucet.issue(7)?.labels).toEqual(["faucet"]);
    expect(faucet.run(NOW + 2 * DAY).out).toBe("");
  });

  it("ignores a transfer record that anyone but the faucet posts", () => {
    const faucet = world([request(7, ADDRESS, { comments: [{ author: "mallory", body: record(ADDRESS, FOREIGN, 2 * NOW, 2 * NOW + 150) }] })]);
    expect(faucet.run(NOW).code).toBe(0);
    expect(faucet.landed()).toHaveLength(1);
  });

  it("refuses a configuration it cannot run with exit 2, before it reads any request", () => {
    const faucet = world([request(7, ADDRESS)]);
    for (const extra of [{ FAUCET_KEYPAIR: "" }, { FAUCET_URL: "mainnet-beta" }, { FAUCET_URL: "ftp://x" }, { FAUCET_SETTLE: "-1" }, { FAUCET_FINALIZE: "x" }, { GITHUB_RUN_ID: "" }, { FAUCET_NOW: "soon" }]) {
      const run = faucet.run(NOW, extra);
      expect(run.code).toBe(2);
      expect(run.err.startsWith("refusing: ")).toBe(true);
    }
    expect(faucet.calls()).toEqual([]);
  });

  it("states every exit code it uses in the runbook", () => {
    const script = readFileSync(SCRIPT, "utf8") + readFileSync(join(ROOT, "scripts/faucet-settle.sh"), "utf8");
    const runbook = readFileSync(join(ROOT, "docs/maintainers/operations.md"), "utf8");
    const codes = [...new Set([...script.matchAll(/\bexit (\d+)/g)].map((m) => Number(m[1])))].filter((code) => code < 10).sort();
    expect(codes).toEqual([0, 1, 2, 3, 4]);
    for (const code of codes) expect(runbook).toMatch(new RegExp(`^\\| ${code} \\| `, "m"));
  });
});
