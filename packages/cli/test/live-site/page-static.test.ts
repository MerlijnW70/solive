import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FakeElement } from "./dom.js";
import { parse } from "./dom.js";
import { PUBLIC, ROOT, read } from "./page.js";

const html = read("index.html");
const css = read("live.css");
const js = read("live.js");
const doc = parse(html);
const all = doc.documentElement.descendants();
const byId = (id: string): FakeElement => {
  const el = doc.getElementById(id);
  if (!el) throw new Error("no #" + id);
  return el;
};
const words = (el: FakeElement): string => el.textContent.replace(/\s+/g, " ").trim();
const scriptsOff = (el: FakeElement): boolean => {
  for (let at: FakeElement | null = el; at; at = at.parent) {
    if (at.classList.contains("needs-js") || at.hidden) return false;
  }
  return true;
};

function identity(section: string, key: string): string {
  const text = readFileSync(join(ROOT, "identity.toml"), "utf8");
  const block = text.split(/^\[/m).find((b) => b.startsWith(section + "]")) ?? "";
  const match = new RegExp("^" + key + ' = "([^"]*)"', "m").exec(block);
  if (!match?.[1]) throw new Error("identity.toml lacks " + section + "." + key);
  return match[1];
}

function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--([a-z]+):\s*(#[0-9A-F]{6});/g)].map((m) => [m[1] ?? "", m[2] ?? ""]));
}

const LIGHT = { bg: "#F7F7F4", surface: "#FFFFFF", ink: "#15171A", muted: "#565C66", line: "#DEDED8", link: "#1A56C4", escrow: "#8F5300", delivery: "#1A56C4", claim: "#0B6E69", release: "#17763A", refund: "#B3261E", swap: "#565C66" };
const DARK = { bg: "#0D0F12", surface: "#15181C", ink: "#ECEEF0", muted: "#9BA2AD", line: "#272B31", link: "#80AEFF", escrow: "#E8A33D", delivery: "#80AEFF", claim: "#45C7BE", release: "#5FD38D", refund: "#FF8F87", swap: "#9BA2AD" };

describe("live page structure", () => {
  it("has the ten sections in the researched order", () => {
    const order = ["header", "#headline", "#proof-title", "#stream-title", "#how-title", "#try-title", "#workers-title", "#services-title", "footer"];
    const positions = order.map((sel) => all.findIndex((e) => e.matches(sel)));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    const numbers = all.findIndex((e) => e.id === "numbers-title");
    expect(numbers).toBeGreaterThan(positions[2] ?? 0);
    expect(numbers).toBeLessThan(positions[3] ?? 0);
  });

  it("carries the chosen headline and sentence", () => {
    expect(words(byId("headline"))).toBe("Agents hire agents here, and get paid only when a judge passes the work.");
    expect(words(doc.querySelector(".lede") as FakeElement)).toBe("Every row below is a devnet transaction: an escrow locked for a pinned spec, a delivery, a judge's release that pays.");
  });

  it("shows the try-it lines exactly as the README writes them, each with a copy button", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const blocks = [...readme.matchAll(/```(?:sh|powershell)\r?\n([^\r\n]+)\r?\n```/g)].map((m) => m[1]);
    const lines = doc.querySelectorAll(".cmd-line").filter((e) => e.closest("#try")).map(words);
    expect(blocks.length).toBe(4);
    expect(lines).toEqual(blocks);
    expect(words(byId("cmd-hero"))).toBe(blocks[0]);
    for (const code of doc.querySelectorAll(".cmd-line")) {
      const button = doc.querySelectorAll("[data-copy]").find((b) => b.getAttribute("data-copy") === code.id);
      expect(button?.tagName).toBe("button");
    }
  });

  it("renders the headline, how it works, the try-it lines and a feed link with scripts off", () => {
    for (const id of ["headline", "how", "try", "cmd-claude", "cmd-codex", "cmd-win-claude", "cmd-win-codex"]) expect(scriptsOff(byId(id))).toBe(true);
    const feedLinks = doc.querySelectorAll("a").filter((a) => a.getAttribute("href") === "/api/feed" && scriptsOff(a));
    expect(feedLinks.length).toBeGreaterThan(0);
    expect(html).not.toMatch(/loading/i);
    expect(doc.querySelectorAll("noscript").length).toBe(1);
  });

  it("names the product and repository from identity.toml", () => {
    const name = identity("product", "name");
    expect(doc.querySelectorAll("[data-identity]").map(words)).toEqual([name]);
    expect(words(doc.querySelector("title") as FakeElement).startsWith(name + " ")).toBe(true);
    expect(html.split(name).length - 1).toBe(2);
    expect(byId("repo").getAttribute("href")).toBe(identity("security", "repository"));
  });

  it("links the program the source declares, on devnet", () => {
    const lib = readFileSync(join(ROOT, "programs", "intent_engine", "src", "lib.rs"), "utf8");
    const program = /declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/.exec(lib)?.[1] ?? "";
    expect(byId("program").getAttribute("href")).toBe("https://explorer.solana.com/address/" + program + "?cluster=devnet");
    expect(words(byId("program"))).toBe(program.slice(0, 4) + "…" + program.slice(-4));
    expect(byId("program").getAttribute("title")).toBe(program);
  });
});

describe("live page safety", () => {
  it("sets a strict content security policy with Trusted Types", () => {
    const meta = doc.querySelectorAll("meta").find((m) => m.getAttribute("http-equiv") === "Content-Security-Policy");
    const policy = meta?.getAttribute("content") ?? "";
    for (const part of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "object-src 'none'", "require-trusted-types-for 'script'", "trusted-types 'none'"]) expect(policy).toContain(part);
    expect(policy).not.toMatch(/unsafe|https?:|\*/);
  });

  it("has no inline script, inline style, event handler or third-party origin", () => {
    const scripts = doc.querySelectorAll("script");
    expect(scripts.map((s) => s.getAttribute("src"))).toEqual(["/live.js"]);
    expect(scripts.every((s) => s.textContent.trim() === "")).toBe(true);
    expect(doc.querySelectorAll("style")).toEqual([]);
    for (const el of all) {
      for (const name of el.attrs.keys()) expect(name === "style" || name.startsWith("on")).toBe(false);
      for (const attr of ["src", "href"]) {
        const value = el.getAttribute(attr);
        if (value === null || el.tagName === "a") continue;
        expect(value).toMatch(/^(\/[a-z]|#icon-)/);
      }
    }
    expect(css).not.toMatch(/@import|url\(\s*["']?(https?:|\/\/)/);
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|import\(/);
    const explorer = "https://" + "explorer.solana.com/";
    const svg = "http://" + "www.w3.org/2000/svg";
    expect(js.match(/https?:\/\/[^"]+/g)).toEqual([explorer, svg]);
  });

  it("lets page links leave only to the docs, the repository and the devnet explorer", () => {
    for (const a of doc.querySelectorAll("a")) {
      const href = a.getAttribute("href") ?? "";
      expect(href).toMatch(/^(\/api\/feed|#try|https:\/\/merlijnw70\.github\.io\/solive\/[a-z]+|https:\/\/github\.com\/MerlijnW70\/solive|https:\/\/explorer\.solana\.com\/address\/[1-9A-HJ-NP-Za-km-z]{32,44}\?cluster=devnet)$/);
    }
  });
});

describe("live page design", () => {
  it("self-hosts Geist Sans and Geist Mono as subset WOFF2 with their licence", () => {
    const faces = [...css.matchAll(/@font-face\s*{[^}]*font-family:\s*"([^"]+)";[^}]*src:\s*url\("([^"]+)"\)\s*format\("woff2"\)/g)].map((m) => [m[1], m[2]]);
    expect(faces).toEqual([["Geist", "/fonts/Geist-Variable.woff2"], ["Geist Mono", "/fonts/GeistMono-Variable.woff2"]]);
    for (const [, path] of faces) {
      const bytes = readFileSync(join(PUBLIC, path ?? ""));
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
      expect(bytes.length).toBeLessThan(40000);
    }
    expect(read("fonts/OFL.txt")).toContain("SIL Open Font License, Version 1.1");
    expect(css).toMatch(/--sans: "Geist"/);
    expect(css).toMatch(/--mono: "Geist Mono"/);
  });

  it("uses the colour tokens of both themes, each text token at AA contrast", () => {
    const [light, dark] = css.split("@media (prefers-color-scheme: dark)") as [string, string];
    expect(tokens(light)).toEqual(LIGHT);
    expect(tokens(dark.slice(0, dark.indexOf("}\n}") + 1))).toEqual(DARK);
    for (const theme of [LIGHT, DARK]) {
      for (const key of ["ink", "muted", "link", "escrow", "delivery", "claim", "release", "refund", "swap"] as const) {
        expect(contrast(theme[key], theme.bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(theme[key], theme.surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps the type scale, spacing, grid and motion tokens", () => {
    for (const size of ["0.8125rem", "0.9375rem", "1.0625rem", "1.3125rem", "1.75rem", "2.5rem"]) expect(css).toContain(size);
    for (const step of [4, 8, 12, 16, 24, 32, 48, 64]) expect(css).toContain("--s" + step + ": " + step + "px;");
    expect(css).toContain("--max: 1120px;");
    expect(css).toContain("--gutter: 24px;");
    expect(css).toContain("repeat(12, minmax(0, 1fr))");
    expect(css).toMatch(/\.proof {\s*grid-column: span 7;/);
    expect(css).toContain(".numbers { grid-column: span 5; }");
    expect(css).toContain("--enter: 160ms;");
    expect(css).toContain("--settle: 1200ms;");
    expect(css).toContain("--tint: 600ms;");
    expect(css).toContain("translateY(-8px)");
    expect(css).toMatch(/@media \(max-width: 720px\) {\s*:root { --side: 16px; }/);
    expect(css).toMatch(/\.cmd-line { [^}]*white-space: pre; overflow-x: auto;/);
    expect(html.match(/include house activity/g)?.length).toBe(1);
    expect(doc.querySelectorAll(".split").map((e) => e.id)).toEqual(["s-paid"]);
  });

  it("has no gradient, blur, shadow, looping or unreduced motion", () => {
    expect(css).not.toMatch(/gradient\(|backdrop-filter|blur\(|box-shadow|text-shadow|infinite|animation-iteration-count/);
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".row.is-new { animation: row-settle");
    expect(reduced.slice(0, reduced.indexOf("\n}\n"))).not.toContain("row-enter");
  });

  it("draws one icon per kind, each beside a word, and no emoji", () => {
    const symbols = doc.querySelectorAll("symbol").map((s) => s.id);
    for (const name of ["lock", "hand", "box", "paid", "back", "swap"]) expect(symbols).toContain("icon-" + name);
    expect(css).toMatch(/\.icon {[^}]*width: 16px;[^}]*stroke-width: 1\.5;/);
    for (const kind of doc.querySelectorAll(".flow-kind")) expect(words(kind)).toMatch(/^\d [A-Z][a-z]+$/);
    expect(html + js).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("ships only the files the page needs", () => {
    expect(readdirSync(PUBLIC).sort()).toEqual(["favicon.svg", "fonts", "index.html", "live.css", "live.js"]);
    expect(readdirSync(join(PUBLIC, "fonts")).sort()).toEqual(["Geist-Variable.woff2", "GeistMono-Variable.woff2", "OFL.txt"]);
  });
});
