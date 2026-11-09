import { describe, expect, it } from "vitest";
import { answers, bodies, check, DAY, forged, FUNDING, HOUR, marker, NOW, PAYER, record, request, sends, world, type Comment } from "./faucet-world.js";

const ADDRESS = "4JUfAhAtwAccPT4T8cmsxQBpBwNiaUJgwWt5c5bsvKAo";
const OTHER = "DyZVZ5Zp5kgXoCkUXLQKWf5J1ytwnWwzR7sKTYSkYaZw";
const OLD = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const FILED = NOW - DAY / 2;
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
const flood = (count: number, start: number, slot = 2 * NOW + 5, time = NOW + 5) =>
  Array.from({ length: count }, (_, n) => forged(sigFor(start + n), "faucet request 7", { slot, time }));
const bot = (body: string): Comment => ({ author: "github-actions", body });
const parks = (count: number) => Array.from({ length: count }, (_, at) => bot(`Retry after: 2026-10-10T${String(at).padStart(2, "0")}:00:00Z.`));
const sent = (sig: string) => `Sent 0.5 devnet SOL to \`${ADDRESS}\`: https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const idle = { code: 0, out: "", err: "" };

describe("forged memos never stop the retry of a request whose own transfers never landed", { timeout: 600_000 }, () => {
  for (const count of [50, 51, 120]) {
    it(`retries a lost send past ${count} forged memos and pays exactly once`, () => {
      const faucet = world([request(7, ADDRESS)]);
      expect(faucet.run(NOW, { STUB_SEND: "lost-timeout" }).code).toBe(3);
      faucet.inject(flood(count, 300));
      const doubt = faucet.run(NOW + HOUR);
      expect(doubt.code).toBe(3);
      expect(doubt.out).toContain("Pending: request 7 waits for transaction ");
      const retry = faucet.run(NOW + 3 * HOUR);
      expect(retry.code).toBe(0);
      expect(faucet.paid()).toHaveLength(1);
      expect(answers(faucet, 7)).toEqual([sent(faucet.paid()[0]?.sig ?? "?")]);
      expect(faucet.run(NOW + DAY)).toEqual(idle);
      expect(sends(faucet)).toHaveLength(2);
    });
  }

  it("pays a fresh request once when more forged memos name it than the faucet verifies", () => {
    const faucet = world([request(7, ADDRESS)]);
    faucet.inject(flood(51, 200, 2 * NOW - 10, NOW - 10));
    const run = faucet.run(NOW);
    expect(run.code).toBe(0);
    expect(run.out).toBe(sent(faucet.paid()[0]?.sig ?? "?"));
    expect(run.err).toBe("request 7: 1 entries with its memo were not verified; its own records list every faucet transfer for it");
    expect(faucet.paid()).toHaveLength(1);
  });

  it("parks a request whose transfer record is gone while forged memos outnumber the check, and names that cause", () => {
    const lost = sigFor(950);
    const faucet = world([request(7, ADDRESS, { comments: [marker(lost)] })]);
    faucet.inject(flood(51, 400, 2 * NOW - 10, NOW - 10));
    const run = faucet.run(NOW);
    expect(run.code).toBe(0);
    expect(run.out).toMatch(new RegExp(`^The faucet lost its record of transaction ${lost} for this request, .* Retry after: `));
    expect(sends(faucet)).toEqual([]);
    const last = world([request(7, ADDRESS, { comments: [marker(lost), ...parks(8)] })]);
    last.inject(flood(51, 400, 2 * NOW - 10, NOW - 10));
    expect(last.run(NOW).out).toBe(`Refused: the faucet lost its record of transaction ${lost} for this request and could not prove it never landed after 8 tries. Nothing was sent. File a new request to try again.`);
    expect(last.issue(7)?.state).toBe("closed");
    expect(sends(last)).toEqual([]);
  });

  it("counts no memo entry older than the request toward the limit", () => {
    const faucet = world([request(7, ADDRESS, { comments: [marker(sigFor(951))] })]);
    faucet.inject(flood(51, 500, 2 * NOW - 100_000, FILED - 10));
    expect(faucet.run(NOW).code).toBe(0);
    expect(faucet.paid()).toHaveLength(1);
  });

  it("keeps a request pending, then closes it undecided, when a sent transfer lost its record among forged memos", () => {
    const faucet = world([request(7, ADDRESS)]);
    faucet.run(NOW, { STUB_SEND: "lost-timeout" });
    const lost = sigFor(952);
    faucet.edit((issues) => issues[0]?.comments.push(marker(lost)));
    faucet.inject(flood(51, 600));
    for (const at of [HOUR, 3 * HOUR, DAY]) {
      const run = faucet.run(NOW + at);
      expect(run.code).toBe(3);
      expect(run.out).toBe(`Pending: request 7 waits for transaction ${lost} whose record is gone, while more entries carry its memo than the faucet verifies.`);
    }
    expect(faucet.run(NOW + 7 * DAY).code).toBe(4);
    expect(bodies(faucet, 7, `Closed undecided: the faucet could not prove within 7 days whether transaction ${lost} landed`)).toHaveLength(1);
    expect(sends(faucet)).toHaveLength(1);
  });

  it("refuses after 8 unreadable histories with that reason, not an unreachable devnet", () => {
    const faucet = world([request(7, ADDRESS, { comments: parks(8) })]);
    const run = faucet.run(NOW, { STUB_HISTORY: "unreachable" });
    expect(run.out).toBe("Refused: the faucet could not read its devnet history to check that nothing was sent for this request after 8 tries. Nothing was sent. File a new request to try again.");
    expect(sends(faucet)).toEqual([]);
  });
});

describe("a pending request without a record comment reaches an honest end", { timeout: 600_000 }, () => {
  const orphaned = () => {
    const faucet = world([request(7, ADDRESS)]);
    faucet.run(NOW, { STUB_SEND: "lost-timeout" });
    faucet.edit((issues) => Object.assign(issues[0] ?? {}, { comments: [] }));
    return faucet;
  };
  const searched = `the history of \`${PAYER}\` back to the request's creation shows no landed transfer from it with the memo`;

  it("answers a request whose record comment was deleted within 7 days of filing, and never sends again", () => {
    const faucet = orphaned();
    const early = faucet.run(NOW + HOUR);
    expect(early.code).toBe(3);
    expect(early.out).toBe(`Pending: request 7 carries faucet-pending but no transfer record, and ${searched}; it closes undecided 7 days after it was filed.`);
    expect(faucet.run(FILED + 7 * DAY - 1).code).toBe(3);
    const end = faucet.run(FILED + 7 * DAY);
    expect(end.code).toBe(4);
    expect(end.out).toBe(`Closed undecided: request 7 has no transfer record, and ${searched}.`);
    expect(bodies(faucet, 7, "Closed undecided: the faucet lost the record of its transfer for this request")).toHaveLength(1);
    expect(faucet.issue(7)?.state).toBe("closed");
    expect(faucet.issue(7)?.labels).toEqual(["faucet"]);
    expect(faucet.run(FILED + 30 * DAY)).toEqual(idle);
    expect(sends(faucet)).toHaveLength(1);
  });

  it("ends a request whose body was edited to name no address, and never sends again", () => {
    const faucet = orphaned();
    faucet.edit((issues) => Object.assign(issues[0] ?? {}, { body: "### Wallet address\n\nmy wallet" }));
    const early = faucet.run(NOW + HOUR);
    expect(early.code).toBe(3);
    expect(early.out).toContain(searched);
    expect(faucet.run(FILED + 7 * DAY).code).toBe(4);
    expect(faucet.issue(7)?.state).toBe("closed");
    expect(sends(faucet)).toHaveLength(1);
  });

  it("answers with the address its landed transfer paid when the record is gone and the body names another", () => {
    const faucet = world([request(7, ADDRESS)]);
    faucet.run(NOW, { STUB_SEND: "land-timeout", STUB_CONFIRM: "down" });
    faucet.edit((issues) => Object.assign(issues[0] ?? {}, { comments: [], body: `### Wallet address\n\n${OTHER}` }));
    const run = faucet.run(NOW + HOUR);
    expect(run.code).toBe(0);
    expect(run.out).toBe(sent(faucet.paid()[0]?.sig ?? "?"));
    expect(faucet.landed()).toHaveLength(1);
  });

  for (const [name, extra, said] of [
    ["unreachable", { STUB_HISTORY: "unreachable" }, `the faucet could not read the history of \`${PAYER}\` back to the request's creation`],
    ["flooded", {}, `more entries in the history of \`${PAYER}\` carry its memo than the faucet verifies`],
  ] as const) {
    it(`states only what it proved when the history is ${name}`, () => {
      const faucet = orphaned();
      faucet.inject(flood(51, 700));
      const run = faucet.run(NOW + HOUR, extra);
      expect(run.code).toBe(3);
      expect(run.out).toContain(said);
      expect(run.out).not.toContain("shows no landed transfer");
      expect(sends(faucet)).toHaveLength(1);
    });
  }

  it("ends a closed request that lost its record too", () => {
    const faucet = orphaned();
    faucet.edit((issues) => Object.assign(issues[0] ?? {}, { state: "closed" }));
    expect(faucet.run(FILED + 7 * DAY).code).toBe(4);
    expect(faucet.issue(7)?.labels).toEqual(["faucet"]);
    expect(faucet.run(FILED + 8 * DAY)).toEqual(idle);
  });
});

describe("each transfer record is scanned against its own payer", { timeout: 600_000 }, () => {
  const SA = sigFor(900);
  const SB = sigFor(901);
  const keyed = (comments: Comment[]) => world([request(7, ADDRESS, { labels: ["faucet", "faucet-pending"], comments })]);
  const both = [
    bot(record(ADDRESS, SA, 2 * NOW - 2000, 2 * NOW - 1850, NOW - 5 * HOUR, FUNDING, OLD)),
    marker(SA),
    bot(check(SA, NOW - 4 * HOUR)),
    bot(record(ADDRESS, SB, 2 * NOW - 1200, 2 * NOW - 1000, NOW - 4 * HOUR)),
    marker(SB),
    bot(check(SB, NOW - 3 * HOUR)),
  ];
  const wallets = { STUB_CONFIRM: "forget", STUB_WALLETS: `${PAYER},${OLD}` };

  it("finds the landed transfer of an earlier key when a later record names the new key", () => {
    const faucet = keyed(both);
    faucet.inject([{ sig: SA, from: OLD, to: ADDRESS, lamports: 500_000_000, slot: 2 * NOW - 1990, time: NOW - 5 * HOUR + 5, memo: "faucet request 7" }]);
    const run = faucet.run(NOW, wallets);
    expect(run.code).toBe(0);
    expect(run.out).toBe(sent(SA));
    expect(sends(faucet)).toEqual([]);
    expect(faucet.landed()).toHaveLength(1);
  });

  it("retries from the new key once the old key's history proves its transfer dead", () => {
    const faucet = keyed(both);
    expect(faucet.run(NOW, { STUB_WALLETS: wallets.STUB_WALLETS }).code).toBe(0);
    expect(faucet.paid()).toHaveLength(1);
    expect(answers(faucet, 7)).toEqual([sent(faucet.paid()[0]?.sig ?? "?")]);
    expect(faucet.landed()).toHaveLength(1);
  });

  it("reads one wallet's history from the oldest anchor among its open records", () => {
    const faucet = keyed([
      bot(record(ADDRESS, SA, 2 * NOW - 2000, 2 * NOW - 1850, NOW - 5 * HOUR)),
      marker(SA),
      bot(check(SA, NOW - 4 * HOUR)),
      bot(record(ADDRESS, SB, 2 * NOW - 1200, 2 * NOW - 1000, NOW - 4 * HOUR, SA)),
      marker(SB),
      bot(check(SB, NOW - 3 * HOUR)),
    ]);
    faucet.inject(flood(51, 800, 2 * NOW - 3000, FILED + 10));
    faucet.inject([{ sig: SA, from: PAYER, to: ADDRESS, lamports: 500_000_000, slot: 2 * NOW - 1990, time: NOW - 5 * HOUR + 5, memo: "faucet request 7" }]);
    const run = faucet.run(NOW, { STUB_CONFIRM: "forget" });
    expect(run.code).toBe(0);
    expect(run.out).toBe(sent(SA));
    expect(sends(faucet)).toEqual([]);
  });

  it("never sends while the old key's history cannot be covered", () => {
    const faucet = keyed(both);
    for (const at of [0, 3 * HOUR, DAY]) expect(faucet.run(NOW + at, { STUB_CONFIRM: "forget" }).code).toBe(3);
    expect(sends(faucet)).toEqual([]);
    expect(faucet.landed()).toEqual([]);
  });
});
