import { describe, expect, it } from "vitest";
import { tool } from "../src/agent/names.js";
import { deliveryMissing, missing, SMOKE_USAGE, SmokeFailed, type SmokeRun, smoke, smokeOptions, specMismatch, type ToolCaller, type ToolResult } from "../src/mcp-smoke.js";

const SPEC_URL = "https://" + "example.org/jobs/smoke.md";
const run: SmokeRun = { specUrl: SPEC_URL, specText: "spec\n", workUrl: SPEC_URL, work: "work\n", wait: 1 };

type Replies = Record<string, (args: Record<string, unknown>) => ToolResult>;

const sending = (sent: Record<string, unknown>) => (args: Record<string, unknown>): ToolResult => ({
  structuredContent: args["send"] === true ? { sent: true, ...sent } : { sent: false, summary: ["preview"] },
});

const HIRER: Replies = {
  wallet_balance: () => ({ structuredContent: { address: "hirer", sol: "0.02" } }),
  hash: () => ({ structuredContent: { sha256: "spec-hash" } }),
  wallet_escrow: sending({ signature: "escrowed", intent: "intent", nonce: "0" }),
  wallet_attest: sending({ signature: "released", paid: "0.01" }),
};

const WORKER: Replies = {
  wallet_balance: () => ({ structuredContent: { address: "worker", sol: "1" } }),
  find_jobs: () => ({ structuredContent: { jobs: [{ intent: "intent", spec_url: SPEC_URL, spec_hash: "spec-hash", net_pay: "0.01" }] } }),
  get_spec: () => ({ structuredContent: { sha256: "spec-hash", matches: true } }),
  hash: () => ({ structuredContent: { sha256: "work-hash" } }),
  wallet_deliver: sending({ signature: "delivered" }),
  wallet_check_delivery: () => ({ structuredContent: { own: { landed: true, earliest: true } } }),
  wallet_receipt: () => ({ structuredContent: { released: true, matches: true, signature: "released" } }),
  wallet_unwrap: sending({ signature: "unwrapped", wrapped: "0.01" }),
};

const caller =
  (replies: Replies): ToolCaller =>
  async (name, args) => {
    const reply = Object.entries(replies).find(([short]) => tool(short) === name)?.[1];
    if (reply === undefined) {
      throw new Error(`no reply for ${name}`);
    }
    return reply(args);
  };

const smoked = (hirer: Replies = {}, worker: Replies = {}) => smoke({ hirer: caller({ ...HIRER, ...hirer }), worker: caller({ ...WORKER, ...worker }) }, run);

const failure = async (hirer: Replies, worker: Replies = {}) => {
  const failed = await smoked(hirer, worker).catch((error: unknown) => error);
  expect(failed).toBeInstanceOf(SmokeFailed);
  return (failed as SmokeFailed).message;
};

describe("the MCP smoke steps", () => {
  it("passes a hirer holding exactly the escrow and its reserve", async () => {
    expect((await smoked()).release).toBe("released");
  });

  it("names the tool's problem code, hint and issues, and an error without content", async () => {
    const problem = (structuredContent: unknown): Replies => ({ wallet_balance: () => ({ isError: true, structuredContent }) });
    expect(await failure(problem({ code: "Bad", hint: "fix it", issues: [{ path: "mints", message: "is wrong" }] }))).toBe("hirer wallet failed: Bad: fix it (mints is wrong)");
    expect(await failure(problem({ code: "Bad", hint: "fix it", issues: [] }))).toBe("hirer wallet failed: Bad: fix it");
    expect(await failure(problem(null))).toBe("hirer wallet failed: Error: ");
  });

  it("fails a reply without structured content", async () => {
    for (const structuredContent of [undefined, null, "text"]) {
      expect(await failure({ wallet_balance: () => ({ structuredContent }) })).toBe(`hirer wallet failed: ${missing("structured content")}`);
    }
  });

  it("fails a spec that does not match, even when its hash does", async () => {
    expect(await failure({}, { get_spec: () => ({ structuredContent: { sha256: "spec-hash", matches: false } }) })).toBe(`get spec failed: ${specMismatch("spec-hash", "spec-hash")}`);
  });

  it("fails a delivery check that did not land first or holds no own delivery", async () => {
    for (const own of [{ landed: true, earliest: false }, { landed: false, earliest: true }, null]) {
      expect(await failure({}, { wallet_check_delivery: () => ({ structuredContent: { own } }) }), JSON.stringify(own)).toBe(`check delivery failed: ${deliveryMissing("work-hash", "worker")}`);
    }
  });
});

describe("the smoke script's arguments", () => {
  it("refuses an argument past the spec url", () => {
    expect(() => smokeOptions(["devnet", "h.json", "w.json", SPEC_URL, "extra"])).toThrow(SMOKE_USAGE);
  });
});
