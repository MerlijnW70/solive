import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { createClient } from "@intent-engine/client/node";
import { DEMO_SPECS, demoSpecUrl } from "../src/agent/mcp.js";
import { URL_HIDDEN } from "../src/announce-commands.js";
import { EXIT_FAILED, EXIT_OK, main } from "../src/main.js";
import { RATE_LIMITED_HINT } from "../src/rpc-failure.js";
import { announced, keyed } from "./announce.js";
import { cli, NOW, runtime, transport, type World, world } from "./harness.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const fenced = (text: string, language: string) => text.split(/^```/m).filter((part) => part.startsWith(language + "\n")).flatMap((part) => part.slice(language.length + 1).trimEnd().split("\n"));
const ERROR_START = "running scripts is disabled";

describe("windows onboarding docs", () => {
  it("README and the AI guide show the PowerShell line and quote the policy error before the first run", () => {
    for (const path of ["README.md", "docs/ai.md"]) {
      const text = read(path);
      const first = text.indexOf("```sh\nnpx -y @intent-engine/cli add-to claude");
      expect(first, path).toBeGreaterThan(0);
      const warning = text.indexOf(ERROR_START);
      expect(warning, path).toBeGreaterThan(0);
      expect(warning, path).toBeLessThan(first);
      expect(text.slice(0, first), path).toContain("`npx.cmd`");
      expect(fenced(text, "powershell"), path).toContain("npx.cmd -y @intent-engine/cli add-to claude");
    }
  });

  it("the quickstart gives the Windows PATH way and says npx.cmd needs none", () => {
    const step = read("docs/quickstart.md").split("## 1. Run the CLI")[1]?.split("## 2.")[0] ?? "";
    expect(step).toContain("`npm config get prefix`");
    expect(step).toContain("user `PATH`");
    expect(step).toContain("open a new terminal");
    expect(step).toContain("The `npx.cmd` function above needs no `PATH` change.");
    expect(step).toContain('export PATH="$HOME/.npm-global/bin:$PATH"');
  });

  it("the funding text names the instant faucet's first drip and the airdrop fallback", () => {
    const sentence = "asks the instant faucet for 0.5 SOL";
    expect(read("docs/quickstart.md")).toContain(`${sentence}, then devnet for an airdrop if the faucet gives none`);
    expect(read("docs/first-job.md")).toContain(`${sentence} when it holds little, then devnet for an airdrop if the faucet gives none`);
    expect(read("docs/quickstart.md")).not.toContain("asks devnet for 1 SOL");
    expect(read("docs/first-job.md")).not.toContain("asks devnet for 1 SOL");
  });

  it("the AI guide links the first hire guide and its CLI section lists the demo specs from the code", () => {
    expect(read("docs/ai.md")).toContain("(first-hire.md)");
    const hire = read("docs/first-hire.md");
    const section = hire.slice(hire.indexOf("## From the command line"));
    expect(section).toContain("intent-engine create attested");
    expect(section).toContain("--spec-url <spec url>");
    expect(section).toContain("intent-engine deliveries --intent <intent> --judge-keypair <keypair>");
    const rows = [...section.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \|$/gm)].map((m) => ({ name: m[1], url: m[2], sha256: m[3] }));
    expect(rows).toEqual(DEMO_SPECS.map(({ name, sha256 }) => ({ name, url: demoSpecUrl(name), sha256 })));
  });

  it("the demo spec hashes in the code match the spec files", () => {
    for (const { name, sha256 } of DEMO_SPECS) {
      expect(createHash("sha256").update(readFileSync(join(ROOT, "examples/demo", name, "SPEC.md"))).digest("hex")).toBe(sha256);
    }
  });
});

describe("deliveries url hint", () => {
  let w: World;

  beforeEach(async () => {
    w = await world();
  });

  it("says the url is hidden and names the flag when announcements exist and no key is given, and stays silent with the judge key", async () => {
    const judge = await keyed("judge.json");
    const specHash = new Uint8Array(createHash("sha256").update("spec").digest());
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n } as const;
    const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
    const empty = await cli(["deliveries", "--intent", intent], {});
    expect(empty.json()["note"]).toBeUndefined();
    await announced(intent, await keyed("worker.json"), createHash("sha256").update("work").digest("hex"));
    const hidden = await cli(["deliveries", "--intent", intent], {});
    expect([hidden.code, hidden.json()["note"]]).toEqual([EXIT_OK, URL_HIDDEN]);
    expect(URL_HIDDEN).toContain("--judge-keypair");
    const shown = await cli(["deliveries", "--intent", intent, "--judge-keypair", "judge.json"], {});
    expect(shown.json()["note"]).toBeUndefined();
    expect((shown.json()["announcements"] as { url?: string }[])[0]?.url).toBeDefined();
  });
});

describe("rate limit text", () => {
  const throttled = () => new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "Too Many Requests", statusCode: 429 });

  it("a 429 from the node prints the retry text and still fails", async () => {
    const err: string[] = [];
    const rate = { ...runtime({}), transport: () => { throw throttled(); } };
    const code = await main(["deliveries", "--intent", "11111111111111111111111111111111"], rate, { out: () => undefined, err: (t) => err.push(t) });
    expect(code).toBe(EXIT_FAILED);
    expect(err.join("\n")).toBe(RATE_LIMITED_HINT);
    expect(RATE_LIMITED_HINT).toMatch(/rate-limited.*retry in a minute.*--url/);
  });
});
