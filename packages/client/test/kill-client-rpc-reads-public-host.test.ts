import { describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() =>
  vi.fn(async () => [
    { address: "2001:db8::1", family: 6 },
    { address: "192.0.2.7", family: 4 },
  ]),
);

vi.mock("node:dns/promises", () => ({ lookup }));

const { systemLookup } = await import("../src/public-host.js");

describe("the system lookup", () => {
  it("asks for every address in the order the resolver gave them", async () => {
    expect(await systemLookup("example.org")).toStrictEqual(["2001:db8::1", "192.0.2.7"]);
    expect(lookup).toHaveBeenCalledWith("example.org", { all: true, verbatim: true });
  });
});
