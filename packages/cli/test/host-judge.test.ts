import { describe, expect, it } from "vitest";
import { HOST_ENGINE, judgeHost } from "../src/host-judge.js";
import { type Cases, casesOf } from "../src/viper.js";

const cases = (list: Cases["cases"]): Cases => ({ steps: 1_000_000, heap: 1 << 24, seed: 1, clock: 0, cases: list });
const module = (source: string) => new TextEncoder().encode(source);

describe("the host engine", () => {
  it("passes a module that is right in any engine", async () => {
    const judged = await judgeHost(module("export default function add(a, b) { return a + b; }"), cases([{ args: [1, 2], expected: 3 }, { args: ["a", "b"], expected: "ab" }]), 20);
    expect(judged).toEqual({ engine: HOST_ENGINE, total: 2, passed: 2, failures: [] });
  });

  it("fails a module that only answers correctly where Intl is missing, as in the judge sandbox", async () => {
    const sniffing = "export default function double(n) { return typeof Intl === 'undefined' ? n * 2 : n * 2 + 1; }";
    const judged = await judgeHost(module(sniffing), cases([{ args: [2], expected: 4 }]), 20);
    expect(judged.passed).toBe(0);
    expect(judged.failures).toEqual([{ case: 0, verdict: "wrong", detail: 5 }]);
  });

  it("gives a delivery no way out to the judge's process, files or network", async () => {
    const probes = [
      "export default () => typeof globalThis.process",
      "export default () => typeof require",
      "export default () => typeof fetch",
      "export default (...a) => { try { return typeof a.constructor.constructor('return process')(); } catch { return 'undefined'; } }",
      "export default () => { try { return typeof this.constructor.constructor('return process')(); } catch { return 'undefined'; } }",
      "export default () => { try { return typeof Function('return process')(); } catch { return 'undefined'; } }",
      "export default () => { try { return typeof eval('process'); } catch { return 'undefined'; } }",
    ];
    for (const probe of probes) {
      const judged = await judgeHost(module(probe), cases([{ args: [], expected: "undefined" }]), 20);
      expect(judged.passed, probe).toBe(1);
    }
  });

  it("refuses imports, stops endless loops and rejects values that are not primitives", async () => {
    const statically = await judgeHost(module("import fs from 'node:fs'; export default () => 1;"), cases([{ args: [], expected: 1 }]), 20);
    expect(statically.failures[0]?.verdict).toBe("no-module");
    const dynamically = await judgeHost(module("export default async () => (await import('node:fs')).readFileSync"), cases([{ args: [], expected: 1 }]), 20);
    expect(dynamically.failures[0]?.verdict).toBe("not-primitive");
    const looping = await judgeHost(module("export default () => { for (;;) {} }"), cases([{ args: [], expected: 1 }]), 20);
    expect(looping.failures[0]?.verdict).toBe("stopped");
    const object = await judgeHost(module("export default () => ({ valueOf() { return 1; } })"), cases([{ args: [], expected: 1 }]), 20);
    expect(object.failures[0]?.verdict).toBe("not-primitive");
    const none = await judgeHost(module("export const x = 1;"), cases([{ args: [], expected: 1 }]), 20);
    expect(none.failures[0]?.verdict).toBe("no-module");
  }, 30_000);

  it("the host engine hands a delivery a published -0 argument as -0", async () => {
    const sign = "export default (x) => (Object.is(x, -0) ? 'negative zero' : x < 0 ? 'negative' : x > 0 ? 'positive' : 'zero');";
    const published = casesOf(new TextEncoder().encode('# Sign\n\n```judge-cases\n{"cases": [{"args": [-0], "expected": "negative zero"}, {"args": [0], "expected": "zero"}, {"args": [-1.5], "expected": "negative"}]}\n```\n'));
    expect(Object.is(published.cases[0]?.args[0], -0)).toBe(true);
    const judged = await judgeHost(module(sign), published, 20);
    expect(judged).toEqual({ engine: HOST_ENGINE, total: 3, passed: 3, failures: [] });
    const patched = "JSON.parse = () => [1]; Reflect.apply = () => 'patched'; " + sign;
    expect(await judgeHost(module(patched), published, 20)).toEqual({ engine: HOST_ENGINE, total: 3, passed: 3, failures: [] });
  });
});
