import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { manifestSha256 } from "../src/internal.js";
import { InvalidInput } from "../src/errors.js";

const enc = (text: string) => new TextEncoder().encode(text);

function reference(entries: { path: string; bytes: Uint8Array }[]): string {
  const length = (n: number) => {
    const out = Buffer.alloc(8);
    out.writeBigUInt64LE(BigInt(n));
    return out;
  };
  const sorted = entries.map((e) => ({ name: Buffer.from(e.path, "utf8"), bytes: e.bytes })).sort((a, b) => Buffer.compare(a.name, b.name));
  const hash = createHash("sha256");
  for (const { name, bytes } of sorted) {
    hash.update(length(name.length)).update(name).update(length(bytes.length)).update(bytes);
  }
  return hash.digest("hex");
}

describe("manifestSha256", () => {
  it("matches fixed vectors", async () => {
    expect(await manifestSha256([])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await manifestSha256([{ path: "answer.txt", bytes: enc("42\n") }])).toBe("71c99a8f1a3a659a978ac07690130fd99ded9dfd91ed81573b94ff067d50ba08");
    expect(await manifestSha256([{ path: "b.txt", bytes: enc("2") }, { path: "a.txt", bytes: enc("1") }])).toBe(
      "45dbd9084d34aa084cbf1dbf00c7e12006911ccbf5b970fabf4e253da6529bd7",
    );
    expect(await manifestSha256([{ path: "src/main.rs", bytes: enc("fn main() {}\n") }, { path: "README.md", bytes: new Uint8Array() }])).toBe(
      "0ef59340dda71028274a8ddca5f9df2f7f05818ada08fca4f1c9c8c14f948e4e",
    );
  });

  it("length-prefixes paths and contents, so moving bytes between them changes the hash", async () => {
    const a = await manifestSha256([{ path: "ab", bytes: enc("c") }]);
    const b = await manifestSha256([{ path: "a", bytes: enc("bc") }]);
    const c = await manifestSha256([{ path: "a", bytes: enc("b") }, { path: "c", bytes: new Uint8Array() }]);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("sorts paths by their UTF-8 bytes", async () => {
    const entries = [{ path: "\u{1F600}", bytes: enc("1") }, { path: "�", bytes: enc("2") }];
    expect(await manifestSha256(entries)).toBe(reference(entries));
    expect(await manifestSha256([...entries].reverse())).toBe(reference(entries));
  });

  it("refuses an empty path or a path named twice", async () => {
    await expect(manifestSha256([{ path: "", bytes: enc("1") }])).rejects.toThrow(InvalidInput);
    await expect(manifestSha256([{ path: "a", bytes: enc("1") }, { path: "a", bytes: enc("2") }])).rejects.toThrow("names a more than once");
  });

  it("equals the reference construction for any set of distinct paths, in any order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.record({ path: fc.string({ minLength: 1, unit: "binary" }), bytes: fc.uint8Array({ maxLength: 64 }) }), { selector: (e) => e.path, maxLength: 8 }),
        async (entries) => {
          expect(await manifestSha256(entries)).toBe(reference(entries));
          expect(await manifestSha256([...entries].reverse())).toBe(reference(entries));
        },
      ),
    );
  });
});
