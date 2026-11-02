import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ENV_KEYPAIR, ENV_URL, parse as parseCommand } from "../src/args.js";
import { REQUIRED_NODE } from "../src/bin.js";
import { CLAUDE_MISSING, CODEX_MISSING } from "../src/add-to.js";
import { URL_HIDDEN } from "../src/announce-commands.js";
import { RATE_LIMITED_HINT } from "../src/rpc-failure.js";
import { DEMO_SPECS, demoSpecUrl } from "../src/agent/mcp.js";
import { FAUCET_SCHEDULE } from "../src/faucet.js";
import { APP_WAY, ENOUGH_TO_START, FAUCET, GH_WAY, PUBLIC_FAUCET, WHY_LIMITED, faucetLink } from "../src/wallet.js";
import { type FakeDocument, type FakeElement, parse } from "./live-site/dom.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const SITE_DIR = join(ROOT, "services", "faucet");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const site = (path: string) => readFileSync(join(SITE_DIR, "public", path), "utf8");
const HTML = site("index.html");
const ADDRESS = "11111111111111111111111111111111";
const OTHER = "Vote111111111111111111111111111111111111111";
const words = (el: FakeElement) => el.textContent.replace(/\s+/g, " ").trim();

type Answer = { ok: boolean; status: number; body: unknown } | "reject" | "hang" | "text";
type Call = { url: string; init: Record<string, unknown> };

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function open(answer: Answer, clipboard = true) {
  const doc = parse(HTML);
  const calls: Call[] = [];
  const copied: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let release: (() => void) | undefined;
  const fetch = (url: string, init: Record<string, unknown>): Promise<unknown> => {
    calls.push({ url, init });
    if (answer === "reject") return Promise.reject(new Error("offline"));
    if (answer === "hang") return new Promise<unknown>((resolve) => { release = () => resolve({ ok: true, status: 200, json: async () => ({ lamports: "500000000" }) }); });
    if (answer === "text") return Promise.resolve({ ok: false, status: 502, json: async () => { throw new Error("not json"); } });
    return Promise.resolve({ ok: answer.ok, status: answer.status, json: async () => structuredClone(answer.body) });
  };
  const context = createContext({
    document: doc,
    fetch,
    AbortController,
    BigInt,
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    clearTimeout: () => undefined,
    navigator: clipboard ? { clipboard: { writeText: async (text: string) => { copied.push(text); } } } : {},
    console,
  });
  runInContext(site("try.js"), context, { filename: "try.js" });
  await flush();
  const byId = (id: string): FakeElement => {
    const el = doc.getElementById(id);
    if (!el) throw new Error("no element #" + id);
    return el;
  };
  const submit = async (value: string) => {
    (byId("address") as unknown as { value: string }).value = value;
    let prevented = 0;
    for (const fn of byId("drip").listeners.get("submit") ?? []) fn({ type: "submit", target: byId("drip"), preventDefault: () => { prevented += 1; } } as never);
    await flush();
    return prevented;
  };
  return { doc, calls, copied, timers, byId, submit, release: () => release?.() };
}

const codes = (doc: FakeDocument, shell: string) => doc.querySelectorAll("code").filter((el) => el.getAttribute("data-shell") === shell).map((el) => words(el));
const doc = parse(HTML);
const sh = codes(doc, "sh");
const powershell = codes(doc, "powershell");
const bare = (line: string) => line.replace(/^npx -y \S+ /, "");
const NAME = (JSON.parse(read("packages/cli/package.json")) as { name: string }).name;
const fizzbuzz = DEMO_SPECS.find(({ name }) => name === "fizzbuzz");
const escrow = sh.find((line) => line.includes(" create attested ")) ?? "";
const argv = (line: string) =>
  bare(line).replace("<address>", ADDRESS).replace("<intent>", ADDRESS).replace("<nonce>", "0").replace("<keypair>", "judge.json").split(" ");

describe("the try page steps", () => {
  it("gives every shell line a PowerShell twin that differs only in npx.cmd and curl.exe", () => {
    const twin = (line: string) => line.replace(/^npx /, "npx.cmd ").replace(/^curl /, "curl.exe ");
    expect(sh.length).toBeGreaterThan(8);
    expect(powershell).toEqual(sh.map(twin));
    expect(doc.querySelectorAll(".cmd-line").length).toBe(sh.length + powershell.length);
    expect(HTML).toContain("<code>running scripts is disabled on this system</code>");
  });

  it("runs the published package and names the Node floor from the code", () => {
    const npx = sh.filter((line) => line.startsWith("npx "));
    expect(npx.length).toBeGreaterThan(6);
    expect(npx.every((line) => line.startsWith(`npx -y ${NAME} `))).toBe(true);
    expect(HTML).toContain(`Node.js ${REQUIRED_NODE.replace(/\.0$/, "")} or later`);
    expect(HTML).toContain("<code>node --version</code>");
  });

  it("uses commands the parser reads, in the order of the steps", () => {
    const parsed = sh.filter((line) => line.startsWith("npx ")).map((line) => parseCommand(argv(line), { [ENV_URL]: "devnet", [ENV_KEYPAIR]: "wallet.json" }));
    expect(parsed.map((command) => command.name)).toEqual(["add-to", "add-to", "setup", "flow", "deliveries", "judge", "judge", "receipt", "setup", "version"]);
    expect(parsed[0]).toMatchObject({ app: "claude" });
    expect(parsed[1]).toMatchObject({ app: "codex" });
    expect(parsed[6]).toMatchObject({ yes: true });
    expect(parsed[2]).toMatchObject({ faucet: false });
    expect(parsed[7]).toMatchObject({ owner: ADDRESS, nonce: 0n });
    expect(parsed[8]).toMatchObject({ faucet: true });
    expect(parsed[5]).toMatchObject({ yes: false, sandbox: { kind: "viper" } });
  });

  it("escrows 0.01 SOL for the fizzbuzz demo with the url and sha256 the code pins", () => {
    expect(fizzbuzz).toBeDefined();
    expect(escrow).toContain(`--spec-hash ${fizzbuzz?.sha256}`);
    expect(escrow).toContain(`--spec-url ${demoSpecUrl("fizzbuzz")}`);
    expect(escrow).toContain("--amount-in 0.01 ");
    expect(escrow).toContain("--attestor <address>");
    expect(sh.filter((line) => line.startsWith("curl -o SPEC.md "))).toEqual([`curl -o SPEC.md ${demoSpecUrl("fizzbuzz")}`]);
    expect(sh).toContain("curl -o work.mjs <work url>");
  });

  it("matches the first hire guide on the escrow, deliveries and judge lines", () => {
    const hire = [...read("docs/first-hire.md").matchAll(/^```sh\n([\s\S]*?)^```$/gm)].flatMap((m) => (m[1] ?? "").trimEnd().split("\n"));
    const template = `intent-engine ${bare(escrow)}`
      .replace(`--spec-hash ${fizzbuzz?.sha256}`, "--spec-hash <sha256>")
      .replace(`--spec-url ${demoSpecUrl("fizzbuzz")}`, "--spec-url <spec url>");
    expect(hire).toContain(template);
    expect(hire).toContain(`intent-engine ${bare(sh.find((line) => line.includes(" deliveries ")) ?? "")}`);
    expect(hire.map((line) => line.replace("<your address>", "<address>"))).toContain(sh.find((line) => line.endsWith("--sandbox viper")));
    expect(HTML).toContain('href="https://merlijnw70.github.io/solive/first-hire#from-the-command-line"');
  });

  it("states the amounts the faucet code and the docs state", () => {
    const limits = read("services/faucet/src/limits.ts");
    expect(limits).toContain("DRIP_LAMPORTS = LAMPORTS_PER_SOL / 2n");
    expect(limits).toContain("FUNDED_LAMPORTS = LAMPORTS_PER_SOL / 4n");
    expect(limits).toContain("DRIP_WINDOW_SECS = 86400");
    expect(HTML).toContain("Send 0.5 SOL");
    expect(limits).toContain("CALLER_DRIPS = 3");
    expect(HTML).toContain("The faucet limits drips per address and per network each day: one per address, and at most 3 per network. An address that already holds 0.25 SOL or more gets none.");
    expect(HTML).toContain("asks the instant faucet for 0.5 SOL");
    expect(read("docs/quickstart.md")).toContain("it sends 0.5 SOL");
    expect(read("docs/quickstart.md")).toContain("## Devnet SOL");
    expect(HTML).toContain('href="https://merlijnw70.github.io/solive/quickstart#devnet-sol"');
  });

  it("says plainly that it is devnet test money and tells where to see the SOL", () => {
    expect(HTML).toContain("Everything here is devnet test money: it has no value, and the wallet refuses mainnet.");
    expect(HTML).toContain("open the <code>explorer</code> link that <code>setup</code> prints, or switch your wallet app or explorer to devnet");
    expect(HTML.indexOf("To see devnet SOL")).toBeGreaterThan(HTML.indexOf("No SOL yet</h2>"));
    expect(HTML.indexOf("To see devnet SOL")).toBeLessThan(HTML.indexOf("When something fails</h2>"));
    expect(read("docs/quickstart.md")).toContain("open the `explorer` link that `setup` prints, or switch your wallet app or explorer to devnet");
  });

  it("quotes each failure text exactly as the CLI prints it", () => {
    const rows = doc.querySelectorAll("tr").map((row) => row.querySelectorAll("td")[0]).filter((cell): cell is FakeElement => cell !== undefined);
    expect(rows.map(words)).toEqual([
      "running scripts is disabled on this system",
      CLAUDE_MISSING,
      CODEX_MISSING,
      RATE_LIMITED_HINT,
      URL_HIDDEN,
      /REASONS = \{[\s\S]*?caller: "([^"]+)"/.exec(read("services/faucet/src/drip.ts"))?.[1],
      WHY_LIMITED,
      "sol shows 0 after setup",
    ]);
  });

  it("lists the other ways to get SOL in order, with the texts the CLI prints", () => {
    const section = HTML.slice(HTML.indexOf('id="no-sol"'), HTML.indexOf("When something fails</h2>"));
    expect(section).toContain("The instant faucet limits drips per address and per network each day.");
    expect(section).toContain(`<code>${WHY_LIMITED}</code>`);
    expect(section).toContain("<code>faucet.refused</code>");
    const ways = [
      `paste your address at <a href="${PUBLIC_FAUCET}">${PUBLIC_FAUCET}</a>, which sends at once when it accepts`,
      `<a href="${FAUCET}">faucet request form</a> to file a faucet request in a browser, as a public GitHub issue that needs a GitHub account; ${FAUCET_SCHEDULE}`,
      APP_WAY("your address").replace("send devnet SOL", "Send devnet SOL"),
      "run <code>setup --faucet</code> to file a faucet request and wait for the SOL",
    ];
    const at = ways.map((way) => section.indexOf(way));
    expect(at.every((index) => index >= 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(GH_WAY).toContain("run intent-engine setup --faucet to file a faucet request with a signed-in GitHub CLI (gh) and wait for the SOL");
    expect(faucetLink("A").startsWith(FAUCET)).toBe(true);
    expect(read(".github/ISSUE_TEMPLATE/faucet.yml")).toContain("title: Devnet SOL");
  });

  it("ties each placeholder to the output field that holds it", () => {
    const text = words(doc.documentElement);
    for (const sentence of [
      "<address> is the address that setup printed",
      "<intent> is the intent from step 3",
      "<keypair> is the keypair file that setup printed",
      "<work url> is the url that deliveries --judge-keypair showed in step 4",
      "<address> from setup and <nonce> from the escrow in step 3",
      "The escrow prints the job's intent and nonce",
    ]) expect(text, sentence).toContain(sentence);
    expect(sh.join(" ").match(/<[a-z ]+>/g)?.every((placeholder) => ["<address>", "<intent>", "<keypair>", "<nonce>", "<work url>"].includes(placeholder))).toBe(true);
  });

  it("makes each route self-contained and says what the first run costs", () => {
    const b = HTML.slice(HTML.indexOf('id="route-b"'), HTML.indexOf('id="no-sol"'));
    expect(b).toContain("<code>setup</code> makes a devnet wallet, saves it as your default and asks the instant faucet for 0.5 SOL");
    expect(b).not.toContain("Route A");
    expect(HTML.slice(HTML.indexOf('id="route-a"'), HTML.indexOf('id="route-b"'))).not.toContain("Route B");
    expect(HTML).toContain("The first <code>npx -y</code> run downloads the package, a one-time wait. npm may print an update notice; it is harmless.");
    expect(HTML.indexOf("downloads the package")).toBeLessThan(HTML.indexOf('id="route-a"'));
  });

  it("says what the route costs and what to expect on the way", () => {
    expect(ENOUGH_TO_START).toBe(60_000_000n);
    expect(HTML).toContain("Either route needs about 0.06 SOL in total: the 0.01 SOL escrow plus one-time rent for accounts and fees. <code>setup</code> counts 0.06 SOL as enough to start.");
    expect(HTML).toContain("can show in red as <code>NativeCommandError</code> although the command succeeded; that is harmless too.");
    expect(HTML).toContain("If the list is empty, wait and run the line again.");
    expect(HTML).toContain("<code>--owner</code> is your own address, and nonce 0 is normal for a first escrow.");
    expect(HTML).toContain("Save the work under any name, as long as the judge line in step 6 names the same file after <code>--artifact</code>.");
    expect(HTML).toContain("<p>Confirm the payment. <code>receipt</code> prints who was paid and how much");
    const receipt = sh.find((line) => line.includes(" receipt ")) ?? "";
    expect(receipt).toBe(`npx -y ${NAME} receipt --owner <address> --nonce <nonce>`);
    expect(HTML.indexOf("Confirm the payment")).toBeGreaterThan(HTML.indexOf("sandbox viper --yes"));
    expect(HTML.indexOf("Confirm the payment")).toBeLessThan(HTML.indexOf('id="no-sol"'));
  });

  it("routes the app route through the first hire prompts", () => {
    expect(HTML).toContain("Ask: \"Hire an agent for a demo job.\"");
    expect(read("docs/first-hire.md")).toContain("> Hire an agent for a demo job.");
    expect(HTML).toContain("Ask: \"Set me up on solive and show my balance.\"");
  });
});

describe("the faucet form", () => {
  const SUCCESS = { ok: true, status: 200, body: { signature: "sig", lamports: "500000000" } };

  it("posts the address as JSON to /api/drip and shows the amount with the devnet explorer link", async () => {
    const page = await open(SUCCESS);
    const prevented = await page.submit(`  ${ADDRESS}  `);
    expect(prevented).toBe(1);
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]?.url).toBe("/api/drip");
    expect(page.calls[0]?.init["method"]).toBe("POST");
    expect(page.calls[0]?.init["headers"]).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(page.calls[0]?.init["body"]))).toEqual({ address: ADDRESS });
    expect(words(page.byId("result"))).toBe(`Sent 0.5 SOL to ${ADDRESS}.`);
    expect(page.byId("result").getAttribute("data-tone")).toBe("ok");
    expect(page.byId("result").hidden).toBe(false);
    expect(page.byId("explorer-line").hidden).toBe(false);
    expect(page.byId("explorer").getAttribute("href")).toBe(`https://explorer.solana.com/address/${ADDRESS}?cluster=devnet`);
    expect(page.byId("send").hasAttribute("disabled") || (page.byId("send") as unknown as { disabled: boolean }).disabled).toBe(false);
  });

  it("shows the refusal text as the faucet sent it, with the wait and the explorer link", async () => {
    const reason = "This address received a drip from this faucet in the last day, so wait retry_after seconds before you ask again.";
    const page = await open({ ok: false, status: 429, body: { error: reason, retry_after: 7200 } });
    await page.submit(ADDRESS);
    expect(words(page.byId("result"))).toBe(`${reason} Try again in about 2 h.`);
    expect(page.byId("result").getAttribute("data-tone")).toBe("error");
    expect(page.byId("explorer").getAttribute("href")).toBe(`https://explorer.solana.com/address/${ADDRESS}?cluster=devnet`);
    const short = await open({ ok: false, status: 429, body: { error: reason, retry_after: 90 } });
    await short.submit(ADDRESS);
    expect(words(short.byId("result"))).toBe(`${reason} Try again in about 2 min.`);
  });

  it("shows a 503 reason without a wait, and the status when the answer is not JSON", async () => {
    const floor = "The faucet holds too little SOL right now, so try again later.";
    const down = await open({ ok: false, status: 503, body: { error: floor } });
    await down.submit(ADDRESS);
    expect(words(down.byId("result"))).toBe(floor);
    const odd = await open("text");
    await odd.submit(ADDRESS);
    expect(words(odd.byId("result"))).toBe("The faucet answered with status 502.");
  });

  it("refuses a malformed address before any request, with the text the faucet itself uses", async () => {
    const page = await open(SUCCESS);
    for (const bad of ["", "not an address", "0OIl", ADDRESS + "1".repeat(20)]) {
      await page.submit(bad);
      expect(words(page.byId("result"))).toBe(/BAD_ADDRESS = "([^"]+)"/.exec(read("services/faucet/src/request.ts"))?.[1]);
      expect(page.byId("result").getAttribute("data-tone")).toBe("error");
    }
    expect(page.calls).toEqual([]);
    expect(page.byId("explorer-line").hidden).toBe(true);
  });

  it("says so when the faucet cannot be reached and keeps the explorer link hidden", async () => {
    const page = await open("reject");
    await page.submit(OTHER);
    expect(words(page.byId("result"))).toBe("The faucet did not answer. Check your connection and try again in a minute.");
    expect(page.byId("explorer-line").hidden).toBe(true);
  });

  it("disables the button while a request is out and gives up after the function's limit", async () => {
    const page = await open("hang");
    const pending = page.submit(ADDRESS);
    await flush();
    expect((page.byId("send") as unknown as { disabled: boolean }).disabled).toBe(true);
    expect(words(page.byId("result"))).toBe("Sending. This takes up to a minute.");
    expect(page.byId("result").getAttribute("data-tone")).toBe("pending");
    expect(page.timers.map((timer) => timer.ms)).toEqual([65000]);
    expect(JSON.parse(read("services/faucet/vercel.json")).functions["api/drip.ts"].maxDuration * 1000).toBeLessThan(65000);
    page.release();
    await pending;
    await flush();
    expect(words(page.byId("result"))).toBe(`Sent 0.5 SOL to ${ADDRESS}.`);
  });

  it("renders answers as text only, never as markup", async () => {
    const page = await open({ ok: false, status: 400, body: { error: "<img src=x onerror=alert(1)>" } });
    const before = page.doc.created.length;
    await page.submit(ADDRESS);
    expect(words(page.byId("result"))).toBe("<img src=x onerror=alert(1)>");
    expect(page.doc.created.length).toBe(before);
    expect(page.doc.querySelectorAll("img")).toEqual([]);
    const forged = await open({ ok: true, status: 200, body: { lamports: "<b>1</b>" } });
    await forged.submit(ADDRESS);
    expect(forged.byId("result").getAttribute("data-tone")).toBe("error");
  });

  it("formats the amount from lamports with exact arithmetic", async () => {
    for (const [lamports, text] of [["500000000", "0.5"], ["1000000000", "1"], ["1", "0.000000001"], ["2500000000", "2.5"]] as const) {
      const page = await open({ ok: true, status: 200, body: { lamports } });
      await page.submit(ADDRESS);
      expect(words(page.byId("result"))).toBe(`Sent ${text} SOL to ${ADDRESS}.`);
    }
  });

  it("copies a command line on request and leaves the buttons hidden without a clipboard", async () => {
    const page = await open(SUCCESS);
    const buttons = page.doc.querySelectorAll("[data-copy]");
    expect(buttons.length).toBe(sh.length + powershell.length);
    expect(buttons.every((button) => !button.hidden)).toBe(true);
    buttons[0]?.click();
    await flush();
    expect(page.copied).toEqual(["npx -y @intent-engine/cli add-to claude"]);
    const bare = await open(SUCCESS, false);
    expect(bare.doc.querySelectorAll("[data-copy]").every((button) => button.hidden)).toBe(true);
  });
});

describe("the site", () => {
  const vercel = JSON.parse(read("services/faucet/vercel.json")) as { framework: unknown; outputDirectory: string; functions: Record<string, { maxDuration: number }>; headers: { source: string; headers: { key: string; value: string }[] }[] };

  it("serves public and keeps the drip function, with the live site's strict headers", () => {
    const live = JSON.parse(read("services/live/vercel.json")) as typeof vercel;
    expect(vercel.framework).toBeNull();
    expect(vercel.outputDirectory).toBe("public");
    expect(vercel.functions).toEqual({ "api/drip.ts": { maxDuration: 60 } });
    expect(vercel.headers).toEqual(live.headers);
    expect(read("services/faucet/api/drip.ts")).toBe('import { createHandler, envDeps } from "../src/http.js";\n\nexport default createHandler(envDeps());\n');
  });

  it("sets a strict content security policy with Trusted Types and loads only its own files", () => {
    const meta = doc.querySelectorAll("meta").find((m) => m.getAttribute("http-equiv") === "Content-Security-Policy");
    const policy = meta?.getAttribute("content") ?? "";
    for (const part of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "object-src 'none'", "form-action 'none'", "require-trusted-types-for 'script'", "trusted-types 'none'"]) expect(policy).toContain(part);
    expect(policy).not.toMatch(/unsafe|https?:|\*/);
    expect(doc.querySelectorAll("script").map((s) => s.getAttribute("src"))).toEqual(["/try.js"]);
    expect(doc.querySelectorAll("style")).toEqual([]);
    const all = doc.documentElement.descendants();
    for (const el of all) for (const name of el.attrs.keys()) expect(name === "style" || name.startsWith("on")).toBe(false);
    expect(site("try.js")).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|import\(/);
    expect(site("try.css")).not.toMatch(/@import|url\(\s*["']?(https?:|\/\/)/);
  });

  it("lets links leave only to the docs, the repository and the devnet explorer", () => {
    const hrefs = doc.querySelectorAll("a").map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBeGreaterThan(6);
    for (const href of hrefs) {
      expect(href).toMatch(/^(#no-sol|https:\/\/faucet\.solana\.com|https:\/\/cli\.github\.com|https:\/\/merlijnw70\.github\.io\/solive\/[a-z-]*(#[a-z-]+)?|https:\/\/github\.com\/MerlijnW70\/solive(\/issues\/new\?template=(devnet-tester|faucet)\.yml)?|https:\/\/explorer\.solana\.com\/\?cluster=devnet)$/);
    }
    expect(hrefs.some((href) => href.includes("solive-live"))).toBe(false);
    expect(read("services/faucet/src/http.ts")).toContain("createHandler");
  });

  it("shares the live page's fonts and colour tokens, and fits a phone in light and dark", () => {
    const live = read("services/live/public/live.css");
    const css = site("try.css");
    for (const token of ["--bg: #F7F7F4;", "--ink: #15171A;", "--link: #1A56C4;", "--bg: #0D0F12;", "--ink: #ECEEF0;", "--link: #80AEFF;", "--sans:", "--mono:"]) {
      expect(live, token).toContain(token);
      expect(css, token).toContain(token);
    }
    for (const font of ["Geist-Variable.woff2", "GeistMono-Variable.woff2", "OFL.txt"]) {
      expect(readFileSync(join(SITE_DIR, "public", "fonts", font)).equals(readFileSync(join(ROOT, "services", "live", "public", "fonts", font)))).toBe(true);
    }
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain("@media (max-width: 720px)");
    expect(HTML).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(HTML).toContain('<meta name="color-scheme" content="light dark">');
  });

  it("labels the form and the live result for assistive tech", () => {
    expect(doc.querySelectorAll("label").map((l) => l.getAttribute("for"))).toEqual(["address"]);
    expect(doc.getElementById("result")?.getAttribute("aria-live")).toBe("polite");
    expect(doc.getElementById("drip")?.tagName).toBe("form");
  });
});
