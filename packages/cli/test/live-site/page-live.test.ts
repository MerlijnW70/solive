import { describe, expect, it } from "vitest";
import type { FakeElement } from "./dom.js";
import { DEMO_WORKER, FILLER, FIZZBUZZ_HASH, type Feed, emptyFeed, fullFeed, houseFeed, quietFeed, signature, staleFeed } from "./fixtures.js";
import { NOW, anchors, ok, openPage } from "./page.js";

const EXPLORER_LINK = /^https:\/\/explorer\.solana\.com\/(tx\/[1-9A-HJ-NP-Za-km-z]{87,88}|address\/[1-9A-HJ-NP-Za-km-z]{32,44})\?cluster=devnet$/;
const STATIC_LINKS = new Set(["/api/feed", "#try", "https://merlijnw70.github.io/solive/judge", "https://merlijnw70.github.io/solive/ai", "https://github.com/MerlijnW70/solive"]);
const rows = (page: { byId: (id: string) => FakeElement }): FakeElement[] => page.byId("stream").elements;
const words = (el: FakeElement): string => el.textContent.replace(/\s+/g, " ").trim();

function withEvent(feed: Feed, seed: number, secondsAgo: number): Feed {
  const first = feed.events[0];
  if (!first) throw new Error("fixture has no events");
  const event = { ...first, kind: "escrow", signature: signature(seed), at: new Date(NOW - secondsAgo * 1000).toISOString(), detail: "A hirer locked 0.05 SOL for a fizzbuzz demo job." };
  return { ...feed, events: [event, ...feed.events], last_event_at: event.at };
}

function poison(value: unknown): unknown {
  if (typeof value === "string") return "javascript:alert(1)";
  if (Array.isArray(value)) return value.map(poison);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, poison(v)]));
  return value;
}

describe("live page with a full feed", () => {
  it("reads /api/feed once on load and reports it live", async () => {
    const page = await openPage(ok(fullFeed(NOW)));
    expect(page.calls.map((c) => c.url)).toEqual(["/api/feed"]);
    expect(page.calls[0]?.init["credentials"]).toBe("omit");
    expect(page.doc.documentElement.classList.contains("js")).toBe(true);
    expect(page.text("status-text")).toBe("Live, updated 12s ago");
    expect(page.byId("status").getAttribute("data-tone")).toBe("live");
    expect(page.byId("pause").hidden).toBe(false);
  });

  it("shows the newest paid job as three linked transactions with the pinned spec hash", async () => {
    const page = await openPage(ok(fullFeed(NOW)));
    const steps = page.byId("chain").elements;
    expect(steps.map((s) => s.getAttribute("data-kind"))).toEqual(["escrow", "delivery", "release"]);
    for (const step of steps) {
      const tx = step.querySelectorAll("a").filter((a) => (a.getAttribute("href") ?? "").includes("/tx/"));
      expect(tx.length).toBe(1);
      expect(step.querySelector("time")?.getAttribute("datetime")).toMatch(/^2026-10-31T05:5\d:\d\d\.000Z$/);
    }
    expect(words(steps[0] as FakeElement)).toContain("hirer");
    expect(words(steps[2] as FakeElement)).toContain("0.05 SOL");
    expect(page.text("proof-hash-value")).toBe(FIZZBUZZ_HASH);
    expect(page.text("proof-spec")).toMatch(/^fizzbuzz demo spec, read it · job \w{4}…\w{4}$/);
    const spec = page.byId("proof-spec").querySelectorAll("a")[0];
    expect(spec?.getAttribute("href")).toBe("https://github.com/MerlijnW70/solive/blob/main/examples/demo/fizzbuzz/SPEC.md");
  });

  it("renders the outside and house split and the per-token totals", async () => {
    const page = await openPage(ok(fullFeed(NOW)));
    expect(page.text("n-open")).toBe("7");
    expect(page.text("n-paid")).toBe("23");
    expect(page.text("s-paid")).toBe("8 outside · 15 house");
    expect(page.text("n-tokens")).toBe("1.42 SOL380 TEST");
    expect(page.text("n-workers")).toBe("5");
  });

  it("marks house rows in the stream and lists house wallets apart", async () => {
    const page = await openPage(ok(fullFeed(NOW)));
    const list = rows(page);
    expect(list.length).toBe(12);
    const house = list.filter((r) => r.classList.contains("row-house"));
    expect(house.length).toBe(4);
    for (const row of house) expect(row.querySelectorAll(".tag").map(words)).toEqual(["house"]);
    for (const row of list.filter((r) => !r.classList.contains("row-house"))) expect(row.querySelectorAll(".tag")).toEqual([]);
    const titles = (id: string): (string | null)[] => page.byId(id).querySelectorAll("a").map((a) => a.getAttribute("title"));
    expect(titles("workers-house-rows")).toEqual([DEMO_WORKER, FILLER]);
    expect(titles("workers-outside-rows")).not.toContain(DEMO_WORKER);
    expect(titles("workers-outside-rows").length).toBe(3);
  });

  it("gives each row a kind word, an icon, the feed's sentence, a party, an amount, a time and a link", async () => {
    const page = await openPage(ok(fullFeed(NOW)));
    const first = rows(page)[0] as FakeElement;
    expect(words(first.querySelector(".row-kind") as FakeElement)).toBe("Release");
    expect(first.querySelector("use")?.getAttribute("href")).toBe("#icon-paid");
    expect(words(first.querySelector(".row-detail") as FakeElement)).toBe("A judge passed the work and the escrow paid 0.05 SOL to the worker.");
    expect(words(first.querySelector(".row-amt") as FakeElement)).toBe("0.05 SOL");
    expect(words(first.querySelector(".row-time") as FakeElement)).toBe("50s ago");
    expect(first.querySelector(".row-tx")?.querySelector("a")?.getAttribute("href")).toMatch(EXPLORER_LINK);
  });

  it("shortens every address and signature to four and four, full value on hover", async () => {
    const page = await openPage(ok(fullFeed(NOW)));
    const links = anchors(page.doc).filter((a) => (a.getAttribute("href") ?? "").startsWith("https://explorer"));
    expect(links.length).toBeGreaterThan(30);
    for (const a of links) {
      const href = a.getAttribute("href") ?? "";
      expect(href).toMatch(EXPLORER_LINK);
      const full = /\/(?:tx|address)\/([^?]+)/.exec(href)?.[1] ?? "";
      expect(words(a)).toBe(full.slice(0, 4) + "…" + full.slice(-4));
      expect(a.getAttribute("title")).toContain(full);
    }
  });

  it("writes services as words with the time they were checked", async () => {
    const page = await openPage(ok(staleFeed(NOW)));
    expect(page.text("svc-faucet")).toBe("Down");
    expect(page.text("svc-demo_worker")).toBe("Up");
    expect(page.text("svc-filler")).toBe("Unknown");
    expect(page.byId("svc-filler").getAttribute("data-state")).toBe("unknown");
    expect(page.text("svc-filler-seen")).toBe("checked 4m ago");
  });

  it("caps the stream at 50 rows", async () => {
    const feed = fullFeed(NOW);
    const many = Array.from({ length: 60 }, (_, i) => ({ ...feed.events[0], signature: signature(900 + i) }));
    const page = await openPage(ok({ ...feed, events: many }));
    expect(rows(page).length).toBe(50);
  });
});

describe("live page states", () => {
  it("shows a centred empty state and a card without a paid job", async () => {
    const page = await openPage(ok(emptyFeed(NOW)));
    expect(page.byId("empty").hidden).toBe(false);
    expect(rows(page)).toEqual([]);
    expect(page.text("chain")).toMatch(/^No job in the feed's window was paid yet/);
    expect(page.byId("proof-hash").hidden).toBe(true);
    expect(page.byId("quiet").hidden).toBe(true);
    expect(page.text("n-tokens")).toBe("0");
    expect(page.text("workers-outside-rows")).toBe("No outside wallet was paid in the last 7 days.");
  });

  it("renders stale_since as 'as of … ago', distinct from the quiet state", async () => {
    const page = await openPage(ok(staleFeed(NOW)));
    expect(page.text("status-text")).toBe("Devnet is slow; showing activity as of 4m ago");
    expect(page.byId("status").getAttribute("data-tone")).toBe("stale");
    expect(page.text("quiet")).toBe("Last event 50s ago");
  });

  it("reads 'Last event' with a relative time when devnet is quiet", async () => {
    const page = await openPage(ok(quietFeed(NOW)));
    expect(page.text("status-text")).toBe("Live, updated 12s ago");
    expect(page.text("quiet")).toMatch(/^Last event 3h ago\. Quiet on devnet right now/);
  });

  it("renders a house-only feed with nothing outside", async () => {
    const page = await openPage(ok(houseFeed(NOW)));
    expect(page.text("s-paid")).toBe("0 outside · 15 house");
    expect(rows(page).every((r) => r.classList.contains("row-house"))).toBe(true);
    expect(page.text("workers-outside-rows")).toBe("No outside wallet was paid in the last 7 days.");
  });

  it("renders the newest paid job card with null steps and no link for them", async () => {
    const feed = fullFeed(NOW);
    const job = feed.latest_paid_job;
    if (!job) throw new Error("fixture lacks a paid job");
    const page = await openPage(ok({ ...feed, latest_paid_job: { ...job, delivery: null, release: null, spec_name: null } }));
    const steps = page.byId("chain").elements;
    expect(steps.map((s) => s.classList.contains("step-missing"))).toEqual([false, true, true]);
    for (const step of steps.slice(1)) {
      expect(step.querySelectorAll("a")).toEqual([]);
      expect(words(step)).toContain("Not in the feed.");
    }
    expect(page.text("proof-spec")).toMatch(/^custom job · job /);
  });

  it("keeps the last read and says the feed is unreachable when a read fails", async () => {
    const page = await openPage(ok(fullFeed(NOW)));
    page.answer({ ok: false, status: 503, body: null });
    await page.advance(30000);
    expect(page.calls.length).toBe(2);
    expect(page.text("status-text")).toBe("Feed unreachable; showing the read from 42s ago");
    expect(rows(page).length).toBe(12);
  });

  it("says so when the first read fails, with no rows", async () => {
    const page = await openPage("reject");
    expect(page.text("status-text")).toBe("Feed unreachable; trying again every 30 s.");
    expect(page.byId("status").getAttribute("data-tone")).toBe("down");
  });
});

describe("live page safety at runtime", () => {
  it("inserts feed values as text, never as markup", async () => {
    const feed = fullFeed(NOW);
    const markup = "<img src=x onerror=alert(1)><script>alert(2)</script>";
    const first = feed.events[0];
    if (!first) throw new Error("fixture has no events");
    const page = await openPage(ok({ ...feed, events: [{ ...first, detail: markup, spec_name: markup }, ...feed.events.slice(1)] }));
    expect(words(rows(page)[0]?.querySelector(".row-detail") as FakeElement)).toBe(markup);
    const tags = new Set(page.doc.created.map((e) => e.tagName));
    expect(tags.has("img")).toBe(false);
    expect(tags.has("script")).toBe(false);
  });

  it("builds no link from a javascript: value in any field", async () => {
    const page = await openPage(ok(poison(fullFeed(NOW))));
    for (const a of anchors(page.doc)) {
      const href = a.getAttribute("href") ?? "";
      expect(href).not.toMatch(/javascript/i);
      expect(STATIC_LINKS.has(href) || EXPLORER_LINK.test(href)).toBe(true);
    }
    expect(page.byId("chain").querySelectorAll("a")).toEqual([]);
    expect(page.byId("stream").querySelectorAll("a")).toEqual([]);
    expect(page.text("proof-spec")).toBe("custom job");
  });

  it("refuses links to other clusters and malformed signatures", async () => {
    const feed = fullFeed(NOW);
    const first = feed.events[0];
    if (!first) throw new Error("fixture has no events");
    const bad = [{ ...first, signature: "0OIl" + first.signature.slice(4) }, { ...first, signature: first.signature.slice(0, 80) }, { ...first, who: "https://evil.example/" + first.who }];
    const page = await openPage(ok({ ...feed, events: bad }));
    const hrefs = page.byId("stream").querySelectorAll("a").map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBe(3);
    for (const href of hrefs) expect(href).toMatch(EXPLORER_LINK);
  });
});

describe("live page updates and pause", () => {
  it("polls every 30 s and the pause button stops every read", async () => {
    const page = await openPage(ok(fullFeed(NOW)));
    await page.advance(30000);
    expect(page.calls.length).toBe(2);
    page.byId("pause").click();
    expect(page.byId("pause").getAttribute("aria-pressed")).toBe("true");
    expect(page.text("pause-label")).toBe("Resume");
    expect(page.text("status-text")).toBe("Paused. No reads until you resume.");
    await page.advance(10 * 60000);
    expect(page.calls.length).toBe(2);
    page.byId("pause").click();
    await page.settle();
    expect(page.calls.length).toBe(3);
    expect(page.text("status-text")).toMatch(/^Live, updated/);
  });

  it("aborts a read in flight when paused and ignores its answer", async () => {
    const page = await openPage("hang");
    const call = page.calls[0];
    page.byId("pause").click();
    await page.settle();
    expect(call?.signal.aborted).toBe(true);
    expect(page.text("status-text")).toBe("Paused. No reads until you resume.");
    await page.advance(120000);
    expect(page.calls.length).toBe(1);
  });

  it("stops relative times from ticking while paused", async () => {
    const page = await openPage(ok(fullFeed(NOW)));
    const time = () => words(rows(page)[0]?.querySelector(".row-time") as FakeElement);
    page.byId("pause").click();
    await page.advance(120000);
    expect(time()).toBe("50s ago");
  });

  it("enters new rows at the top with the enter class when the visitor is not in the stream", async () => {
    const page = await openPage(ok(fullFeed(NOW)));
    page.answer(ok(withEvent(fullFeed(NOW), 990, 0)));
    await page.advance(30000);
    const list = rows(page);
    expect(list.length).toBe(13);
    expect(list[0]?.classList.contains("is-new")).toBe(true);
    expect(list.slice(1).some((r) => r.classList.contains("is-new"))).toBe(false);
  });

  it("queues new rows behind a button while the visitor hovers, focuses or has scrolled into the stream", async () => {
    for (const enter of ["pointerenter", "focusin", "scroll"]) {
      const page = await openPage(ok(fullFeed(NOW)));
      const stream = page.byId("stream");
      if (enter === "scroll") stream.top = -400;
      else stream.dispatch(enter);
      page.answer(ok(withEvent(withEvent(fullFeed(NOW), 991, 5), 992, 0)));
      await page.advance(30000);
      expect(rows(page).length).toBe(12);
      expect(page.byId("queued").hidden).toBe(false);
      expect(page.text("queued")).toBe("2 new events");
      page.byId("queued").click();
      expect(rows(page).length).toBe(14);
      expect(rows(page).filter((r) => r.classList.contains("is-new")).length).toBe(2);
      expect(page.byId("queued").hidden).toBe(true);
      expect(stream.focused).toBe(1);
    }
  });

  it("keeps the stream out of live regions and announces new events at most once a minute", async () => {
    const page = await openPage(ok(fullFeed(NOW)));
    expect(page.byId("stream").getAttribute("aria-live")).toBe("off");
    expect(page.byId("announce").getAttribute("aria-live")).toBe("polite");
    expect(page.text("announce")).toBe("");
    let feed = fullFeed(NOW);
    const said: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      feed = withEvent(feed, 980 + i, 0);
      page.answer(ok(feed));
      await page.advance(30000);
      said.push(page.text("announce"));
    }
    expect(said).toEqual(["1 new event", "1 new event", "2 new events", "2 new events"]);
  });

  it("swaps a changed number at once and tints its tile", async () => {
    const page = await openPage(ok(fullFeed(NOW)));
    expect(page.byId("tile-paid").classList.contains("is-changed")).toBe(false);
    const next = fullFeed(NOW);
    page.answer(ok({ ...next, stats: { ...next.stats, paid_jobs_7d: 24 } }));
    await page.advance(30000);
    expect(page.text("n-paid")).toBe("24");
    expect(page.byId("tile-paid").classList.contains("is-changed")).toBe(true);
    expect(page.byId("tile-open").classList.contains("is-changed")).toBe(false);
  });

  it("copies the exact install line", async () => {
    const page = await openPage(ok(fullFeed(NOW)));
    const button = page.doc.querySelectorAll("[data-copy]").find((b) => b.getAttribute("data-copy") === "cmd-win-codex");
    expect(button?.hidden).toBe(false);
    button?.click();
    await page.settle();
    expect(page.copied).toEqual(["npx.cmd -y @intent-engine/cli add-to codex"]);
    expect(words(button?.querySelector(".copy-label") as FakeElement)).toBe("Copied");
  });
});
