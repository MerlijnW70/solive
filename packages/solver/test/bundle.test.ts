import type { Base64EncodedWireTransaction } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { badBundleSize, bundleSizeFits, MAX_BUNDLE, sendBundles } from "../src/index.js";

const wire = (name: string) => name as Base64EncodedWireTransaction;

const items = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `f${i}`, wire: wire(`f${i}`) }));

describe("bundles", () => {
  it("sends each bundle once, with only its last transaction replaced by the tipped one", async () => {
    const sent: string[][] = [];
    const lasts: string[] = [];
    const done = await sendBundles(
      items(7),
      5,
      async (wires) => {
        sent.push([...wires]);
        return `b${sent.length}`;
      },
      async (item) => {
        lasts.push(item.name);
        return wire(`${item.name}+tip`);
      },
    );
    expect(sent).toEqual([
      ["f0", "f1", "f2", "f3", "f4+tip"],
      ["f5", "f6+tip"],
    ]);
    expect(lasts).toEqual(["f4", "f6"]);
    expect(done.map((d) => [d.item.name, "signature" in d ? d.signature : null])).toEqual([
      ["f0", "b1"],
      ["f1", "b1"],
      ["f2", "b1"],
      ["f3", "b1"],
      ["f4", "b1"],
      ["f5", "b2"],
      ["f6", "b2"],
    ]);
  });

  it("drops a last fill whose tipped transaction is refused and tips the one before it", async () => {
    const sent: string[][] = [];
    const done = await sendBundles(
      items(3),
      5,
      async (wires) => {
        sent.push([...wires]);
        return "b";
      },
      async (item) => (item.name === "f2" ? { refused: "too costly" } : wire(`${item.name}+tip`)),
    );
    expect(sent).toEqual([["f0", "f1+tip"]]);
    expect(done).toContainEqual({ item: { name: "f2", wire: "f2" }, refused: { refused: "too costly" } });
    const none = await sendBundles(items(2), 5, async () => "never", async () => ({ refused: "no" }));
    expect(none.every((d) => "refused" in d)).toBe(true);
  });

  it("reports every fill of a refused bundle with the refusal and keeps sending the next bundle", async () => {
    let calls = 0;
    const done = await sendBundles(
      items(3),
      2,
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("jito rejected the bundle with status 429");
        }
        return "b2";
      },
      async (item) => item.wire,
    );
    expect(done).toEqual([
      { item: { name: "f0", wire: "f0" }, error: "jito rejected the bundle with status 429" },
      { item: { name: "f1", wire: "f1" }, error: "jito rejected the bundle with status 429" },
      { item: { name: "f2", wire: "f2" }, signature: "b2" },
    ]);
  });

  it("takes bundle sizes from 1 to the most a bundle holds", async () => {
    expect([1, MAX_BUNDLE].map(bundleSizeFits)).toEqual([true, true]);
    for (const bad of [0, MAX_BUNDLE + 1, 1.5, Number.NaN]) {
      expect(bundleSizeFits(bad)).toBe(false);
      await expect(sendBundles(items(1), bad, async () => "b", async (item) => item.wire)).rejects.toThrow(badBundleSize(bad));
    }
    expect(badBundleSize(0)).toBe("bundle size must be an integer from 1 to 5, not 0");
  });
});
