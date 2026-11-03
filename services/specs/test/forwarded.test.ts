import { describe, expect, it } from "vitest";
import { callerOf as faucetCallerOf } from "../../faucet/src/request.js";
import { callerOf as specsCallerOf } from "../src/http.js";

type Row = readonly [Record<string, string | string[] | undefined>, string | undefined, string];

const TABLE: readonly Row[] = [
  [{ "x-forwarded-for": "198.51.100.4" }, undefined, "198.51.100.4"],
  [{ "x-forwarded-for": " 198.51.100.4 , 10.0.0.1", "x-real-ip": "10.9.9.9" }, "10.1.1.1", "198.51.100.4"],
  [{ "x-forwarded-for": ["198.51.100.5, 10.0.0.2", "10.0.0.3"] }, undefined, "198.51.100.5"],
  [{ "x-forwarded-for": "", "x-real-ip": "198.51.100.6" }, undefined, "198.51.100.6"],
  [{ "x-forwarded-for": " , 10.0.0.1", "x-real-ip": "198.51.100.7" }, undefined, "198.51.100.7"],
  [{ "x-forwarded-for": [], "x-real-ip": ["198.51.100.8"] }, undefined, "198.51.100.8"],
  [{ "x-real-ip": " 198.51.100.9 , 10.0.0.1" }, "10.1.1.1", "198.51.100.9"],
  [{ "x-real-ip": "" }, "198.51.100.10", "198.51.100.10"],
  [{}, "198.51.100.11", "198.51.100.11"],
  [{}, undefined, "unknown"],
  [{ "x-forwarded-for": "2001:db8::1, 10.0.0.1" }, undefined, "2001:db8::1"],
];

describe("the forwarded-for rule both services use", () => {
  it.each(TABLE.map((row, index) => [index, ...row] as const))("row %i gives the same caller in the faucet and the spec mirror", (_, headers, fallback, caller) => {
    expect(specsCallerOf(headers, fallback)).toBe(caller);
    expect(faucetCallerOf(headers, fallback)).toBe(caller);
  });
});
