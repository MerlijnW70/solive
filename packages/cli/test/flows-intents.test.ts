import {
  type Address,
  generateKeyPairSigner,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type KeyPairSigner,
} from "@solana/kit";
import { getApproveInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import { findAssociatedTokenAddress } from "@intent-engine/core";
import { findMandatePda, MANDATE_NONCE_BIT } from "@intent-engine/core/internal";
import { COMPUTE_BUDGET_ADDRESS } from "@intent-engine/solver";
import { noJudgeKey } from "@intent-engine/client/internal";
import { NOT_SENT } from "../src/flows.js";
import { NOTHING_TO_CREATE } from "../src/treasury.js";
import { TREASURY_CREATE_NEEDS_MINTS } from "../src/args.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { ata, balance, cli, funded, h, NOW, send, type World } from "./harness.js";
import { allowance, ataOf, ESCROW, exists, flowCreate, flowWorld, type Json } from "./flows-kit.js";

describe("command line flows", () => {
  let w: World;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    ({ w, keys } = await flowWorld());
  });

  const create = (kind: string, ...rest: string[]) => flowCreate(w, kind, ...rest);

  it("previews an intent without sending and creates it, in token units and with a priority fee, only with --yes", async () => {
    const swap = create("swap", "--units", "tokens", "--amount-in", "0.0004", "--min-out", "0.0003");
    const preview = await cli(swap, keys);
    expect(preview.code).toBe(EXIT_OK);
    const shown = preview.json() as Json;
    expect(shown).toMatchObject({ nonce: "0", escrow: ESCROW.toString(), sent: false, next: NOT_SENT });
    expect(shown).not.toHaveProperty("prepared");
    expect(shown["summary"]).toContain(`Sell: exactly 0.0004 of ${w.inputMint}`);
    expect(balance(w.ownerInput)).toBe(1_000n);
    expect(exists(shown["intent"])).toBe(false);
    h.wires.length = 0;
    const made = (await cli([...swap, "--priority-fee", "7", "--yes"], keys)).json() as Json;
    expect(made).toMatchObject({ intent: shown["intent"], sent: true });
    expect(made["signatures"]).toHaveLength(1);
    expect(balance(w.ownerInput)).toBe(1_000n - ESCROW);
    const message = getCompiledTransactionMessageDecoder().decode(
      getTransactionDecoder().decode(getBase64Encoder().encode(h.wires.at(-1) ?? "")).messageBytes,
    );
    const compiled = (message as unknown as { instructions: { programAddressIndex: number; data?: Uint8Array }[] }).instructions;
    const programs = compiled.map((ix) => message.staticAccounts[ix.programAddressIndex]);
    expect(programs.slice(-2)).toEqual([COMPUTE_BUDGET_ADDRESS, COMPUTE_BUDGET_ADDRESS]);
    expect(Array.from(compiled.at(-1)?.data ?? [])).toEqual([3, 7, 0, 0, 0, 0, 0, 0, 0]);
    expect((await cli(create("swap", "--units", "tokens", "--amount-in", "0.0000001", "--min-out", "1"), keys)).err).toBe(
      "0.0000001 has more than the token's 6 decimal places",
    );
  });

  it("shows the treasury's SOL and token accounts and creates missing ones only with --yes", async () => {
    const treasury = ["treasury", "--mints", `${w.inputMint},${w.outputMint}`];
    const fee = w.feeRecipient.address;
    const accountOf = (mint: Address) => findAssociatedTokenAddress({ owner: fee, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [inputAccount, outputAccount] = [await accountOf(w.inputMint), await accountOf(w.outputMint)];
    const first = (await cli(treasury, {})).json() as Json;
    expect(first).toMatchObject({ fee_recipient: fee, lamports: String(h.svm.getBalance(fee) ?? 0n) });
    expect(first["tokens"].map((t: Json) => [t["mint"], t["account"], t["decimals"]])).toEqual([
      [w.inputMint, inputAccount, 6],
      [w.outputMint, outputAccount, 6],
    ]);
    const absent = [inputAccount, outputAccount].filter((a) => !exists(a)).length;
    expect(first["missing"]).toHaveLength(absent);
    expect(exists(outputAccount)).toBe(false);
    const preview = (await cli([...treasury, "--create", "--keypair", "owner.json"], keys)).json() as Json;
    expect(preview).toMatchObject({ sent: false, next: NOT_SENT });
    expect(preview["summary"]).toContain(
      `Creates the treasury's account ${outputAccount} for ${w.outputMint}, so fills can pay protocol fees in it (${w.owner.address} pays its rent)`,
    );
    expect(exists(outputAccount)).toBe(false);
    const made = (await cli([...treasury, "--create", "--keypair", "owner.json", "--yes"], keys)).json() as Json;
    expect(made).toMatchObject({ sent: true });
    expect([exists(inputAccount), exists(outputAccount)]).toEqual([true, true]);
    expect((await cli([...treasury, "--create", "--keypair", "owner.json", "--yes"], keys)).json()).toMatchObject({
      sent: false,
      next: NOTHING_TO_CREATE,
      missing: [],
    });
    await ata(w.authority, fee, w.outputMint, 2_500_000n);
    const funded = (await cli(treasury, {})).json() as Json;
    expect(funded["tokens"][1]).toMatchObject({ exists: true, balance: "2500000", balance_tokens: "2.5" });
    h.watched.length = 0;
    expect(((await cli(["treasury"], {})).json() as Json)["tokens"]).toEqual([]);
    await cli([...create("swap", "--amount-in", "400", "--min-out", "300"), "--yes"], keys);
    h.watched.push(w.owner.address);
    const found = (await cli(["treasury"], {})).json() as Json;
    expect(found["tokens"].map((t: Json) => t["mint"])).toEqual([w.inputMint]);
    expect((await cli(["treasury", "--yes"], {})).err).toBe("--yes only applies with --create");
    expect((await cli(["treasury", "--create"], {})).err).toBe(TREASURY_CREATE_NEEDS_MINTS);
    expect(TREASURY_CREATE_NEEDS_MINTS).toBe(
      "--create needs --mints naming the tokens to open treasury accounts for; anyone can open intents in any token, so the list must be yours",
    );
    expect((await cli(["treasury", "--create", "--mints", w.inputMint], {})).err).toBe("missing --keypair");
    expect((await cli(["treasury", "--mints", "nope"], {})).err).toBe("--mints is not a base58 address");
    expect((await cli(["treasury", "--mints", `${w.inputMint},,${w.outputMint}`], {})).err).toBe(
      "--mints takes a comma list of addresses",
    );
  });

  it("creates every kind and lists the owner's intents", async () => {
    expect((await cli([...create("limit", "--make", "100", "--take", "90"), "--yes"], keys)).code).toBe(EXIT_OK);
    const dutch = [
      "--amount-in",
      "100",
      "--start-out",
      "90",
      "--end-out",
      "50",
      `--start-at=${NOW}`,
      `--end-at=${NOW + 600n}`,
      "--yes",
    ];
    expect((await cli(create("dutch", ...dutch), keys)).code).toBe(EXIT_OK);
    const attestor = (await generateKeyPairSigner()).address;
    const attested = await cli(
      create("attested", "--amount-in", "100", "--min-result", "1", "--max-result", "9", "--attestor", attestor, "--spec-hash", "ab".repeat(32), "--yes"),
      keys,
    );
    expect(attested.json()["warnings"]).toHaveLength(2);
    expect(attested.json()["warnings"]).toContain(noJudgeKey(attestor));
    const listed = (await cli(["list", "--keypair", "owner.json"], keys)).json() as Json;
    expect(listed["intents"].map((i: Json) => i["order"]["kind"]).sort()).toEqual(["attested", "dutch", "limit"]);
    expect((await cli(["list", "--owner", w.owner.address], {})).json()).toEqual(listed);
    expect(balance(w.ownerInput)).toBe(700n);
  });

  it("sets and removes the engine's allowance, and leaves another app's approval alone", async () => {
    const setTo = (amount: string, ...rest: string[]) =>
      cli(["approve", "--keypair", "owner.json", "--mint", w.inputMint, "--amount", amount, ...(rest.includes("--units") ? [] : ["--units", "raw"]), ...rest], keys);
    const preview = (await setTo("250")).json() as Json;
    expect(preview).toMatchObject({ account: w.ownerInput, allowance: "250", sent: false, warnings: [] });
    expect(preview["summary"]).toEqual([`Sets the engine's spending allowance on ${w.ownerInput} to 0.00025 (now 0)`]);
    expect(allowance(w.ownerInput)).toBe(0n);
    await setTo("0.5", "--units", "tokens", "--yes");
    expect(allowance(w.ownerInput)).toBe(500_000n);
    const revoke = (...rest: string[]) =>
      cli(["revoke-approval", "--keypair", "owner.json", "--mint", w.inputMint, ...rest], keys);
    expect(((await revoke()).json() as Json)["summary"]).toEqual([
      `Removes the engine's spending allowance on ${w.ownerInput} (now 0.5)`,
    ]);
    expect((await revoke("--yes")).code).toBe(EXIT_OK);
    expect(allowance(w.ownerInput)).toBe(0n);
    expect((await revoke("--yes")).err).toBe(`${w.ownerInput} gives no spending allowance to anyone; nothing to remove`);
    const other = (await generateKeyPairSigner()).address;
    await send(w.owner, [getApproveInstruction({ source: w.ownerInput, delegate: other, owner: w.owner, amount: 9n })]);
    expect((await revoke("--yes")).err).toBe(`the allowance on ${w.ownerInput} belongs to ${other}, not the engine; it is left alone`);
    const replacing = (await setTo("1")).json() as Json;
    expect(replacing["warnings"]).toHaveLength(1);
    expect(replacing["summary"].at(-1)).toBe(`WARNING: ${replacing["warnings"][0]}`);
    const stranger = (await generateKeyPairSigner()).address;
    expect((await cli(["approve", "--keypair", "owner.json", "--mint", stranger, "--amount", "1"], keys)).code).toBe(EXIT_FAILED);
    const empty = await funded();
    expect((await cli(["approve", "--keypair", "e.json", "--mint", w.inputMint, "--amount", "1"], { "e.json": empty })).err).toBe(
      `${empty.address} holds no token account for ${w.inputMint} at ${await ataOf(empty.address, w.inputMint)}`,
    );
  });

  it("grants, shows, uses and revokes a mandate from the command line", async () => {
    const agent = await funded();
    keys["agent.json"] = agent;
    const grant = [
      "mandate",
      "grant",
      "--keypair",
      "owner.json",
      "--agent",
      agent.address,
      "--input-mint",
      w.inputMint,
      "--output-mint",
      w.outputMint,
      "--kinds",
      "swap",
      "--per-intent",
      "0.0004",
      "--total",
      "0.0006",
      "--max-intents",
      "2",
      "--max-ttl",
      "3600",
      "--valid-for",
      "86400",
      "--floor-out",
      "1",
      "--floor-in",
      "2",
      "--agent-fee",
      "0.00001",
      "--units",
      "tokens",
    ];
    expect((await cli(grant, keys)).json()).toMatchObject({ id: "0", sent: false });
    expect((await cli([...grant, "--yes"], keys)).json()).toMatchObject({ sent: true });
    const shown = (await cli(["mandate", "show", "--agent", agent.address, "--owner", w.owner.address], {})).json();
    expect(shown).toMatchObject({ status: "active", per_intent: "400", total: "600", agent_fee: "10" });
    expect((await cli(["mandate", "show", "--agent", agent.address, "--keypair", "owner.json"], keys)).json()).toEqual(shown);
    const use = [
      "mandate",
      "use",
      "swap",
      "--keypair",
      "agent.json",
      "--owner",
      w.owner.address,
      "--expires-in",
      "600",
      "--units",
      "tokens",
      "--amount-in",
      "0.00039",
      "--min-out",
      "0.0002",
      "--yes",
    ];
    const used = (await cli(use, keys)).json() as Json;
    expect(used).toMatchObject({ escrow: "390", agent_fee: "10", sent: true });
    expect(BigInt(used["nonce"]) & MANDATE_NONCE_BIT).toBe(MANDATE_NONCE_BIT);
    const ghost = await funded();
    expect((await cli(use, { ...keys, "agent.json": ghost })).code).toBe(EXIT_FAILED);
    const revoked = (await cli(["mandate", "revoke", "--keypair", "owner.json", "--agent", agent.address, "--yes"], keys)).json();
    expect(revoked).toMatchObject({ cancelled: [used["intent"]], still_open: 0, sent: true });
    const [address] = await findMandatePda({ owner: w.owner.address, agent: agent.address, id: 0n });
    expect(exists(address)).toBe(false);
  });
});
