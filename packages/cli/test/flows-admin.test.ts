import { getBase58Encoder, getBase64Encoder, type KeyPairSigner, lamports } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { findConfigPda, getConfigDecoder, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { loadConfig } from "@intent-engine/client/internal";
import { createCost, rentRate } from "../src/agent/budget.js";
import { AUTHORITY_NEXT } from "../src/commands.js";
import { NOT_SENT } from "../src/flows.js";
import { TREASURY_IS_PROGRAM, treasuryTooEmpty } from "../src/treasury.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { balance, cli, enginePath, funded, h, transport, type World } from "./harness.js";
import { allowance, ataOf, ESCROW, exists, flowCreate, flowWorld, type Json, signAndSend } from "./flows-kit.js";

describe("command line flows", () => {
  let w: World;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    ({ w, keys } = await flowWorld());
  });

  const create = (kind: string, ...rest: string[]) => flowCreate(w, kind, ...rest);

  it("signs an intent offline into a file and relays it from that file", async () => {
    const relayer = await funded();
    keys["relayer.json"] = relayer;
    const prepare = [
      "signed",
      "prepare",
      "swap",
      "--keypair",
      "owner.json",
      "--out",
      "s.json",
      "--input-mint",
      w.inputMint,
      "--output-mint",
      w.outputMint,
      "--expires-in",
      "3600",
      "--amount-in",
      ESCROW.toString(),
      "--min-out",
      "300",
      "--relayer-fee",
      "5",
      "--units",
      "raw",
    ];
    const preview = (await cli(prepare, keys)).json() as Json;
    expect(preview).toMatchObject({ sent: false, next: NOT_SENT });
    expect(preview["submit"]).toMatchObject({ relayer_fee: "5" });
    expect(h.files.size).toBe(0);
    const prepared = (await cli([...prepare, "--yes"], keys)).json() as Json;
    expect(prepared).toMatchObject({ sent: true, saved: "s.json" });
    expect(allowance(w.ownerInput)).toBe(ESCROW + 5n);
    const saved = JSON.parse(h.files.get("s.json") ?? "") as Json;
    expect(saved["version"]).toBe(1);
    expect(saved["submit"]).toEqual(prepared["submit"]);
    expect(getBase58Encoder().encode(saved["signature"])).toHaveLength(64);
    expect((await cli([...prepare, "--yes"], keys)).err).toBe("s.json already exists; choose another --out");
    expect(allowance(w.ownerInput)).toBe(ESCROW + 5n);
    const submit = ["signed", "submit", "--keypair", "relayer.json", "--file", "s.json"];
    const checked = (await cli(submit, keys)).json() as Json;
    expect(checked).toMatchObject({ intent: prepared["intent"], exists: 0, relayer_fee: "5", sent: false, next: NOT_SENT });
    const relayCost = createCost((await loadConfig(transport)).config, await rentRate(transport));
    expect(checked["summary"].at(-1)).toContain(`Relaying costs you ${relayCost} lamports in create fee`);
    expect(checked["summary"].at(-1)).toMatch(/^Relaying costs you \d+ lamports in create fee, crank bounty, rent and signature fee, plus any priority fee; you receive /);
    expect(exists(prepared["intent"])).toBe(false);
    const relayed = (await cli([...submit, "--yes"], keys)).json() as Json;
    expect(relayed["sent"]).toBe(true);
    expect(relayed["intent"]).toBe(prepared["intent"]);
    expect(typeof relayed["signature"]).toBe("string");
    expect(balance(w.ownerInput)).toBe(1_000n - ESCROW - 5n);
    expect(balance(await ataOf(relayer.address, w.inputMint))).toBe(5n);
    expect((await cli([...submit, "--yes"], keys)).json()).toEqual({ intent: prepared["intent"], signature: null, sent: true });
    expect((await cli(submit, keys)).json()).toMatchObject({ exists: 1, sent: false });
    const forged = { ...saved, submit: { ...(saved["submit"] as Json), relayer_fee: "6" } };
    h.files.set("forged.json", JSON.stringify(forged));
    expect((await cli(["signed", "submit", "--keypair", "relayer.json", "--file", "forged.json"], keys)).err).toBe(
      "SignatureInvalid: the signature is not the owner's signature of these exact terms",
    );
    for (const [file, text] of [
      ["junk.json", "not json"],
      ["old.json", JSON.stringify({ ...saved, version: 2 })],
      ["bare.json", JSON.stringify({ version: 1, signature: "x" })],
      ["unsigned.json", JSON.stringify({ version: 1, submit: saved["submit"] })],
    ] as const) {
      h.files.set(file, text);
      expect((await cli(["signed", "submit", "--keypair", "relayer.json", "--file", file], keys)).err).toBe(
        `${file} is not a signed intent file`,
      );
    }
    expect((await cli(["signed", "submit", "--keypair", "relayer.json", "--file", "missing.json"], keys)).err).toBe(
      "missing.json is not a signed intent file",
    );
  });

  it("prints admin transactions unsigned for a multisig and sends them with a keypair", async () => {
    const unsigned = (await cli(["raise-pause", "--authority", w.authority.address, "--flags", "fill"], {})).json() as Json;
    const tx = unsigned["unsigned"];
    expect(tx["signers"]).toEqual([w.authority.address]);
    expect(tx["fee_payer"]).toBe(w.authority.address);
    expect(tx["next"]).toBe(AUTHORITY_NEXT);
    expect(tx["instructions"]).toHaveLength(1);
    expect(tx["instructions"][0]).toMatchObject({ program: INTENT_ENGINE_PROGRAM_ADDRESS });
    expect(tx["instructions"][0]["accounts"][0]).toEqual({ address: w.authority.address, signer: true, writable: false });
    expect(Array.from(getBase58Encoder().encode(tx["transaction_base58"]))).toEqual(
      Array.from(getBase64Encoder().encode(tx["transaction"])),
    );
    const [config] = await findConfigPda();
    const read = () => {
      const view = h.svm.getAccount(config);
      if (!view.exists) {
        throw new Error("config missing");
      }
      return getConfigDecoder().decode(view.data);
    };
    expect(unsigned["summary"]).toEqual(["Pauses filling for every intent until the admin lowers the pause"]);
    expect(read().paused).toBe(0);
    const held = (await cli(["raise-pause", "--keypair", "admin.json", "--flags", "all"], keys)).json() as Json;
    expect(held).toMatchObject({
      sent: false,
      summary: ["Pauses creating and filling for every intent until the admin lowers the pause"],
      next: "nothing was sent; check the summary and pass --yes to sign and send",
    });
    expect(read().paused).toBe(0);
    await signAndSend(tx["transaction"], w.authority);
    expect(read().paused).toBe(2);
    expect((await cli(["lower-pause", "--keypair", "admin.json", "--yes", "--flags", "fill"], keys)).code).toBe(EXIT_OK);
    expect(read().paused).toBe(0);
    expect((await cli(["lower-pause", "--keypair", "admin.json", "--flags", "create"], keys)).json()).toMatchObject({ summary: ["Resumes creating"] });
    const change = ["update-config", "--keypair", "admin.json", "--fee-bps", "9", "--fill-disabled", "dutch"];
    expect(((await cli(change, keys)).json() as Json)["summary"]).toEqual([
      "Fee: 5 -> 9 bps",
      "Fills stopped for: none -> dutch",
    ]);
    expect(read().feeBps).toBe(5);
    const same = ["update-config", "--keypair", "admin.json", "--fee-bps", "5"];
    expect(((await cli(same, keys)).json() as Json)["summary"]).toEqual(["Changes nothing: every setting already has the value given"]);
    const updated = (await cli(["update-config", "--keypair", "admin.json", "--yes", "--fee-bps", "9", "--fill-disabled", "dutch"], keys)).json();
    expect(updated).toMatchObject({ update: { feeBps: 9, fillDisabledKinds: "8", guardian: w.authority.address } });
    expect(read()).toMatchObject({ feeBps: 9, fillDisabledKinds: 8n, feeRecipient: w.feeRecipient.address });
    const next = await funded();
    keys["next.json"] = next;
    expect(((await cli(["propose-admin", "--keypair", "admin.json", "--new-admin", next.address], keys)).json() as Json)["summary"]).toEqual([
      `Proposes ${next.address} as the next admin in place of ${w.authority.address}`,
      "Nothing changes until that key accepts; a later proposal replaces this one",
    ]);
    expect((await cli(["propose-admin", "--keypair", "admin.json", "--yes", "--new-admin", next.address], keys)).code).toBe(EXIT_OK);
    const accept = (await cli(["accept-admin", "--authority", next.address], {})).json() as Json;
    expect(accept["unsigned"]["signers"]).toEqual([next.address]);
    expect(accept["summary"]).toEqual([`Makes ${next.address} the admin in place of ${w.authority.address}`]);
    expect(((await cli(["accept-admin", "--keypair", "next.json"], keys)).json() as Json)["sent"]).toBe(false);
    expect(read().admin).toBe(w.authority.address);
    expect((await cli(["accept-admin", "--keypair", "next.json", "--yes"], keys)).code).toBe(EXIT_OK);
    expect(read().admin).toBe(next.address);
    const priced = ["set-economics", "--keypair", "next.json", "--bounty", "70", "--create-fee", "30", "--kind-fees", "swap=3,dutch=0", "--partner-cut", "2000"];
    expect(((await cli(priced, keys)).json() as Json)["summary"]).toEqual([
      "Crank bounty: 0 -> 70 lamports per intent",
      "Create fee: 0 -> 30 lamports per intent",
      "Partner cut: 0 -> 2000 bps of each partner fee",
      "Kind fees: swap 3 bps, dutch 0 bps",
    ]);
    expect(((await cli(["set-economics", "--keypair", "next.json", "--bounty", "0", "--create-fee", "0"], keys)).json() as Json)["summary"]).toContain(
      "Kind fees: none; every kind pays the base fee",
    );
    const refused = await cli(["set-economics", "--authority", w.authority.address, "--bounty", "1", "--create-fee", "0"], {});
    expect(refused.code).toBe(EXIT_FAILED);
  });

  it("admin previews name the cluster", async () => {
    const url = ["--url", "https://user:secret@rpc.example.org:8443/v1?api-key=hidden"];
    const cluster = { url: "https://rpc.example.org:8443", genesisHash: h.genesis };
    const next = await funded();
    const previews = [
      ["raise-pause", "--flags", "fill"],
      ["lower-pause", "--flags", "fill"],
      ["update-config", "--fee-bps", "9"],
      ["set-economics", "--bounty", "1", "--create-fee", "0"],
      ["propose-admin", "--new-admin", next.address],
    ];
    for (const args of previews) {
      const held = await cli([...args, ...url, "--keypair", "admin.json"], keys);
      expect([args[0], held.code, held.json()["cluster"], held.out.includes("hidden") || held.out.includes("secret")]).toEqual([args[0], EXIT_OK, cluster, false]);
      const unsigned = await cli([...args, ...url, "--authority", w.authority.address], {});
      expect([args[0], unsigned.json()["cluster"]]).toEqual([args[0], cluster]);
    }
    expect((await cli(["propose-admin", ...url, "--keypair", "admin.json", "--yes", "--new-admin", next.address], keys)).json()).toMatchObject({ sent: true, cluster });
    expect((await cli(["accept-admin", ...url, "--authority", next.address], {})).json()["cluster"]).toEqual(cluster);
    const sent = (await cli(["raise-pause", ...url, "--keypair", "admin.json", "--yes", "--flags", "fill"], keys)).json();
    expect(sent).toMatchObject({ sent: true, cluster });
  });

  it("warns when the treasury cannot take create fees, while creates still go through", async () => {
    const fee = w.feeRecipient.address;
    const warnings = async () => ((await cli(["treasury", "--mints", w.inputMint], {})).json() as Json)["warnings"];
    expect(await warnings()).toEqual([]);
    expect((await cli(["set-economics", "--keypair", "admin.json", "--yes", "--bounty", "0", "--create-fee", "30"], keys)).code).toBe(EXIT_OK);
    expect(await warnings()).toEqual([]);
    const held = h.svm.getAccount(fee);
    if (!held.exists) {
      throw new Error("treasury missing");
    }
    h.svm.setAccount({ ...held, lamports: lamports(0n) });
    const minimum = h.svm.minimumBalanceForRentExemption(0n);
    expect(await warnings()).toEqual([treasuryTooEmpty(30, minimum - 30n)]);
    const made = await cli([...create("swap", "--amount-in", "400", "--min-out", "300"), "--yes"], keys);
    expect(made.code).toBe(EXIT_OK);
    expect(h.svm.getBalance(fee) ?? 0n).toBe(0n);
    h.svm.setAccount({ ...held, lamports: lamports(minimum - 30n) });
    expect(await warnings()).toEqual([]);
    h.svm.setAccount({ ...held, lamports: lamports(minimum - 31n) });
    expect(await warnings()).toEqual([treasuryTooEmpty(30, 1n)]);
    h.svm.addProgramFromFile(fee, enginePath);
    expect(await warnings()).toEqual([TREASURY_IS_PROGRAM]);
    expect((await cli(["set-economics", "--keypair", "admin.json", "--yes", "--bounty", "0", "--create-fee", "0"], keys)).code).toBe(EXIT_OK);
    expect(await warnings()).toEqual([TREASURY_IS_PROGRAM]);
    const free = await cli([...create("swap", "--amount-in", "400", "--min-out", "300", "--nonce", "1"), "--yes"], keys);
    expect(free.code).toBe(EXIT_OK);
  });
});
