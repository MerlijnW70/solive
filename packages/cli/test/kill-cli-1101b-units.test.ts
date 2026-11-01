import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRODUCT_SLUG } from "@intent-engine/core/internal";
import { askInstantFaucet, FAUCET_DOWN, FAUCET_MALFORMED, FAUCET_SILENT, type FaucetFetch } from "../src/faucet.js";
import { newestFirst } from "../src/job-pages.js";
import { EXIT_OK, runProcess } from "../src/main.js";
import { NPM_REGISTRY } from "../src/npm-registry.js";
import { addToLines } from "../src/render.js";
import { resavedFrom } from "../src/resaved.js";
import { wtf8Decode } from "../src/wtf8.js";
import { instant, resetHarness, runtime } from "./harness.js";

const sha256 = (text: string) => createHash("sha256").update(text, "latin1").digest("hex");

const answering =
  (status: number, body: unknown): FaucetFetch =>
  async () => ({ status, json: async () => body });

describe("the instant faucet's silent refusals and replies", () => {
  it("calls a silent 500 down and a silent 499 a refusal", async () => {
    expect(await askInstantFaucet(answering(500, null), {}, "address")).toEqual({ refused: FAUCET_DOWN });
    expect(await askInstantFaucet(answering(499, null), {}, "address")).toEqual({ refused: FAUCET_SILENT });
  });

  it("calls a 200 whose body is not JSON a reply it does not recognise", async () => {
    expect(await askInstantFaucet(answering(200, null), {}, "address")).toEqual({ refused: FAUCET_MALFORMED });
  });
});

describe("the add-to wallet line", () => {
  const added = (setup: object) => addToLines({ to: "Codex", added: "slug", setup }).split("\n")[1];

  it("shows what setup says next for a wallet that holds zero SOL", () => {
    expect(added({ sol: "0", next: "fund it" })).toBe("fund it");
  });

  it("shows what setup says next when it names other ways, even with SOL", () => {
    expect(added({ sol: "1.5", other_ways: ["faucet"], next: "fund it" })).toBe("fund it");
    expect(added({ sol: "1.5" })).toBe("Your wallet holds 1.5 SOL.");
  });
});

describe("resaved forms of a file that is only a line end", () => {
  it("finds the empty file under a lone LF", () => {
    expect(resavedFrom(Buffer.from("\n"))).toEqual([sha256("")]);
  });

  it("finds the empty file, the bare CR and the LF under a lone CRLF", () => {
    expect(resavedFrom(Buffer.from("\r\n"))).toEqual([sha256(""), sha256("\r"), sha256("\n")]);
  });
});

describe("WTF-8 characters above the basic plane", () => {
  it("decodes them to their surrogate pairs", () => {
    for (const [text, high, low] of [
      ["\u{10000}", 0xd800, 0xdc00],
      ["\u{1f600}", 0xd83d, 0xde00],
      ["\u{10ffff}", 0xdbff, 0xdfff],
    ] as const) {
      const decoded = wtf8Decode(Buffer.from(text, "utf8"));
      expect([decoded.charCodeAt(0), decoded.charCodeAt(1), decoded.length]).toEqual([high, low, 2]);
    }
  });
});

describe("find_jobs order", () => {
  const SYSTEM = "11111111111111111111111111111111";
  const WRAPPED = "So11111111111111111111111111111111111111112";
  const at = (intent: string) => ({ createdAt: 5n, expiresAt: 9n, intent }) as Parameters<typeof newestFirst>[0];

  it("breaks a tie in both times by the intent address, lowest first", () => {
    expect(newestFirst(at(SYSTEM), at(WRAPPED))).toBe(-1);
    expect(newestFirst(at(WRAPPED), at(SYSTEM))).toBe(1);
    expect(newestFirst(at(SYSTEM), at(SYSTEM))).toBe(0);
  });
});

describe("a process on a terminal", () => {
  let bin = "";

  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), "add-to-tty-bin-"));
    writeFileSync(join(bin, "claude"), "");
    chmodSync(join(bin, "claude"), 0o755);
  });

  afterAll(() => {
    rmSync(bin, { recursive: true, force: true });
  });

  const addTo = async (isTTY?: boolean) => {
    resetHarness();
    instant.fetch = undefined;
    const out: string[] = [];
    const rt = { ...runtime({}), env: { PATH: bin }, launch: async (program: string) => ({ code: 0, output: program === "npm" ? `${NPM_REGISTRY}\n` : "" }) };
    const proc = {
      argv: ["node", "bin.js", "add-to", "claude"],
      stdout: { write: (t: string) => out.push(t), ...(isTTY === undefined ? {} : { isTTY }) },
      stderr: { write: () => undefined },
    };
    expect(await runProcess(proc, rt)).toBe(EXIT_OK);
    return out.join("");
  };

  it("prints add-to as plain lines on a terminal and as JSON otherwise", async () => {
    expect((await addTo(true)).split("\n")[0]).toBe(`${PRODUCT_SLUG} was added to Claude Code.`);
    expect(JSON.parse(await addTo())).toMatchObject({ to: "Claude Code", added: PRODUCT_SLUG });
    expect(JSON.parse(await addTo(false))).toMatchObject({ to: "Claude Code", added: PRODUCT_SLUG });
  }, 60_000);
});
