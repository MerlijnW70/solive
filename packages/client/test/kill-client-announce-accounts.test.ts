import type { Address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { NotAnEngineAccount } from "@intent-engine/core";
import {
  findConfigPda,
  findMintCapAddress,
  getConfigDiscriminatorBytes,
  getMintCapSize,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  MINT_CAP_DISCRIMINATOR,
} from "@intent-engine/core/internal";
import { engineAccount, EXTENSIONS_OFFSET, loadMintCap, MissingAccount, scalesDisplay } from "../src/accounts.js";
import { refusalText, urlTooLong } from "../src/announce-errors.js";
import type { AccountView, Transport } from "../src/transport.js";
import { world } from "./svm.js";

const holding = (view: AccountView | null) => ({ getAccount: async () => view }) as unknown as Transport;

function extensions(parts: readonly [number, number, number[]][]): Uint8Array {
  const bytes: number[] = [];
  for (const [type, length, payload] of parts) {
    bytes.push(type & 255, type >> 8, length & 255, length >> 8, ...payload);
  }
  const data = new Uint8Array(EXTENSIONS_OFFSET + bytes.length);
  data.set(bytes, EXTENSIONS_OFFSET);
  return data;
}

describe("engine accounts", () => {
  it("accepts an account only when the program owns it and its discriminator matches", async () => {
    const w = await world();
    const [address] = await findConfigPda();
    const real = await w.chain.transport.getAccount(address);
    if (real === null) {
      throw new Error("no config");
    }
    const discriminator = getConfigDiscriminatorBytes();
    const wrong = new Uint8Array(discriminator.length).fill(1);
    expect(real.owner).toBe(INTENT_ENGINE_PROGRAM_ADDRESS);
    expect((await engineAccount(holding(real), address, discriminator, "config")).length).toBe(real.data.length);
    await expect(engineAccount(holding({ ...real, owner: TOKEN_PROGRAM_ADDRESS }), address, discriminator, "config")).rejects.toThrow(`${address} is not an engine config`);
    await expect(engineAccount(holding({ ...real, owner: TOKEN_PROGRAM_ADDRESS }), address, discriminator, "config")).rejects.toBeInstanceOf(NotAnEngineAccount);
    await expect(engineAccount(holding(real), address, wrong, "config")).rejects.toThrow(`${address} is not an engine config`);
    await expect(engineAccount(holding({ ...real, owner: TOKEN_PROGRAM_ADDRESS }), address, wrong, "config")).rejects.toBeInstanceOf(NotAnEngineAccount);
    await expect(engineAccount(holding(null), address, discriminator, "config")).rejects.toBeInstanceOf(MissingAccount);
  });

  it("accepts a mint cap only when the program owns it and its data is a mint cap", async () => {
    const mint = "So11111111111111111111111111111111111111112" as Address;
    const address = await findMintCapAddress(mint);
    const valid = new Uint8Array(getMintCapSize());
    valid.set(MINT_CAP_DISCRIMINATOR);
    const junk = new Uint8Array(getMintCapSize()).fill(3);
    const message = `${address} is not an engine mint cap`;
    expect(await loadMintCap(holding(null), mint)).toBeNull();
    await expect(loadMintCap(holding({ owner: TOKEN_PROGRAM_ADDRESS, data: valid, lamports: 1n }), mint)).rejects.toThrow(message);
    await expect(loadMintCap(holding({ owner: INTENT_ENGINE_PROGRAM_ADDRESS, data: junk, lamports: 1n }), mint)).rejects.toThrow(message);
    await expect(loadMintCap(holding({ owner: INTENT_ENGINE_PROGRAM_ADDRESS, data: valid.subarray(0, valid.length - 1), lamports: 1n }), mint)).rejects.toThrow(message);
    await expect(loadMintCap(holding({ owner: TOKEN_PROGRAM_ADDRESS, data: junk, lamports: 1n }), mint)).rejects.toThrow(message);
  });
});

describe("scaling extensions", () => {
  it("finds a scaling extension in the last four bytes of the data", () => {
    expect(scalesDisplay(extensions([[10, 0, []]]))).toBe(true);
    expect(scalesDisplay(extensions([[25, 0, []]]))).toBe(true);
    expect(scalesDisplay(extensions([[11, 0, []]]))).toBe(false);
    expect(scalesDisplay(extensions([[1, 0, []]]))).toBe(false);
  });

  it("walks past an extension by its little-endian length and stops at the end without reading past it", () => {
    expect(scalesDisplay(extensions([[1, 1, [0x55]], [10, 0, []]]))).toBe(true);
    expect(scalesDisplay(extensions([[1, 2, [0x55, 0x66]], [25, 0, []]]))).toBe(true);
    expect(scalesDisplay(extensions([[1, 1, [0x55]], [11, 0, []]]))).toBe(false);
    expect(scalesDisplay(new Uint8Array(EXTENSIONS_OFFSET))).toBe(false);
    expect(scalesDisplay(new Uint8Array(EXTENSIONS_OFFSET + 2))).toBe(false);
    expect(scalesDisplay(new Uint8Array(EXTENSIONS_OFFSET + 3))).toBe(false);
    expect(scalesDisplay(new Uint8Array(EXTENSIONS_OFFSET - 1))).toBe(false);
  });
});

describe("announcement error texts", () => {
  it("counts the recipients in the singular for one and the plural otherwise", () => {
    expect(urlTooLong(100, 50, 1)).toBe(
      "the work url has 100 bytes, but sealed to 1 recipient in this announcement it may have at most 50, so that the transaction stays within one packet; nothing was sent",
    );
    expect(urlTooLong(100, 50, 2)).toContain("sealed to 2 recipients in this");
    expect(urlTooLong(100, 50, 0)).toContain("sealed to 0 recipients in this");
  });

  it("tells a closed book, a named gap and a repeated seq apart", () => {
    expect(refusalText("ab", { reason: "incomplete", closed: true, missing: [2n] })).toBe("is no longer open, so its announcements may have been closed and the first worker who announced the work ab cannot be known; nothing was sent");
    expect(refusalText("ab", { reason: "incomplete", missing: [2n, 5n] })).toBe("lists its announcements with seq 2, 5 missing, so the first worker who announced the work ab cannot be known; nothing was sent");
    expect(refusalText(null, { reason: "incomplete", missing: [] })).toBe("lists a seq twice or past its delivery book's next seq, so the earliest delivery cannot be known; nothing was sent");
    expect(refusalText(null, { reason: "incomplete" })).toBe("lists a seq twice or past its delivery book's next seq, so the earliest delivery cannot be known; nothing was sent");
    expect(refusalText(null, { reason: "incomplete", missing: [1n] })).toContain("seq 1 missing");
  });
});
