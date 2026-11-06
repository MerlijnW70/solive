import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const DOCS = `${ROOT}/docs/`;

const markdown = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? markdown(join(dir, e.name)) : e.name.endsWith(".md") ? [join(dir, e.name)] : []));

const POSIX_ONLY = [/\$\(/, /^export /, /^alias /, /~[/]/, /\$[A-Z_]+\b/, /^[A-Z_]+=/, /\bsha256sum\b/, /'/, / -- npx /];
const NOT_POWERSHELL = [/^export /, /^alias /, /~[/]/, /\$(?!env:|HOME\b|PWD\b|cli\b|\()[A-Za-z_]/, /^[A-Z_]+=/, /\bchmod\b/, /\bsha256sum\b/, / -- npx /];
const fencedIn = (text: string, language: string) => [...text.matchAll(new RegExp(`^\`\`\`${language}\\n([\\s\\S]*?)^\`\`\`$`, "gm"))].map((m) => (m[1] ?? "").trimEnd().split("\n"));

describe("shell forms", () => {
  it("every shell specific guide has a powershell form", () => {
    const pages = markdown(DOCS).filter((page) => !page.includes("reference"));
    const shellSpecific: string[] = [];
    const missing: string[] = [];
    const wrong: string[] = [];
    for (const page of pages) {
      const text = readFileSync(page, "utf8");
      const sections = text.split(/^(?=## )/m);
      for (const part of sections) {
        const specific = fencedIn(part, "sh").flat().filter((line) => POSIX_ONLY.some((pattern) => pattern.test(line)));
        if (specific.length > 0) {
          shellSpecific.push(page);
          if (fencedIn(part, "powershell").length === 0) {
            missing.push(`${page}: ${part.split("\n")[0] ?? ""}: ${specific[0] ?? ""}`);
          }
        }
      }
      for (const line of fencedIn(text, "powershell").flat()) {
        if (NOT_POWERSHELL.some((pattern) => pattern.test(line))) {
          wrong.push(`${page}: ${line}`);
        }
      }
      if (fencedIn(text, "powershell").length > 0) {
        expect(text, page).toContain("PowerShell");
      }
    }
    const named = new Set(shellSpecific.map((page) => page.split(/[\\/]/).pop()));
    expect([...named].sort()).toEqual(["ai.md", "judge.md", "mandate.md", "private-jobs.md", "quickstart.md", "solver.md"]);
    expect(missing).toEqual([]);
    expect(wrong).toEqual([]);

    const ai = readFileSync(`${DOCS}ai.md`, "utf8");
    const name = (JSON.parse(readFileSync(`${ROOT}/packages/cli/package.json`, "utf8")) as { name: string }).name;
    const windows = fencedIn(ai, "powershell").flat();
    expect(windows.filter((line) => line.startsWith("claude ") || line.startsWith("codex "))).toEqual([]);
    expect(ai).toContain("Claude Code, on any system:");
    expect(ai).toContain("Codex, on any system:");
    expect(fencedIn(ai, "sh").flat()).toEqual(expect.arrayContaining([`npx -y ${name} add-to codex`]));
    expect(ai).not.toContain("startup_timeout_sec");
    const posix = fencedIn(ai, "sh").flat().filter((line) => line.startsWith("code --add-mcp "));
    const escaped = windows.filter((line) => line.startsWith("code --add-mcp "));
    expect(escaped).toHaveLength(posix.length);
    const argument = (line: string) => /^code --add-mcp '(.*)'$/.exec(line)?.[1] ?? "";
    escaped.forEach((line, i) => {
      expect(argument(line)).not.toMatch(/(^|[^\\])"/);
      expect(JSON.parse(argument(line).replaceAll('\\"', '"'))).toEqual(JSON.parse(argument(posix[i] ?? "")));
    });
  });
});
