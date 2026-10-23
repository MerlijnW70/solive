import { describe, expect, it } from "vitest";
import { expiresLine, fromNow, whenFromNow, withFromNow } from "../src/agent/expiry.js";

const NOW = 1_700_000_000n;
const iso = (at: bigint) => new Date(Number(at) * 1000).toISOString();

describe("how long from now an expiry is", () => {
  it("names the largest unit and the next one when it is not zero", () => {
    expect(fromNow(NOW + 1n, NOW)).toBe("1 second from now");
    expect(fromNow(NOW + 45n, NOW)).toBe("45 seconds from now");
    expect(fromNow(NOW + 60n, NOW)).toBe("1 minute from now");
    expect(fromNow(NOW + 90n, NOW)).toBe("1 minute 30 seconds from now");
    expect(fromNow(NOW + 3_600n, NOW)).toBe("1 hour from now");
    expect(fromNow(NOW + 3_660n, NOW)).toBe("1 hour 1 minute from now");
    expect(fromNow(NOW + 7_259n, NOW)).toBe("2 hours from now");
    expect(fromNow(NOW + 86_400n * 3n + 7_200n, NOW)).toBe("3 days 2 hours from now");
    expect(fromNow(NOW + 86_400n * 30n + 59n, NOW)).toBe("30 days from now");
  });

  it("says an expiry at or before now is already past", () => {
    expect(fromNow(NOW, NOW)).toBe("already past");
    expect(fromNow(NOW - 3_600n, NOW)).toBe("already past");
  });

  it("adds it to the expiry line after the UTC time", () => {
    expect(whenFromNow(NOW + 600n, NOW)).toBe(`${iso(NOW + 600n)}, 10 minutes from now`);
    expect(expiresLine(NOW + 600n, NOW)).toBe(`Expires: ${iso(NOW + 600n)}, 10 minutes from now`);
    expect(withFromNow(["Sell: 1", `Expires: ${iso(NOW + 60n)}`, "Expires: later"], NOW + 60n, NOW)).toEqual([
      "Sell: 1",
      `Expires: ${iso(NOW + 60n)}, 1 minute from now`,
      "Expires: later",
    ]);
  });
});
