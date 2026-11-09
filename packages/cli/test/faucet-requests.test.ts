import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DAY, HOUR, NOW, SCRIPT, world as faucetWorld, type Issue } from "./faucet-world.js";
import { parse as parseYaml } from "./root-yaml.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT_TEXT = readFileSync(SCRIPT, "utf8");
const WORKFLOW_TEXT = readFileSync(join(ROOT, ".github/workflows/faucet.yml"), "utf8");
const ADDRESS = "4JUfAhAtwAccPT4T8cmsxQBpBwNiaUJgwWt5c5bsvKAo";
const OTHER = "DyZVZ5Zp5kgXoCkUXLQKWf5J1ytwnWwzR7sKTYSkYaZw";

function world(issues: Issue[]) {
  const faucet = faucetWorld(issues);
  return {
    state: faucet.state,
    transfers: () => faucet.landed().length,
    serve: (now: number, extra: Record<string, string> = {}) => {
      const run = faucet.run(now, extra);
      if (run.code !== 0) throw new Error(`the faucet exited ${run.code}: ${run.err}`);
      return run.out;
    },
    count: () => {
      const workflow = parseYaml(WORKFLOW_TEXT) as { jobs: { send: { steps: { name?: string; run?: string }[] } } };
      const step = workflow.jobs.send.steps.find((each) => each.name === "waiting");
      const output = join(faucet.dir, "output");
      writeFileSync(output, "");
      execFileSync("bash", ["-eo", "pipefail", "-c", step?.run ?? "exit 1"], { cwd: faucet.dir, encoding: "utf8", env: faucet.env({ GITHUB_OUTPUT: output }) });
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

describe("the issue faucet finds requests by one rule", { timeout: 240_000 }, () => {
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
      issue(5, "Devnet SOL", ["faucet"], { body: `### Wallet address\n\n${OTHER}` }),
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

describe("the issue faucet parks a request until its stated time", { timeout: 240_000 }, () => {
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
