import { describe, expect, it } from "vitest";
import { isLocalWorkUrl, LOCAL_WORK_URL } from "../src/internal.js";

describe("isLocalWorkUrl", () => {
  it("accepts exactly the local work url", () => {
    expect(isLocalWorkUrl(LOCAL_WORK_URL)).toBe(true);
  });

  it("refuses any other url, near misses included", () => {
    for (const url of ["", LOCAL_WORK_URL + "/", LOCAL_WORK_URL + "/other", LOCAL_WORK_URL.toUpperCase(), LOCAL_WORK_URL.slice(0, -1), "https://example.org/spec.md"]) {
      expect(isLocalWorkUrl(url), url).toBe(false);
    }
  });
});
