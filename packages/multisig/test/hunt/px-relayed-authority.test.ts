import { fileURLToPath } from "node:url";
import { AccountRole, type Instruction } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { ENGINE_PROGRAM, LOADER, programDataOf } from "../../src/squads.js";
import { randomAddress } from "../svm.js";
import { bytesOf, craftVault, header, multisig, openSvm, proposalOf, s, signerOf } from "../multisig-world.js";

const relayPath = fileURLToPath(new URL("../../../../target/deploy/cpi_relay.so", import.meta.url));

beforeAll(openSvm);

describe("PX-4 an instruction that reaches the loader through another program", () => {
  it("PX-4 approves and executes a vault proposal that hands the engine's upgrade authority to a rogue member, with no problem or warning", async () => {
    const m = await multisig("relayed", 2);
    const rogue = signerOf(m, "a").address;
    const programData = await programDataOf(ENGINE_PROGRAM);
    s.set(programData, LOADER, header(3, [new Uint8Array(8), new Uint8Array([1]), bytesOf(m.vault), new Uint8Array(16)]));
    const relay = await randomAddress();
    s.svm.addProgramFromFile(relay, relayPath);
    s.svm.warpToSlot(10n);

    const relayed: Instruction = {
      programAddress: relay,
      accounts: [
        { address: LOADER, role: AccountRole.READONLY },
        { address: programData, role: AccountRole.WRITABLE },
        { address: m.vault, role: AccountRole.READONLY_SIGNER },
        { address: rogue, role: AccountRole.READONLY },
      ],
      data: Uint8Array.from([4, 0, 0, 0]),
    };
    const index = await craftVault(m, [relayed]);
    const shown = await proposalOf(m, index);

    const on = ["--multisig", m.address, "--index", index.toString()];
    const approvals = [];
    for (const name of ["b", "c"]) {
      const approved = await s.cli("approve", ...on, "--keypair", m.file(name), "--yes");
      approvals.push({ code: approved.code, refused: approved.json()["refused"] === true, warned: /Warning/.test(approved.err) });
    }
    const executed = await s.cli("execute", ...on, "--keypair", m.file("b"), "--yes");
    const after = s.account(programData);
    const authority = Buffer.from(after.exists ? after.data.subarray(13, 45) : new Uint8Array(32));

    expect({ executed: executed.code, authorityMovedToRogue: authority.equals(Buffer.from(bytesOf(rogue))) }).toEqual({ executed: executed.code, authorityMovedToRogue: false });
    expect(shown["problems"] ?? []).not.toEqual([]);
    expect(approvals.every((a) => a.refused || a.warned)).toBe(true);
  });
});
