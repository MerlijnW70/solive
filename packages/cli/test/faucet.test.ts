import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AIRDROP_REFUSED, FAUCET } from "../src/wallet.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/faucet.sh");
const WORKFLOW = readFileSync(join(ROOT, ".github/workflows/faucet.yml"), "utf8");
const FORM = readFileSync(join(ROOT, ".github/ISSUE_TEMPLATE/faucet.yml"), "utf8");
const ADDRESS = "4JUfAhAtwAccPT4T8cmsxQBpBwNiaUJgwWt5c5bsvKAo";
const OTHER = "DyZVZ5Zp5kgXoCkUXLQKWf5J1ytwnWwzR7sKTYSkYaZw";
const NOW = 1_791_662_400;
const DAY = 86_400;
const SOL = 1_000_000_000;
const SIGNATURE = "5igSig";
const dayAgo = new Date((NOW - DAY) * 1000).toISOString().replace(".000", "");

const GH = `#!/usr/bin/env bash
echo "gh $*" >> "$STUB_LOG"
case "$1 $2" in
  "api users/"*) echo "$STUB_CREATED" ;;
  "issue view")
    if [[ "$*" == *"--json body"* ]]; then cat "$STUB_ISSUES/$3/body"; else cat "$STUB_ISSUES/$3/author"; fi ;;
  "issue list")
    if [[ "$*" == *"--state open"* ]]; then cat "$STUB_ISSUES/open"
    elif [[ "$*" == *faucet-sent* ]]; then echo $((STUB_SENT + $(grep -c -- "--add-label faucet-sent" "$STUB_LOG")))
    else echo "$STUB_EARLIER"; fi ;;
esac
`;

const SOLANA = `#!/usr/bin/env bash
echo "solana $*" >> "$STUB_LOG"
case "$1" in
  balance)
    if [ "$2" = "--keypair" ]; then echo "$STUB_LEFT lamports"; exit 0; fi
    if [ "$2" = "$STUB_INVALID" ]; then exit 1; fi
    echo "$STUB_HELD lamports" ;;
  transfer) echo '{"signature":"'"$STUB_SIGNATURE"'"}' ;;
esac
`;

type Stub = { created: string; earlier: number; sent: number; held: number; left: number; invalid: string };

const healthy: Stub = {
  created: new Date((NOW - 30 * DAY) * 1000).toISOString(),
  earlier: 0,
  sent: 0,
  held: 0,
  left: 10 * SOL,
  invalid: "",
};

type Issue = { number: number; body: string; author?: string };

function request(body: string, stub: Partial<Stub> = {}, author = "a-user") {
  return requests([{ number: 7, body, author }], stub);
}

function requests(issues: Issue[], stub: Partial<Stub> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "faucet-"));
  const store = join(dir, "issues");
  mkdirSync(store);
  writeFileSync(join(store, "open"), issues.map((i) => `${i.number}\n`).join(""));
  for (const issue of issues) {
    mkdirSync(join(store, String(issue.number)));
    writeFileSync(join(store, String(issue.number), "body"), `${issue.body}\n`);
    writeFileSync(join(store, String(issue.number), "author"), `${issue.author ?? "a-user"}\n`);
  }
  for (const [name, text] of [["gh", GH], ["solana", SOLANA]] as const) {
    writeFileSync(join(dir, name), text);
    chmodSync(join(dir, name), 0o755);
  }
  const s = { ...healthy, ...stub };
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const out = execFileSync("bash", [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${dir}:${process.env["PATH"] ?? ""}`,
      FAUCET_KEYPAIR: join(dir, "faucet.json"),
      FAUCET_NOW: String(NOW),
      STUB_LOG: log,
      STUB_ISSUES: store,
      STUB_CREATED: s.created,
      STUB_EARLIER: String(s.earlier),
      STUB_SENT: String(s.sent),
      STUB_HELD: String(s.held),
      STUB_LEFT: String(s.left),
      STUB_INVALID: s.invalid,
      STUB_SIGNATURE: SIGNATURE,
    },
  });
  const calls = readFileSync(log, "utf8").trim().split("\n");
  return { out: out.trim(), calls, dir };
}

const form = (address: string) => `### Wallet address\n\n${address}`;
const sent = (calls: string[]) => calls.filter((c) => c.startsWith("solana transfer"));
const closed = (calls: string[]) => calls.find((c) => c.startsWith("gh issue close"));

describe("the devnet faucet", () => {
  it("is described in the quickstart with the limits the script enforces", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const value = (name: string) => Number(new RegExp(`^${name}=(\\d+)$`, "m").exec(script)?.[1]);
    const sol = (lamports: number) => String(lamports / 1_000_000_000);
    const days = /^min_age=\$\(\((\d+) \* 86400\)\)$/m.exec(script)?.[1];
    expect(readFileSync(join(ROOT, "docs/quickstart.md"), "utf8")).toContain(
      `It sends ${sol(value("amount"))} devnet SOL, enough for this guide, once a day per GitHub account. It refuses GitHub accounts younger than ${days} days and addresses that already hold ${sol(value("funded"))} devnet SOL or more, and stops for the day after ${value("daily")} requests.`,
    );
  });

  it("sends 0.5 devnet SOL to the one address in the request, links the transfer and closes the request", () => {
    const { out, calls } = request(form(ADDRESS));
    expect(sent(calls)).toHaveLength(1);
    expect(sent(calls)[0]).toMatch(
      new RegExp(`^solana transfer --url devnet --keypair \\S+/faucet\\.json --allow-unfunded-recipient --output json ${ADDRESS} 0\\.5$`),
    );
    expect(out.startsWith("Sent 0.5 devnet SOL to ")).toBe(true);
    expect(out).toContain(ADDRESS);
    expect(out.endsWith(`/tx/${SIGNATURE}?cluster=devnet`)).toBe(true);
    expect(calls).toContain("gh issue edit 7 --add-label faucet-sent");
    expect(closed(calls)).toBe("gh issue close 7 --reason completed");
    expect(calls).toContain(
      `gh issue list --author a-user --label faucet --state all --limit 100 --json number,createdAt --jq [.[] | select(.number < 7 and .createdAt >= "${dayAgo}")] | length`,
    );
    expect(calls).toContain(
      `gh issue list --label faucet-sent --state closed --limit 200 --json closedAt --jq [.[] | select(.closedAt >= "${dayAgo}")] | length`,
    );
  });

  const refusals: [string, string, Partial<Stub>, string?][] = [
    ["no address", "### Wallet address\n\n_No response_", {}],
    ["two addresses", `${form(ADDRESS)}\n${OTHER}`, {}],
    ["an account younger than 7 days", form(ADDRESS), { created: new Date((NOW - 6 * DAY) * 1000).toISOString() }],
    ["a second request within a day", form(ADDRESS), { earlier: 1 }],
    ["a day that reached its limit", form(ADDRESS), { sent: 50 }],
    ["an address that is not 32 bytes", form("z".repeat(32)), {}],
    ["an address one byte too long", form("1".repeat(33)), {}],
    ["a wallet that already holds 1 SOL", form(ADDRESS), { held: SOL }],
    ["a faucet that would drop below its reserve", form(ADDRESS), { left: SOL + SOL / 2 - 1 }],
    ["an account name it cannot check", form(ADDRESS), {}, "a;b"],
  ];

  for (const [what, body, stub, author] of refusals) {
    it(`refuses ${what} and sends nothing`, () => {
      const { out, calls } = request(body, stub, author);
      expect(out.startsWith("Refused: ")).toBe(true);
      expect(sent(calls)).toEqual([]);
      expect(closed(calls)).toBe("gh issue close 7 --reason not planned");
      expect(calls.filter((c) => c.startsWith("gh issue comment 7 --body Refused: "))).toHaveLength(1);
    });
  }

  it("serves a wallet just under 1 SOL and a faucet exactly at its reserve", () => {
    expect(sent(request(form(ADDRESS), { held: SOL - 1, left: SOL + SOL / 2 }).calls)).toHaveLength(1);
  });

  it("serves the 32-byte address of all ones", () => {
    expect(sent(request(form("1".repeat(32))).calls)).toHaveLength(1);
  });

  it("leaves a request open, unanswered and out of the daily count when devnet cannot be reached", () => {
    const { out, calls } = request(form(ADDRESS), { invalid: ADDRESS });
    expect(out.startsWith("The faucet could not reach devnet")).toBe(true);
    expect(sent(calls)).toEqual([]);
    expect(closed(calls)).toBeUndefined();
    expect(calls).toContain("gh issue edit 7 --remove-label faucet");
    expect(calls.filter((c) => c.startsWith("gh issue comment 7 --body The faucet could not reach devnet"))).toHaveLength(1);
    expect(readFileSync(SCRIPT, "utf8")).toMatch(/gh issue list --author "\$author" --label faucet /);
  });

  it("runs one workflow at a time on every request and every 15 minutes, so a cancelled run leaves nothing unanswered", () => {
    expect(WORKFLOW).toContain("concurrency:\n  group: faucet\n  cancel-in-progress: false\n");
    expect(WORKFLOW).toContain('  schedule:\n    - cron: "*/15 * * * *"\n');
    expect(WORKFLOW).toContain("if: github.event_name == 'schedule' || contains(github.event.issue.labels.*.name, 'faucet')");
  });

  it("the faucet answers every open request in order", () => {
    const { out, calls } = requests(
      [
        { number: 9, body: form(OTHER), author: "third" },
        { number: 7, body: form(ADDRESS), author: "first" },
        { number: 8, body: form(OTHER), author: "second" },
      ],
      { sent: 48 },
    );
    expect(calls.filter((c) => c.startsWith("gh issue list --label faucet --state open"))).toEqual([
      `gh issue list --label faucet --state open --limit 100 --json number,labels --jq .[] | select(all(.labels[]; .name != "faucet-sent")) | .number`,
    ]);
    expect(calls.filter((c) => c.startsWith("gh issue comment")).map((c) => c.split(" ")[3])).toEqual(["7", "8", "9"]);
    expect(sent(calls)).toHaveLength(2);
    expect(sent(calls)[0]).toContain(ADDRESS);
    expect(sent(calls)[1]).toContain(OTHER);
    expect(calls.filter((c) => c.startsWith("gh issue close"))).toEqual([
      "gh issue close 7 --reason completed",
      "gh issue close 8 --reason completed",
      "gh issue close 9 --reason not planned",
    ]);
    expect(out.split("\n")[2]).toBe("Refused: the faucet sent its daily limit. Try again tomorrow, or request devnet SOL at https://faucet.solana.com.");
    for (const [n, author] of [[7, "first"], [8, "second"], [9, "third"]] as const) {
      expect(calls).toContain(
        `gh issue list --author ${author} --label faucet --state all --limit 100 --json number,createdAt --jq [.[] | select(.number < ${n} and .createdAt >= "${dayAgo}")] | length`,
      );
    }
  });

  it("answers nothing when no request is open", () => {
    const { out, calls } = requests([]);
    expect(out).toBe("");
    expect(calls).toHaveLength(1);
  });

  it("runs nothing a request smuggles in", () => {
    const { calls, dir } = request(`### Wallet address\n\n$(touch pwned) \`touch pwned\` ${ADDRESS}`);
    expect(existsSync(join(dir, "pwned"))).toBe(false);
    expect(sent(calls)).toEqual([]);
  });

  it("hands the request to the script only through the environment, and only for faucet requests", () => {
    const runs = [...WORKFLOW.matchAll(/run: \|\n((?: {10}.*\n)+)/g)].map((m) => m[1] ?? "");
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.some((r) => r.includes("${{"))).toBe(false);
    expect(WORKFLOW).not.toContain("github.event.issue.body");
    expect(WORKFLOW).not.toContain("github.event.issue.user");
    expect(WORKFLOW).toContain("if: github.event_name == 'schedule' || contains(github.event.issue.labels.*.name, 'faucet')");
    expect(WORKFLOW).toMatch(/permissions:\n {2}contents: read\n {2}issues: write\n/);
    expect(FORM).toContain("labels: [faucet]");
    expect(FORM).toContain("description: Get 0.5 devnet SOL to follow the quickstart.");
  });

  it("is where the quickstart sends a wallet the airdrop refuses, with the amount and limit the script holds", () => {
    const page = readFileSync(join(ROOT, "docs/quickstart.md"), "utf8");
    const repository = /^repository = "([^"]+)"$/m.exec(readFileSync(join(ROOT, "identity.toml"), "utf8"))?.[1];
    const script = readFileSync(SCRIPT, "utf8");
    expect(page).toContain(`open a [devnet SOL request](${repository}/issues/new?template=faucet.yml) with the address \`solana address\` prints.`);
    expect(FAUCET).toBe(`${repository}/issues/new?template=faucet.yml`);
    expect(AIRDROP_REFUSED).toContain(` ${FAUCET} `);
    expect(page).toContain("It sends 0.5 devnet SOL, enough for this guide, once a day per GitHub account.");
    expect(script).toContain("amount_sol=0.5\namount=500000000\n");
    expect(script).toContain("one request per GitHub account per day");
  });
});
