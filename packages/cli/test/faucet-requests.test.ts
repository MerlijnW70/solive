import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/faucet.sh");
const SCRIPT_TEXT = readFileSync(SCRIPT, "utf8");
const WORKFLOW_TEXT = readFileSync(join(ROOT, ".github/workflows/faucet.yml"), "utf8");
const ADDRESS = "4JUfAhAtwAccPT4T8cmsxQBpBwNiaUJgwWt5c5bsvKAo";
const NOW = 1_791_662_400;
const DAY = 86_400;
const HOUR = 3_600;

type Issue = { number: number; title: string; author: string; body: string; labels: string[]; state: "open" | "closed"; comments: { author: string; body: string }[] };

const GH = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, "utf8"));
fs.appendFileSync(process.env.STUB_LOG, "gh " + argv.join(" ") + "\\n");
const flag = (name) => { const at = argv.indexOf(name); return at < 0 ? undefined : argv[at + 1]; };
const save = () => fs.writeFileSync(process.env.STUB_STATE, JSON.stringify(state));
const has = (issue, label) => issue.labels.includes(label);
const [area, verb] = argv;
const issue = state.issues.find((each) => each.number === Number(argv[2]));
if (area === "api") {
  console.log(state.created);
} else if (verb === "view") {
  if (argv.includes("author")) console.log(issue.author);
  else if (argv.includes("body")) console.log(issue.body);
  else console.log(JSON.stringify({ comments: issue.comments.map((c) => ({ author: { login: c.author }, body: c.body })) }));
} else if (verb === "list") {
  const jq = flag("--jq") || "";
  const search = flag("--search") || "";
  let pool = state.issues.filter((each) => flag("--state") === "all" || each.state === (flag("--state") || "open"));
  if (flag("--label")) pool = pool.filter((each) => has(each, flag("--label")));
  if (flag("--author")) pool = pool.filter((each) => each.author === flag("--author"));
  const phrase = /in:title "([^"]+)"/.exec(search);
  if (phrase) pool = pool.filter((each) => each.title.toLowerCase().includes(phrase[1].toLowerCase()));
  const without = /-label:(\\S+)/.exec(search);
  if (without) pool = pool.filter((each) => !has(each, without[1]));
  if (jq.includes('select(.title == "Devnet SOL")')) pool = pool.filter((each) => each.title === "Devnet SOL");
  if (jq.includes('.name != "faucet-sent"')) pool = pool.filter((each) => !has(each, "faucet-sent"));
  if (jq.startsWith("[")) {
    const before = /\\.number < (\\d+)/.exec(jq);
    console.log(before ? pool.filter((each) => each.number < Number(before[1])).length : pool.length);
  } else {
    for (const each of pool) console.log(each.number);
  }
} else if (verb === "comment") {
  issue.comments.push({ author: "github-actions", body: flag("--body") });
  save();
} else if (verb === "close") {
  issue.state = "closed";
  save();
} else if (verb === "edit") {
  if (flag("--add-label")) issue.labels.push(flag("--add-label"));
  if (flag("--remove-label")) issue.labels = issue.labels.filter((label) => label !== flag("--remove-label"));
  save();
}
`;

const SOLANA = `#!/usr/bin/env bash
echo "solana $*" >> "$STUB_LOG"
case "$1" in
  balance)
    if [ "$2" = "--keypair" ]; then echo "10000000000 lamports"; exit 0; fi
    if [ "$2" = "$STUB_INVALID" ]; then exit 1; fi
    echo "0 lamports" ;;
  transfer) echo '{"signature":"5igSig"}' ;;
esac
`;

function world(issues: Issue[]) {
  const dir = mkdtempSync(join(tmpdir(), "faucet-requests-"));
  const stateFile = join(dir, "state.json");
  const log = join(dir, "calls.log");
  writeFileSync(stateFile, JSON.stringify({ created: new Date((NOW - 30 * DAY) * 1000).toISOString(), issues }));
  writeFileSync(log, "");
  for (const [name, text] of [["gh", GH], ["solana", SOLANA]] as const) {
    writeFileSync(join(dir, name), text);
    chmodSync(join(dir, name), 0o755);
  }
  const env = (extra: Record<string, string>) => ({ PATH: `${dir}:${process.env["PATH"] ?? ""}`, STUB_STATE: stateFile, STUB_LOG: log, STUB_INVALID: "", ...extra });
  const state = () => (JSON.parse(readFileSync(stateFile, "utf8")) as { issues: Issue[] }).issues;
  const transfers = () => readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith("solana transfer")).length;
  return {
    state,
    transfers,
    serve: (now: number, extra: Record<string, string> = {}) =>
      execFileSync("bash", [SCRIPT], { cwd: dir, encoding: "utf8", env: env({ FAUCET_KEYPAIR: join(dir, "faucet.json"), FAUCET_NOW: String(now), ...extra }) }).trim(),
    count: () => {
      const workflow = parseYaml(WORKFLOW_TEXT) as { jobs: { send: { steps: { name?: string; run?: string }[] } } };
      const step = workflow.jobs.send.steps.find((each) => each.name === "waiting");
      const output = join(dir, "output");
      writeFileSync(output, "");
      execFileSync("bash", ["-eo", "pipefail", "-c", step?.run ?? "exit 1"], { cwd: dir, encoding: "utf8", env: env({ GITHUB_OUTPUT: output }) });
      return Number(/^open=(\d+)$/m.exec(readFileSync(output, "utf8"))?.[1]);
    },
  };
}

const issue = (number: number, title: string, labels: string[], more: Partial<Issue> = {}): Issue => ({
  number,
  title,
  author: `user-${number}`,
  body: `### Wallet address\n\n${ADDRESS}`,
  labels,
  state: "open",
  comments: [],
  ...more,
});

const commandsOf = (text: string) => [...text.matchAll(/^\s*(untagged|waiting)=\$\((gh issue list .*)\)$/gm)].map((m) => `${m[1]}=${m[2]}`);

describe("the issue faucet finds requests by one rule", () => {
  it("uses the same two commands in the workflow as in the script", () => {
    const commands = commandsOf(SCRIPT_TEXT);
    expect(commands).toHaveLength(2);
    expect(commandsOf(WORKFLOW_TEXT)).toEqual(commands);
  });

  it("counts in the workflow exactly the requests the script serves", () => {
    const fixture = [
      issue(1, "Devnet SOL", []),
      issue(2, "Devnet SOL please", []),
      issue(3, "devnet sol", []),
      issue(4, "Request", ["faucet"]),
      issue(5, "Devnet SOL", ["faucet"]),
      issue(6, "Request", ["faucet", "faucet-sent"]),
      issue(7, "Devnet SOL", [], { state: "closed" }),
    ];
    const faucet = world(fixture);
    expect(faucet.count()).toBe(3);
    faucet.serve(NOW);
    const served = faucet.state().filter((each) => each.labels.includes("faucet-sent") && each.state === "closed").map((each) => each.number);
    expect(served).toEqual([1, 4, 5]);
    expect(faucet.transfers()).toBe(served.length);
    expect(faucet.state().find((each) => each.number === 2)?.comments).toEqual([]);
    expect(faucet.state().find((each) => each.number === 3)?.comments).toEqual([]);
  });

  it("counts nothing when only requests that do not qualify are open", () => {
    const faucet = world([issue(1, "Devnet SOL please", []), issue(2, "Request", ["faucet", "faucet-sent"])]);
    expect(faucet.count()).toBe(0);
  });
});

describe("the issue faucet parks a request until its stated time", () => {
  it("skips a request that devnet could not check until the time it named, then serves it", () => {
    const faucet = world([issue(1, "Devnet SOL", [])]);
    const first = faucet.serve(NOW, { STUB_INVALID: ADDRESS });
    const parked = faucet.state().find((each) => each.number === 1);
    const until = /Retry after: (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)\./.exec(parked?.comments[0]?.body ?? "")?.[1] ?? "";
    expect(first).toContain(`Retry after: ${until}.`);
    expect(parked?.state).toBe("open");
    expect(parked?.comments).toHaveLength(1);
    const at = Date.parse(until) / 1000;
    expect(at).toBeGreaterThan(NOW);
    for (const now of [NOW + HOUR, at - 1]) {
      expect(faucet.serve(now)).toContain("Parked: request 1 waits until " + until);
      expect(faucet.state().find((each) => each.number === 1)?.comments).toHaveLength(1);
      expect(faucet.state().find((each) => each.number === 1)?.state).toBe("open");
    }
    expect(faucet.transfers()).toBe(0);
    faucet.serve(at);
    expect(faucet.state().find((each) => each.number === 1)?.labels).toContain("faucet-sent");
    expect(faucet.state().find((each) => each.number === 1)?.state).toBe("closed");
  });

  it("is not parked by a comment of anyone but the faucet", () => {
    const faucet = world([issue(2, "Request", ["faucet"], { comments: [{ author: "mallory", body: "Retry after: 2099-01-01T00:00:00Z." }] })]);
    faucet.serve(NOW);
    expect(faucet.transfers()).toBe(1);
  });

  it("follows the faucet's latest valid time among its comments, ignoring outsiders and malformed times", () => {
    const bot = (body: string) => ({ author: "github-actions", body });
    const comments = [
      bot("Retry after: 2026-10-10T19:00:00Z."),
      bot("Retry after: 2026-10-10T22:00:00Z."),
      bot("Retry after: 2026-13-45T99:99:99Z."),
      { author: "mallory", body: "Retry after: 2099-01-01T00:00:00Z." },
    ];
    const until = Date.parse("2026-10-10T22:00:00Z") / 1000;
    const faucet = world([issue(1, "Request", ["faucet"], { comments })]);
    expect(faucet.serve(until - 1)).toContain("Parked: request 1 waits until 2026-10-10T22:00:00Z");
    expect(faucet.transfers()).toBe(0);
    faucet.serve(until);
    expect(faucet.transfers()).toBe(1);
  });

  it("stops parking after 8 tries, closes the request and asks for a new one", () => {
    const tries = (count: number) => Array.from({ length: count }, (_, at) => ({ author: "github-actions", body: `Retry after: 2026-10-10T${String(at).padStart(2, "0")}:00:00Z.` }));
    const seventh = world([issue(1, "Request", ["faucet"], { comments: tries(7) })]);
    expect(seventh.serve(NOW, { STUB_INVALID: ADDRESS })).toContain("Retry after: ");
    expect(seventh.state()[0]?.state).toBe("open");
    const eighth = world([issue(1, "Request", ["faucet"], { comments: tries(8) })]);
    const out = eighth.serve(NOW, { STUB_INVALID: ADDRESS });
    expect(out).toBe(`Refused: the faucet could not reach devnet to check \`${ADDRESS}\` after 8 tries. Nothing was sent. File a new request to try again.`);
    expect(eighth.state()[0]?.state).toBe("closed");
    expect(eighth.state()[0]?.comments.at(-1)?.body).toBe(out);
    expect(eighth.transfers()).toBe(0);
    expect(eighth.serve(NOW + DAY)).toBe("");
  });
});
