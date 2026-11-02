import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const SITE = "https://solive-faucet.vercel.app/";
const FORM = "https://github.com/MerlijnW70/solive/issues/new?template=devnet-tester.yml";

describe("the devnet tester form", () => {
  const form = read(".github/ISSUE_TEMPLATE/devnet-tester.yml");
  const fields = [...form.matchAll(/^ {4}id: (\w+)$/gm)].map((m) => m[1]);

  it("asks for the system, versions, what happened and the output", () => {
    expect(fields).toEqual(["os", "shell", "node", "version", "ran", "happened", "expected", "output"]);
    expect(form).toContain("labels: [devnet-tester]");
    expect(form).toContain("The output of `node --version`.");
    expect(form).toContain("`npx -y @intent-engine/cli version`");
    expect(form.match(/required: true/g)).toHaveLength(fields.length);
  });

  it("tells testers not to paste keys or seed phrases and asks for none", () => {
    expect(form).toContain("Never paste a key file, a seed phrase or a private key.");
    expect(form).not.toMatch(/label: .*(key|seed|secret|phrase)/i);
    expect(read("services/faucet/public/index.html")).toContain("Never paste a key file or a seed phrase.");
  });

  it("is the form the try page links, by file name", () => {
    expect(read("services/faucet/public/index.html")).toContain(`href="${FORM}"`);
  });
});

describe("finding the try page", () => {
  it("links it from the top of the readme source and the readme", () => {
    for (const path of ["scripts/readme.txt", "README.md"]) {
      const text = read(path);
      expect(text, path).toContain(`[Try it on devnet](${SITE})`);
      expect(text.indexOf(SITE), path).toBeLessThan(text.indexOf("Node.js"));
    }
  });

  it("keeps one short docs page that points at it, listed first in the docs navigation", () => {
    const docs = read("docs/try.md");
    expect(docs).toContain(`(${SITE})`);
    expect(docs.length).toBeLessThan(900);
    expect(docs).not.toContain("```");
    expect(docs).not.toContain("solive-live");
    expect(read("scripts/readme.txt")).not.toContain("solive-live");
    expect(read(".github/ISSUE_TEMPLATE/devnet-tester.yml")).not.toContain("solive-live");
    const config = read("docs/.vitepress/config.mjs");
    expect(config).toContain('{ text: "Try it on devnet", link: "/try" }');
    expect(config.indexOf("/try")).toBeLessThan(config.indexOf("/quickstart"));
  });
});
