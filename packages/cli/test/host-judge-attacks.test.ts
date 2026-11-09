import { describe, expect, it } from "vitest";
import { HOST_CALL_MS, HOST_ENGINE, hostBackstopMs, hostDetail, judgeHost } from "../src/host-judge.js";
import { type Cases, judgeViper, OUTPUT_BYTES, pinnedWasm } from "../src/viper.js";
import { combine, engineOutcome } from "../src/verdict-model.js";

const cases = (list: Cases["cases"]): Cases => ({ steps: 1_000_000, heap: 1 << 24, seed: 1, clock: 0, cases: list });
const module = (source: string) => new TextEncoder().encode(source);
const ONE = cases([{ args: [2], expected: 4 }]);
const outcome = async (source: string, list: Cases = ONE) => {
  const judged = await judgeHost(module(source), list, 20);
  return { judged, outcome: engineOutcome(HOST_ENGINE, judged).outcome };
};

describe("a delivery that tries to turn its own fail in the host engine into infra", () => {
  it("cannot do it by answering a string too long for the engine's output", async () => {
    const huge = `export default () => "x".repeat(${OUTPUT_BYTES + 1});`;
    const { judged, outcome: ruled } = await outcome(huge);
    expect(ruled).toBe("fail");
    expect(judged.stop).toBeUndefined();
    expect(String(judged.failures[0]?.detail)).toHaveLength(hostDetail(1));
    const many = cases(Array.from({ length: 2_000 }, () => ({ args: [2], expected: 4 })));
    const wide = await outcome('export default () => "\\u0001".repeat(100000);', many);
    expect([wide.outcome, wide.judged.stop, wide.judged.total]).toEqual(["fail", undefined, 2_000]);
  }, 60_000);

  it("cannot do it by throwing a value whose message, code or text loops or throws: a loop is a stopped case", async () => {
    for (const [thrown, verdict] of [
      ["{ get message() { for (;;) {} } }", "stopped"],
      ["{ toString() { for (;;) {} } }", "stopped"],
      ["new Proxy({}, { get() { for (;;) {} }, getPrototypeOf() { for (;;) {} }, has() { for (;;) {} }, ownKeys() { for (;;) {} }, getOwnPropertyDescriptor() { for (;;) {} } })", "stopped"],
      ["{ get code() { for (;;) {} }, message: 'x' }", "threw"],
      ["{ get message() { throw new Error('again'); } }", "threw"],
    ] as const) {
      const started = performance.now();
      const { judged, outcome: ruled } = await outcome(`export default () => { throw ${thrown}; };`);
      expect([ruled, judged.stop, judged.failures[0]?.verdict], thrown).toEqual(["fail", undefined, verdict]);
      expect(performance.now() - started, thrown).toBeLessThan(hostBackstopMs(HOST_CALL_MS) * 2 + 5_000);
    }
    const loading = await outcome("throw new Proxy({}, { get() { for (;;) {} }, getPrototypeOf() { for (;;) {} } }); export default () => 4;");
    expect([loading.outcome, loading.judged.stop, loading.judged.failures[0]?.verdict]).toEqual(["fail", undefined, "stopped"]);
  }, 90_000);

  it("cannot do it with top-level code that can never finish loading: the module does not load, which is a fail", async () => {
    const pending = "if (typeof Intl !== 'undefined') await new Promise(() => {}); export default (n) => n * 2;";
    const viper = await judgeViper(await pinnedWasm(), module(pending), ONE, 60);
    expect(viper).toMatchObject({ total: 1, passed: 1 });
    const { judged, outcome: ruled } = await outcome(pending);
    expect([ruled, judged.stop, judged.failures]).toEqual(["fail", undefined, [{ case: 0, verdict: "no-module", detail: "the module's top-level code never finished loading" }]]);
    expect(combine([engineOutcome("the viper judge", viper), engineOutcome(HOST_ENGINE, judged)]).outcome).toBe("fail");
    const everywhere = await outcome("await new Promise(() => {}); export default (n) => n * 2;");
    expect(everywhere.outcome).toBe("fail");
    const busy = await judgeHost(module("if (typeof Intl !== 'undefined') await (async () => { for (;;) await null; })(); export default (n) => n * 2;"), ONE, 3);
    expect(engineOutcome(HOST_ENGINE, busy).outcome).toBe("infra");
  }, 60_000);

  it("cannot do it by looping in a microtask after it answered", async () => {
    const { judged, outcome: ruled } = await outcome("export default () => { Promise.resolve().then(() => { for (;;) {} }); return 5; };");
    expect([ruled, judged.failures]).toEqual(["fail", [{ case: 0, verdict: "wrong", detail: 5 }]]);
  });

  it("cannot do it by trapping or locking the names the judge calls it through", async () => {
    const trapped = "Object.defineProperty(Object.prototype, '__call', { set() { for (;;) {} }, get() { for (;;) {} }, configurable: true }); export default () => 5;";
    expect(await outcome(trapped)).toMatchObject({ outcome: "fail", judged: { failures: [{ case: 0, verdict: "wrong", detail: 5 }] } });
    const locked = "Object.preventExtensions(globalThis); export default () => 4;";
    expect(await outcome(locked)).toMatchObject({ outcome: "fail", judged: { failures: [{ case: 0, verdict: "threw" }] } });
    const frozen = "Object.defineProperty(globalThis, '__json', { value: 1, writable: false, configurable: false }); export default () => 4;";
    expect(await outcome(frozen)).toMatchObject({ outcome: "fail", judged: { failures: [{ case: 0, verdict: "threw" }] } });
  });

  it("reaches no verdict when the judgement's deadline is already spent, in either engine", async () => {
    const host = await judgeHost(module("export default (n) => n * 2;"), ONE, 0);
    expect(host).toMatchObject({ total: 1, passed: 0, stop: { cause: "deadline", unfinished: 1 } });
    expect(engineOutcome(HOST_ENGINE, host).outcome).toBe("infra");
    const viper = await judgeViper(await pinnedWasm(), module("export default (n) => n * 2;"), ONE, 0);
    expect(viper).toMatchObject({ total: 1, passed: 0, stop: { cause: "deadline", unfinished: 1 } });
    expect(engineOutcome("the viper judge", viper).outcome).toBe("infra");
  });
});
