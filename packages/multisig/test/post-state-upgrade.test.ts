import { AccountRole, type Address, type Instruction } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import type { Chain } from "../src/chain.js";
import { EXIT_OK, EXIT_REFUSED, main } from "../src/main.js";
import { rewrittenText } from "../src/proposal-effects.js";
import { ENGINE_PROGRAM, LOADER, programDataOf, upgradeInstruction } from "../src/squads.js";
import { bytesOf, craftVault, header, multisig, openSvm, proposalOf, s, sha256, type Made } from "./multisig-world.js";
import { concat, u32, u64 } from "./program-metadata-world.js";
import { engineProgram, randomAddress, squadsProgram } from "./svm.js";

beforeAll(async () => {
  await openSvm();
  s.svm.warpToSlot(10n);
});

const NEXT = squadsProgram();

function patchedText(code: Uint8Array): { at: number; patched: Uint8Array } {
  const letter = (b: number | undefined) => b !== undefined && b >= 0x61 && b <= 0x7a;
  for (let at = 0; at + 16 < code.length; at += 1) {
    if (Array.from(code.subarray(at, at + 16)).every(letter)) {
      const patched = Uint8Array.from(code);
      patched[at + 8] = code[at + 8] === 0x78 ? 0x79 : 0x78;
      return { at: at + 8, patched };
    }
  }
  throw new Error("no text to patch");
}

async function upgradeWorld(tag: string): Promise<{ m: Made; programData: Address; buffer: Address; spill: Address }> {
  const m = await multisig(tag, 2);
  const current = engineProgram();
  const programData = await programDataOf(ENGINE_PROGRAM);
  const held = new Uint8Array(Math.max(current.length, NEXT.length));
  held.set(current);
  s.set(programData, LOADER, header(3, [new Uint8Array(8), new Uint8Array([1]), bytesOf(m.vault), held]));
  s.set(ENGINE_PROGRAM, LOADER, header(2, [bytesOf(programData)]), true);
  const buffer = await randomAddress();
  s.set(buffer, LOADER, header(1, [new Uint8Array([1]), bytesOf(m.vault), NEXT]));
  return { m, programData, buffer, spill: await randomAddress() };
}

const codeAt = (programData: Address) => {
  const held = s.account(programData);
  return held.exists ? sha256(held.data.subarray(45)) : "closed";
};

describe("the loader upgrade path's simulated program hash", () => {
  it("the deploy.sh --multisig upgrade shows the program hash it sets in approve and execute, with no new flag", async () => {
    const { m, programData, buffer, spill } = await upgradeWorld("up-honest");
    const proposed = await s.cli("propose-upgrade", "--multisig", m.address, "--buffer", buffer, "--spill", spill, "--keypair", m.file("a"), "--yes");
    expect([proposed.code, proposed.err]).toEqual([EXIT_OK, ""]);
    const sets = { simulation: "ok", sets: [{ account: programData, sets: "code", hash: sha256(NEXT) }] };
    for (const name of ["a", "b"]) {
      const approved = await s.cli("approve", "--multisig", m.address, "--index", "1", "--keypair", m.file(name), "--yes");
      expect([approved.code, approved.err, approved.json()["buffer_hash"], approved.json()["post_state"]]).toEqual([EXIT_OK, "", sha256(NEXT), sets]);
      expect(approved.json()["summary"].at(-1)).toBe(`Simulated, the proposal sets the program data ${programData} to code with sha256 ${sha256(NEXT)}`);
    }
    const run = ["execute", "--multisig", m.address, "--index", "1", "--expect-buffer-hash", sha256(NEXT), "--keypair", m.file("c")];
    const preview = await s.cli(...run);
    expect(preview.json()).toMatchObject({ sent: false, simulation: "ok", buffer_hash: sha256(NEXT), post_state: sets });
    const executed = await s.cli(...run, "--yes");
    expect([executed.code, executed.err, executed.json()["post_state"]]).toEqual([EXIT_OK, "", sets]);
    expect(codeAt(programData)).toBe(sha256(NEXT));
  });

  it("execute refuses when the transaction it would send sets a program hash other than the expected one, and sends nothing", async () => {
    const { m, programData, buffer, spill } = await upgradeWorld("up-swap");
    const proposed = await s.cli("propose-upgrade", "--multisig", m.address, "--buffer", buffer, "--spill", spill, "--keypair", m.file("a"), "--yes");
    expect(proposed.code).toBe(EXIT_OK);
    for (const name of ["a", "b"]) {
      expect((await s.cli("approve", "--multisig", m.address, "--index", "1", "--keypair", m.file(name), "--yes")).code).toBe(EXIT_OK);
    }
    const swapped = engineProgram();
    const sends: string[] = [];
    const racing: Chain = {
      ...s.chain,
      simulate: async (tx, accounts) => {
        s.set(buffer, LOADER, header(1, [new Uint8Array([1]), bytesOf(m.vault), swapped]));
        return s.chain.simulate(tx, accounts);
      },
      send: async (tx) => {
        sends.push("sent");
        return s.chain.send(tx);
      },
    };
    const raced = await main(["execute", "--multisig", m.address, "--index", "1", "--expect-buffer-hash", sha256(NEXT), "--keypair", m.file("c"), "--yes"], { ...s.deps, chain: () => racing });
    expect([raced.code, JSON.parse(raced.err)["error"], sends]).toEqual([
      EXIT_REFUSED,
      `simulated, the execute transaction sets the program data ${programData} to code with sha256 ${sha256(swapped)}, not the approved ${sha256(NEXT)}; do not execute it`,
      [],
    ]);
    expect(codeAt(programData)).toBe(sha256(swapped));
    expect((await proposalOf(m, 1n))["status"]).toBe("approved");
  });

  it("a loader Write into the buffer before the upgrade is refused, and execute refuses the transaction the runtime would fail", async () => {
    const { m, programData, buffer, spill } = await upgradeWorld("up-write");
    const { at, patched } = patchedText(NEXT);
    const write: Instruction = {
      programAddress: LOADER,
      accounts: [
        { address: buffer, role: AccountRole.WRITABLE },
        { address: m.vault, role: AccountRole.READONLY_SIGNER },
      ],
      data: concat([1, 0, 0, 0], u32(at), u64(1n), patched.subarray(at, at + 1)),
    };
    const index = await craftVault(m, [write, await upgradeInstruction({ program: ENGINE_PROGRAM, buffer, spill, authority: m.vault })]);
    const on = ["--multisig", m.address, "--index", index.toString()];
    const problem = rewrittenText(2, buffer, [1], "code");
    const shown = await proposalOf(m, index);
    expect([shown["problems"], shown["buffers"]]).toEqual([[problem], [{ buffer, authority: m.vault, hash: null, writtenBy: [1] }]]);
    const refused = await s.cli("approve", ...on, "--keypair", m.file("a"), "--yes");
    expect([refused.code, refused.json()["error"]]).toEqual([EXIT_REFUSED, expect.stringContaining(`refusing to sign proposal ${index}: ${problem}`)]);
    for (const name of ["a", "b"]) {
      const approved = await s.cli("approve", ...on, "--allow-rewritten-buffer", "--keypair", m.file(name), "--yes");
      expect([approved.code, approved.json()["buffer_hash"]]).toEqual([EXIT_OK, sha256(patched)]);
    }
    const failed = await s.cli("execute", ...on, "--expect-buffer-hash", sha256(patched), "--allow-rewritten-buffer", "--keypair", m.file("c"), "--yes");
    expect([failed.code, failed.json()["error"]]).toEqual([EXIT_REFUSED, expect.stringMatching(/^simulating the execute transaction fails with .*; nothing was sent$/)]);
    expect(failed.json()["logs"]).toContain(`Program SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf failed: Program ${LOADER} not supported by inner instructions`);
    expect(codeAt(programData)).toBe(sha256(engineProgram()));
  });
});
