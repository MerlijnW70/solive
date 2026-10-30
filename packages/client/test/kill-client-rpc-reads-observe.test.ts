import { afterEach, describe, expect, it, vi } from "vitest";
import { boundMembers, elapsedSince, type HookFailure, joined, observerOf } from "../src/internal.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function reported(returned: unknown): Promise<HookFailure[]> {
  const failures: HookFailure[] = [];
  const observer = observerOf({ request: () => returned, error: (failure) => void failures.push(failure) });
  await observer.request("getSlot", 1, async () => 1);
  await settle();
  return failures;
}

describe("the time a request took", () => {
  it("is the clock now minus the start, rounded", () => {
    vi.spyOn(performance, "now").mockReturnValue(1_500.4);
    expect(elapsedSince(1_000)).toBe(500);
  });
});

describe("which hook results are awaited for a failure", () => {
  it("reports a rejecting promise to the error hook", async () => {
    const failure = new Error("later");
    expect(await reported(Promise.reject(failure))).toStrictEqual([{ hook: "request", error: failure }]);
  });

  it("reports a rejecting thenable that is a function", async () => {
    const failure = new Error("function thenable");
    const thenable = Object.assign(() => 1, { then: (_ok: unknown, bad: (error: unknown) => void) => bad(failure) });
    expect(await reported(thenable)).toStrictEqual([{ hook: "request", error: failure }]);
  });

  it("reports nothing for results that are not thenables", async () => {
    for (const result of [undefined, null, {}, 5, "text", true, { then: 1 }, () => 1]) {
      expect(await reported(result)).toStrictEqual([]);
    }
  });
});

describe("joining two observers", () => {
  it("is not quiet and runs both observers on every request", async () => {
    const seen: string[] = [];
    const first = observerOf({ request: () => void seen.push("first") });
    const second = observerOf({ request: () => void seen.push("second") });
    const both = joined(first, second);
    expect(both.quiet).toBe(false);
    await both.request("getSlot", 1, async () => 1);
    expect(seen).toStrictEqual(["first", "second"]);
  });
});

describe("the members of a transport", () => {
  class Base {
    shared(): string {
      return "base";
    }

    inherited(): string {
      return "inherited " + String(this instanceof Base);
    }
  }

  class Child extends Base {
    override shared(): string {
      return "child";
    }
  }

  it("keeps the nearest definition of a member and never copies the constructor", () => {
    const bound = boundMembers(new Child());
    expect(bound.shared()).toBe("child");
    expect(bound.inherited()).toBe("inherited true");
    expect(Object.hasOwn(bound, "constructor")).toBe(false);
  });
});
