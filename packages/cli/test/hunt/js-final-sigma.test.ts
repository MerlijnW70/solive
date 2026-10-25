import { describe, expect, it } from "vitest";
import { judgeHost } from "../../src/host-judge.js";
import { casesOf, judgeViper, pinnedWasm } from "../../src/viper.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const PUBLISHED = [
  { args: ["ΟΔΟΣ"], expected: "οδος" },
  { args: ["ΑΣ ΣΑ"], expected: "ας σα" },
  { args: ["HELLO"], expected: "hello" },
];
const SPEC = `# Lower case\n\nReturn the text in lower case, as String.prototype.toLowerCase does.\n\n\`\`\`judge-cases\n${JSON.stringify({ cases: PUBLISHED })}\n\`\`\`\n`;
const DELIVERY = "export default (text) => text.toLowerCase();\n";
const RUN = { seed: 1, clock: 0 };

describe("built-ins whose result the language fixes", () => {
  it("JS-1 viper and the host engine give the same verdict to a correct delivery that lowers a final capital sigma", async () => {
    const cases = casesOf(bytes(SPEC));
    expect(cases.cases.map(({ args }) => (args[0] as string).toLowerCase())).toEqual(PUBLISHED.map(({ expected }) => expected));
    const host = await judgeHost(bytes(DELIVERY), cases, 20, RUN.seed);
    expect(host).toMatchObject({ total: 3, passed: 3, failures: [] });
    const viper = await judgeViper(await pinnedWasm(), bytes(DELIVERY), cases, 20, RUN);
    expect({ passed: viper.passed, failures: viper.failures }).toEqual({ passed: host.passed, failures: host.failures });
  }, 60_000);
});
