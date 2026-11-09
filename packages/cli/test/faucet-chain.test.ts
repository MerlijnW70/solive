import { describe, expect, it } from "vitest";
import { answers, bodies, DAY, forged, HOUR, iso, NOW, record, request, sends, world } from "./faucet-world.js";

const ADDRESS = "4JUfAhAtwAccPT4T8cmsxQBpBwNiaUJgwWt5c5bsvKAo";
const OTHER = "DyZVZ5Zp5kgXoCkUXLQKWf5J1ytwnWwzR7sKTYSkYaZw";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const sigFor = (n: number) => {
  let text = "";
  let value = n;
  do {
    text = B58[value % 58] + text;
    value = Math.floor(value / 58);
  } while (value > 0);
  return `Atk${text}`.padEnd(64, "Q");
};
const spam = (count: number) => Array.from({ length: count }, (_, n) => forged(sigFor(n), "", { slot: 2 * NOW + 10, time: NOW + 5 }));
const LIMIT = "Refused: the faucet sent its daily limit. Try again tomorrow, or request devnet SOL at https://faucet.solana.com.";

describe("the issue faucet is not stranded by anyone who writes to its wallet's history", { timeout: 600_000 }, () => {
  it("proves a lost transfer dead past 20001 spam entries by paging only to the wallet transaction it recorded at signing", () => {
    const faucet = world([request(7, ADDRESS)]);
    expect(faucet.run(NOW, { STUB_SEND: "lost-timeout" }).code).toBe(3);
    faucet.inject(spam(20_001));
    expect(faucet.run(NOW + HOUR).code).toBe(3);
    expect(faucet.run(NOW + DAY).code).toBe(0);
    expect(faucet.run(NOW + 30 * DAY)).toEqual({ code: 0, out: "", err: "" });
    expect(faucet.paid()).toHaveLength(1);
    expect(answers(faucet, 7)).toEqual([`Sent 0.5 devnet SOL to \`${ADDRESS}\`: https://explorer.solana.com/tx/${faucet.paid()[0]?.sig}?cluster=devnet`]);
  });

  it("gives a request whose history it cannot cover a final honest answer after 7 days, and never sends again", () => {
    const faucet = world([request(7, ADDRESS)]);
    faucet.run(NOW, { STUB_SEND: "lost-timeout" });
    faucet.inject(spam(5_000));
    const short = { FAUCET_SCAN_PAGES: "3" };
    expect(faucet.run(NOW + HOUR, short).code).toBe(3);
    expect(faucet.run(NOW + DAY, short).code).toBe(3);
    const end = faucet.run(NOW + 8 * DAY, short);
    expect(end.code).toBe(4);
    expect(end.out).toMatch(/^Closed undecided: request 7, transaction \w+\.$/);
    expect(bodies(faucet, 7, "Closed undecided: the faucet could not prove within 7 days whether transaction ")).toHaveLength(1);
    expect(faucet.issue(7)?.state).toBe("closed");
    expect(faucet.issue(7)?.labels).toEqual(["faucet"]);
    expect(faucet.run(NOW + 9 * DAY, short)).toEqual({ code: 0, out: "", err: "" });
    expect(sends(faucet)).toHaveLength(1);
  });

  it("stops counting a pending request toward the cap a day after its last change", () => {
    const old = NOW - 2 * DAY;
    const stale = request(200, OTHER, { labels: ["faucet", "faucet-pending"], updatedAt: iso(old), comments: [{ author: "github-actions", body: record(OTHER, sigFor(9), 2 * NOW, 2 * NOW + 150, old) }] });
    const done = Array.from({ length: 49 }, (_, at) => request(100 + at, OTHER, { labels: ["faucet", "faucet-sent"], state: "closed" as const, closedAt: iso(NOW - HOUR) }));
    const faucet = world([...done, stale, request(201, ADDRESS)]);
    expect(faucet.run(NOW).code).toBe(3);
    expect(faucet.issue(201)?.labels).toContain("faucet-sent");
    const fresh = world([...done, { ...stale, updatedAt: iso(NOW - HOUR) }, request(201, ADDRESS)]);
    fresh.run(NOW);
    expect(fresh.issue(201)?.comments.at(-1)?.body).toBe(LIMIT);
  });
});

describe("the issue faucet believes only transfers its own wallet signed", { timeout: 600_000 }, () => {
  it("ignores a forged memo transfer to its wallet and pays the request itself", () => {
    const faucet = world([request(7, ADDRESS)]);
    faucet.inject([forged(sigFor(1), "faucet request 7")]);
    const run = faucet.run(NOW);
    expect(run.code).toBe(0);
    expect(sends(faucet)).toHaveLength(1);
    expect(run.out).toContain(`/tx/${faucet.paid()[0]?.sig}?`);
    expect(run.out).not.toContain(sigFor(1));
  });

  it("ignores a forged memo transfer while its own transfer is lost, and retries", () => {
    const faucet = world([request(7, ADDRESS)]);
    faucet.run(NOW, { STUB_SEND: "lost-timeout" });
    faucet.inject([forged(sigFor(2), "faucet request 7", { slot: 2 * NOW + 3, time: NOW + 2 })]);
    const doubt = faucet.run(NOW + HOUR);
    expect(doubt.code).toBe(3);
    expect(doubt.out).not.toContain(sigFor(2));
    expect(faucet.run(NOW + 3 * HOUR).code).toBe(0);
    expect(faucet.paid()).toHaveLength(1);
    expect(answers(faucet, 7)[0]).toContain(faucet.paid()[0]?.sig ?? "?");
  });

  it("ignores a memo transfer of the right amount to the right address that another wallet paid", () => {
    const faucet = world([request(7, ADDRESS)]);
    faucet.inject([forged(sigFor(3), "faucet request 7", { to: ADDRESS, lamports: 500_000_000 })]);
    expect(faucet.run(NOW).code).toBe(0);
    expect(faucet.paid()).toHaveLength(1);
    expect(answers(faucet, 7)[0]).not.toContain(sigFor(3));
  });

  it("serves real requests and counts nothing toward the cap when 50 forged memos target them", () => {
    const faucet = world([request(7, ADDRESS), request(8, OTHER)]);
    faucet.inject(Array.from({ length: 50 }, (_, n) => forged(sigFor(100 + n), `faucet request ${7 + n}`)));
    faucet.run(NOW);
    expect(faucet.paid().map((each) => each.to).sort()).toEqual([ADDRESS, OTHER].sort());
    expect(faucet.issue(7)?.labels).toContain("faucet-sent");
    expect(faucet.issue(8)?.labels).toContain("faucet-sent");
  });
});
