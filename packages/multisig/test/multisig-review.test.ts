import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountRole,
  type Address,
  address,
  createNoopSigner,
  type Instruction,
} from "@solana/kit";
import { buildRaisePause, PAUSE_FILL } from "@intent-engine/core/internal";
import { beforeAll, describe, expect, it } from "vitest";
import { readKeypair } from "../src/keys.js";
import { describeInstructions } from "../src/review.js";
import { EXIT_OK, EXIT_REFUSED, EXIT_USAGE, main } from "../src/main.js";
import { LOADER, programDataOf, upgradeInstruction } from "../src/squads.js";
import { randomAddress } from "./svm.js";
import {
  bufferHeldBy,
  multisig,
  openSvm,
  printed,
  proposalOf,
  s,
  sha256,
  upgradeable,
} from "./multisig-world.js";

beforeAll(openSvm);

describe("multisig", () => {
  it("reject records a rejection", async () => {
    const m = await multisig("reject", 2);
    s.printed = printed(m.vault, [await buildRaisePause({ authority: createNoopSigner(m.vault), flags: PAUSE_FILL })], []);
    expect((await s.cli("propose-admin", "--multisig", m.address, "--keypair", m.file("a"), "--yes", "--", "intent-engine", "raise-pause")).code).toBe(EXIT_OK);
    const on = ["--multisig", m.address, "--index", "1"];
    const preview = await s.cli("reject", ...on, "--keypair", m.file("b"));
    expect(preview.json()).toMatchObject({ sent: false, simulation: "ok", rejections: 1, cutoff: 2 });
    const first = await s.cli("reject", ...on, "--keypair", m.file("b"), "--yes");
    expect([first.code, first.err]).toEqual([EXIT_OK, ""]);
    expect(first.json()["summary"]).toEqual([
      `Rejects proposal 1 on multisig ${m.address} as ${m.members[1]?.address}`,
      "This is rejection 1 of 2",
      `Intent engine RaisePause {"flags":${PAUSE_FILL}}, signed by ${m.vault}`,
    ]);
    expect(await proposalOf(m, 1n)).toMatchObject({ status: "active", rejected: [m.members[1]?.address] });
    expect((await s.cli("reject", ...on, "--keypair", m.file("b"), "--yes")).json()["error"]).toBe(`${m.members[1]?.address} already rejected proposal 1`);
    const second = await s.cli("reject", ...on, "--keypair", m.file("c"), "--yes");
    expect(second.json()["summary"][1]).toBe("This is rejection 2 of 2; the proposal is then rejected and can never execute");
    const rejected = await proposalOf(m, 1n);
    expect(rejected["status"]).toBe("rejected");
    expect([...rejected["rejected"]].sort()).toEqual([m.members[1]?.address, m.members[2]?.address].sort());
    expect((await s.cli("approve", ...on, "--keypair", m.file("a"), "--yes")).json()["error"]).toBe("proposal 1 is rejected, so it takes no more approvals");
    expect((await s.cli("execute", ...on, "--keypair", m.file("a"), "--yes")).json()["error"]).toBe("proposal 1 is rejected, so it cannot execute");

    const locked = await multisig("cancel", 2, 3600);
    s.printed = printed(locked.vault, [await buildRaisePause({ authority: createNoopSigner(locked.vault), flags: PAUSE_FILL })], []);
    const lockedOn = ["--multisig", locked.address, "--index", "1", "--yes"];
    expect((await s.cli("propose-admin", "--multisig", locked.address, "--keypair", locked.file("a"), "--yes", "--", "intent-engine", "raise-pause")).code).toBe(EXIT_OK);
    for (const name of ["a", "b"]) {
      expect((await s.cli("approve", ...lockedOn, "--keypair", locked.file(name))).code).toBe(EXIT_OK);
    }
    for (const name of ["b", "c"]) {
      const cancelled = await s.cli("reject", ...lockedOn, "--keypair", locked.file(name));
      expect([cancelled.code, cancelled.err]).toEqual([EXIT_OK, ""]);
    }
    const revoked = await proposalOf(locked, 1n);
    expect(revoked["status"]).toBe("cancelled");
    expect([...revoked["cancelled"]].sort()).toEqual([locked.members[1]?.address, locked.members[2]?.address].sort());
    expect((await s.cli("reject", ...lockedOn, "--keypair", locked.file("a"))).json()["error"]).toBe("proposal 1 is cancelled, so there is nothing to reject");
  });

  it("every loader instruction is described exactly, with its signers checked", async () => {
    const vault = await randomAddress();
    const other = await randomAddress();
    const program = await upgradeable(vault);
    const programData = await programDataOf(program);
    const code = Uint8Array.from([5, 5, 5]);
    const buffer = await bufferHeldBy(vault, code);
    const spill = await randomAddress();
    const upgrade = await upgradeInstruction({ program, buffer, spill, authority: vault });
    const role = (signer: boolean) => (signer ? AccountRole.READONLY_SIGNER : AccountRole.READONLY);
    const loader = (tag: number, accounts: [Address, boolean][], extra: number[] = []): Instruction => ({
      programAddress: LOADER,
      accounts: accounts.map(([at, signer], i) => ({ address: at, role: i === 0 ? AccountRole.WRITABLE : role(signer) })),
      data: Uint8Array.from([tag, 0, 0, 0, ...extra]),
    });
    const { decoded, buffers } = await describeInstructions(s.chain, [
      { ...upgrade, accounts: (upgrade.accounts ?? []).map((a) => (a.address === vault ? { ...a, role: AccountRole.READONLY } : a)) },
      { ...upgrade, data: Uint8Array.from([3, 0, 0, 0, 9, 9]) },
      loader(4, [[programData, false], [vault, true]]),
      loader(4, [[buffer, false], [vault, true], [other, false]]),
      loader(4, [[programData, false], [vault, true], [other, false]]),
      loader(7, [[programData, false], [vault, true], [other, false]]),
      loader(7, [[buffer, false], [vault, true], [other, true]]),
      loader(4, [[buffer, false], [vault, false]]),
      loader(5, [[buffer, false], [spill, false], [vault, true]]),
    ]);
    const hashed = `the buffer hashes to ${sha256(code)} and is controlled by ${vault}`;
    expect(decoded.map((d) => d.summary)).toEqual([
      `Upgrades program ${program} to the code in buffer ${buffer}, naming ${vault} as authority without its signature, so the loader refuses it; the buffer's rent goes to ${spill}; ${hashed}`,
      `Upgrades program ${program} to the code in buffer ${buffer}, signed by ${vault}; the buffer's rent goes to ${spill}; the instruction carries 2 more bytes of data, which the loader ignores; ${hashed}`,
      `Makes the program whose data is ${programData} immutable: removes the upgrade authority ${vault} for good`,
      `Hands the authority of buffer ${buffer} from ${vault} to ${other}`,
      `Hands the upgrade authority of the program whose data is ${programData} from ${vault} to ${other}`,
      `Hands the upgrade authority of the program whose data is ${programData} from ${vault} to ${other}; both sign; ${other} does not sign, so the loader refuses it`,
      `Hands the authority of buffer ${buffer} from ${vault} to ${other}; both sign`,
      `Removes the authority of buffer ${buffer}, which the loader refuses for a buffer; ${vault} does not sign, so the loader refuses it`,
      `Closes buffer ${buffer}, controlled by ${vault}; its lamports go to ${spill}; authority ${vault}`,
    ]);
    expect(buffers).toEqual([
      { buffer, authority: vault, hash: sha256(code) },
      { buffer, authority: vault, hash: sha256(code) },
    ]);
  });

  it("keypair errors never echo file contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "multisig-keys-"));
    const cases: [string, string][] = [
      ["broken.json", "[201,202,203,hunter2secret"],
      ["short.json", JSON.stringify([201, 202, 203])],
      ["wide.json", JSON.stringify(Array.from({ length: 64 }, () => 777))],
      ["mismatched.json", JSON.stringify(Array.from({ length: 64 }, (_, i) => 200 + (i % 50)))],
    ];
    for (const [name, text] of cases) {
      const path = join(dir, name);
      writeFileSync(path, text);
      const error = await readKeypair(path).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toBe(`the keypair file ${path} is not a keypair: it holds no JSON array of 64 bytes that form a key pair`);
      const result = await main(["approve", "--multisig", await randomAddress(), "--index", "1", "--keypair", path], { ...s.deps, keypair: readKeypair });
      expect(result.code).toBe(EXIT_REFUSED);
      expect(JSON.parse(result.err)["error"]).toBe(message);
      for (const leaked of ["201", "202", "777", "hunter2", "secret"]) {
        expect(message.replaceAll(path, "")).not.toContain(leaked);
        expect(result.err.replaceAll(path, "")).not.toContain(leaked);
      }
    }
    const absent = join(dir, "absent.json");
    await expect(readKeypair(absent)).rejects.toThrow(`cannot read the keypair file ${absent}: it is missing or unreadable`);
  });

  it("rpc urls keep their query for requests and print only scheme, host and port", async () => {
    const m = await multisig("url", 2);
    s.printed = printed(m.vault, [await buildRaisePause({ authority: createNoopSigner(m.vault), flags: PAUSE_FILL })], []);
    const asked: string[] = [];
    const url = "https://rpc.example.com:8443/v2/path-token?api-key=querytoken";
    const result = await main(["propose-admin", "--multisig", m.address, "--keypair", m.file("a"), "--url", url, "--", "intent-engine", "raise-pause"], {
      ...s.deps,
      chain: (given) => {
        asked.push(given);
        return s.chain;
      },
    });
    expect(result.code).toBe(EXIT_OK);
    expect(asked).toEqual([url]);
    expect(JSON.parse(result.out)["cluster"]).toBe("https://rpc.example.com:8443");
    expect(result.out).not.toContain("querytoken");
    expect(result.out).not.toContain("path-token");
    const bad = await main(["show", "--multisig", m.address, "--url", "wss://rpc.example.com/?api-key=querytoken"], s.deps);
    expect([bad.code, bad.err.includes("querytoken")]).toEqual([EXIT_USAGE, false]);
  });
});
