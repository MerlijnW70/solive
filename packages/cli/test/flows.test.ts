import {
  type Address,
  generateKeyPairSigner,
  getBase58Encoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type KeyPairSigner,
  lamports,
  partiallySignTransaction,
  type Signature,
} from "@solana/kit";
import { getApproveInstruction, getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { FailedTransactionMetadata } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  EVENT_IX_TAG,
  findAssociatedTokenAddress,
  findConfigPda,
  findIntentPda,
  findMandatePda,
  getConfigDecoder,
  getIntentDecoder,
  IntentStatus,
  getPauseRaisedEventEncoder,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  MANDATE_NONCE_BIT,
} from "@intent-engine/core";
import { COMPUTE_BUDGET_ADDRESS } from "@intent-engine/solver";
import { BlockhashExpired, FailedOnChain, failure, loadConfig, type Transport, noJudgeKey } from "@intent-engine/client";
import { createCost, rentRate } from "../src/agent/budget.js";
import { AUTHORITY_NEXT, follow, followGap, type Runtime } from "../src/commands.js";
import { CANCELS_FAILED, CANCELS_UNKNOWN, execute, FlowRefused, NOT_SENT } from "../src/flows.js";
import { NOTHING_TO_CREATE, TREASURY_IS_PROGRAM, treasuryTooEmpty } from "../src/treasury.js";
import { TREASURY_CREATE_NEEDS_MINTS } from "../src/args.js";
import { renderText } from "../src/render.js";
import { CLUSTERS, ENV_KEYPAIR, ENV_URL } from "../src/args.js";
import { EXIT_FAILED, EXIT_OK, EXIT_PARTIAL, EXIT_USAGE, main, unreachable } from "../src/main.js";
import { ata, balance, cli, enginePath, funded, h, NOW, runtime, send, transport, type World, world } from "./harness.js";

type Json = Record<string, any>;

const ESCROW = 400n;

const allowance = (account: Address) => {
  const view = h.svm.getAccount(account);
  return view.exists ? getTokenDecoder().decode(view.data).delegatedAmount : -1n;
};

const exists = (address: Address) => h.svm.getAccount(address).exists;

async function signAndSend(transaction: string, signer: KeyPairSigner): Promise<void> {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
  const result = h.svm.sendTransaction(await partiallySignTransaction([signer.keyPair], tx));
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(result.toString());
  }
}

describe("command line flows", () => {
  let w: World;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    w = await world();
    h.files.clear();
    for (const name of Object.keys(h.env)) {
      delete h.env[name];
    }
    keys = { "owner.json": w.owner, "admin.json": w.authority };
  });

  const create = (kind: string, ...rest: string[]) => [
    "create",
    kind,
    "--keypair",
    "owner.json",
    "--input-mint",
    w.inputMint,
    "--output-mint",
    w.outputMint,
    "--expires-in",
    "3600",
    ...(rest.includes("--units") ? [] : ["--units", "raw"]),
    ...rest,
  ];

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

  const twoAgentIntents = async () => {
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
      "200",
      "--total",
      "600",
      "--max-intents",
      "3",
      "--max-ttl",
      "3600",
      "--valid-for",
      "86400",
      "--floor-out",
      "1",
      "--floor-in",
      "2",
      "--agent-fee",
      "10",
      "--units",
      "raw",
      "--yes",
    ];
    expect((await cli(grant, keys)).json()).toMatchObject({ sent: true });
    const use = ["mandate", "use", "swap", "--keypair", "agent.json", "--owner", w.owner.address, "--expires-in", "600", "--units", "raw", "--amount-in", "190", "--min-out", "100", "--yes"];
    const opened: Address[] = [];
    for (let i = 0; i < 2; i++) {
      const used = (await cli(use, keys)).json() as Json;
      expect(used).toMatchObject({ sent: true });
      opened.push(used["intent"] as Address);
    }
    const preview = (await cli(["mandate", "revoke", "--keypair", "owner.json", "--agent", agent.address], keys)).json() as Json;
    const [first, second] = preview["cancelled"] as Address[];
    expect(new Set([first, second])).toEqual(new Set(opened));
    return { agent, first: first as Address, second: second as Address };
  };

  const statusOf = (intent: Address) => {
    const view = h.svm.getAccount(intent);
    return view.exists ? getIntentDecoder().decode(view.data).status : undefined;
  };

  it("cancel close uses the intent rent payer", async () => {
    const { agent, first } = await twoAgentIntents();
    const view = h.svm.getAccount(first);
    if (!view.exists) {
      throw new Error("the agent intent is missing");
    }
    const { nonce, rentPayer } = getIntentDecoder().decode(view.data);
    expect(rentPayer).toBe(agent.address);
    const cancel = ["cancel", "--keypair", "owner.json", "--nonce", nonce.toString(), "--close"];
    const preview = await cli(cancel, keys);
    expect(preview.code).toBe(EXIT_OK);
    expect((preview.json() as Json)["summary"]).toContain(
      `Closes the intent in the same transaction and returns its rent and bounty to ${agent.address}, who paid them; it can no longer be read afterwards`,
    );
    const held = h.svm.getBalance(agent.address) ?? 0n;
    const locked = h.svm.getBalance(first) ?? 0n;
    const sent = await cli([...cancel, "--yes"], keys);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.json()).toMatchObject({ intent: first, sent: true });
    expect(exists(first)).toBe(false);
    expect((h.svm.getBalance(agent.address) ?? 0n) - held).toBeGreaterThanOrEqual(locked);
  });

  it("revoke exits non zero when a cancel failed", async () => {
    const { agent, first, second } = await twoAgentIntents();
    h.engineLog = [];
    h.sendFails = { error: new FailedOnChain("the cancel failed on chain", failure("1".repeat(64) as Signature, null)), landed: false, after: 1 };
    const revoked = await cli(["mandate", "revoke", "--keypair", "owner.json", "--agent", agent.address, "--yes"], keys);
    expect([revoked.code, revoked.err]).toEqual([EXIT_PARTIAL, ""]);
    expect(EXIT_PARTIAL).not.toBe(EXIT_FAILED);
    const shown = revoked.json() as Json;
    expect(shown).toMatchObject({ sent: true, cancelled: [second], failed: [{ intent: first, reason: "the cancel failed on chain" }], next: CANCELS_FAILED });
    expect(shown).not.toHaveProperty("unknown");
    expect(shown["signatures"]).toHaveLength(2);
    const [address] = await findMandatePda({ owner: w.owner.address, agent: agent.address, id: 0n });
    expect(exists(address)).toBe(false);
    expect([statusOf(first), statusOf(second)]).toEqual([IntentStatus.Open, IntentStatus.Cancelled]);
  });

  it("a cancel that may have landed is reported as unknown", async () => {
    const { agent, first, second } = await twoAgentIntents();
    h.engineLog = [];
    h.sendFails = { error: new Error("timed out"), landed: false, after: 1 };
    const revoked = await cli(["mandate", "revoke", "--keypair", "owner.json", "--agent", agent.address, "--yes"], keys);
    expect(revoked.code).toBe(EXIT_PARTIAL);
    const shown = revoked.json() as Json;
    expect(shown).toMatchObject({ sent: true, cancelled: [second], unknown: [{ intent: first, signature: expect.any(String), reason: "timed out" }], next: CANCELS_UNKNOWN });
    expect(shown).not.toHaveProperty("failed");
    expect(shown["signatures"]).toHaveLength(2);
    expect(statusOf(first)).toBe(IntentStatus.Open);
  });

  it("a cancel that landed despite an error is reported as cancelled", async () => {
    const { agent, first, second } = await twoAgentIntents();
    h.engineLog = [];
    h.sendFails = { error: new BlockhashExpired("expired"), landed: true, after: 1 };
    const revoked = await cli(["mandate", "revoke", "--keypair", "owner.json", "--agent", agent.address, "--yes"], keys);
    expect(revoked.code).toBe(EXIT_OK);
    const shown = revoked.json() as Json;
    expect(new Set(shown["cancelled"])).toEqual(new Set([first, second]));
    expect(shown).not.toHaveProperty("failed");
    expect(shown).not.toHaveProperty("unknown");
    expect(shown["signatures"]).toHaveLength(3);
    expect([statusOf(first), statusOf(second)]).toEqual([IntentStatus.Cancelled, IntentStatus.Cancelled]);
  });

  it("a cancel found failed in the intent's history is reported as failed", async () => {
    const { agent, first } = await twoAgentIntents();
    const unsigned = getTransactionDecoder();
    h.engineLog = [];
    const realSend = transport.sendWire;
    let dropped = "";
    h.sendFails = null;
    let sends = 0;
    transport.sendWire = async (wire, latest) => {
      sends += 1;
      if (sends === 2) {
        dropped = getSignatureFromTransaction(unsigned.decode(getBase64Encoder().encode(wire)));
        h.engineLog = [{ signature: dropped, slot: 9n, blockTime: null, failed: true, emitted: [] }];
        throw new Error("timed out");
      }
      return realSend(wire, latest);
    };
    try {
      const revoked = await cli(["mandate", "revoke", "--keypair", "owner.json", "--agent", agent.address, "--yes"], keys);
      expect(revoked.code).toBe(EXIT_PARTIAL);
      expect(revoked.json()).toMatchObject({ failed: [{ intent: first, reason: "timed out" }], next: CANCELS_FAILED });
      expect(dropped).not.toBe("");
    } finally {
      transport.sendWire = realSend;
      h.engineLog = [];
    }
  });

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

  it("prints help once and names the node and the fix when it cannot be reached", async () => {
    const help = (await cli(["help"], {})).out;
    expect(help.startsWith("usage: setup | add-to claude|codex | balance | pda | domain | mcp")).toBe(true);
    expect(help).not.toContain("usage: usage:");
    const err: string[] = [];
    const down = {
      ...runtime({}),
      transport: () => ({
        ...transport,
        getAccount: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    };
    const code = await main(["show", "config"], down, { out: () => undefined, err: (t) => err.push(t) });
    expect([code, err]).toEqual([EXIT_FAILED, [unreachable("http://127.0.0.1:8899")]]);
    expect(unreachable("x")).toBe(
      "cannot reach the RPC node at x; check your network connection and that this endpoint is up, or pass another --url or set INTENT_ENGINE_URL",
    );
    const other: string[] = [];
    const broken = { ...down, transport: () => ({ ...transport, getAccount: async () => { throw new TypeError("other"); } }) };
    await main(["show", "config"], broken, { out: () => undefined, err: (t) => other.push(t) });
    expect(other).toEqual(["other"]);
    const plain: string[] = [];
    const failing = { ...down, transport: () => ({ ...transport, getAccount: async () => { throw new Error("fetch failed"); } }) };
    await main(["show", "config"], failing, { out: () => undefined, err: (t) => plain.push(t) });
    expect(plain).toEqual(["fetch failed"]);
    const noUrl: string[] = [];
    await main(["pda", "--owner", w.owner.address, "--nonce", "x"], down, { out: () => undefined, err: (t) => noUrl.push(t) });
    expect(noUrl[0]).not.toContain("cannot reach");
  });

  it("the unreachable message names the url it tried", async () => {
    const down = {
      ...runtime({}),
      transport: () => ({
        ...transport,
        getAccount: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    };
    const tried = async (...url: string[]) => {
      const err: string[] = [];
      const code = await main(["show", "config", ...url], down, { out: () => undefined, err: (t) => err.push(t) });
      expect(code).toBe(EXIT_FAILED);
      return err;
    };
    const devnet = await tried("--url", "devnet");
    expect(devnet).toEqual([unreachable("https://api.devnet.solana.com")]);
    expect(devnet[0]).toContain("at https://api.devnet.solana.com;");
    expect(devnet[0]).not.toContain("mainnet-beta");
    expect(devnet[0]).not.toContain("--url devnet");
    const secret = await tried("--url", "https://user:token@rpc.example.org:8443/key/abc?api-key=xyz");
    expect(secret).toEqual([unreachable("https://rpc.example.org:8443")]);
    expect(secret[0]).not.toMatch(/token|abc|xyz/);
  });

  it("answers help, prints text on request and honours the environment and cluster names", async () => {
    const help = await cli(["help", "cancel"], {});
    expect(help.out).toBe(
      "usage: cancel [--keypair <file>] --nonce <n> [--close] [--yes]\noptions: --url, --priority-fee, --keypair, --yes, --nonce, --close, --output, --help, --debug",
    );
    expect((await cli(["approve", "--help"], {})).out.startsWith("usage: approve [--keypair <file>]")).toBe(true);
    const text = await cli(["show", "config", "--output", "text"], {});
    expect(text.out.split("\n")).toContain(`feeRecipient: ${w.feeRecipient.address}`);
    const preview = await cli([...create("swap", "--amount-in", "400", "--min-out", "300"), "--output", "text"], keys);
    const lines = preview.out.split("\n");
    expect(lines[0]).toBe(`Sell: exactly 0.0004 of ${w.inputMint}`);
    expect(lines).toContain("sent: false");
    expect(lines.some((l) => l.startsWith("warnings:"))).toBe(false);
    expect(lines).toContain("next: nothing was sent; check the summary and pass --yes to sign and send");
    expect(renderText({ summary: ["Sell: 1"], warnings: ["long", "scaled"], sent: false }).split("\n")).toEqual([
      "Sell: 1",
      "WARNING: long",
      "WARNING: scaled",
      "sent: false",
    ]);
    expect(renderText({ summary: ["Sell: 1", "WARNING: long"], warnings: ["long"] }).split("\n")).toEqual([
      "Sell: 1",
      "WARNING: long",
    ]);
    expect(renderText({ warnings: ["long"], gap: true }).split("\n")).toEqual(["WARNING: long", "gap: true"]);
    expect(renderText({ warnings: "none" })).toBe("warnings: none");
    expect((await cli(["show", "config", "--output", "yaml"], {})).code).toBe(EXIT_USAGE);
    await cli([...create("swap", "--amount-in", "400", "--min-out", "300"), "--yes"], keys);
    h.env[ENV_KEYPAIR] = "owner.json";
    h.env[ENV_URL] = "devnet";
    h.urls.length = 0;
    expect((await cli(["cancel", "--nonce", "0", "--yes"], keys)).code).toBe(EXIT_OK);
    expect(h.urls).toEqual([CLUSTERS["devnet"]]);
    const [intent] = await findIntentPda({ owner: w.owner.address, nonce: 0n });
    expect((await cli(["show", "intent", "--owner", w.owner.address, "--nonce", "0", "--url", "localnet"], {})).json()).toMatchObject({
      address: intent,
      status: "cancelled",
    });
    expect(h.urls.at(-1)).toBe(CLUSTERS["localnet"]);
  });

  it("events follow survives a failed poll", async () => {
    const tx = (signature: string) => ({ signature, slot: 1n, blockTime: null, failed: false, emitted: [] });
    const polls: (Error | ReturnType<typeof tx>[])[] = [
      [tx("a")],
      new TypeError("fetch failed"),
      new Error("HTTP error (503): Service Unavailable"),
      [tx("b"), tx("a")],
      new Error("HTTP error (502): Bad Gateway"),
      [tx("c"), tx("b")],
    ];
    h.through = {
      ...transport,
      engineTransactions: async () => {
        const next = polls.shift() ?? [];
        if (next instanceof Error) {
          throw next;
        }
        return next;
      },
    };
    h.sleeps.length = 0;
    h.rounds = 6;
    const followed = await cli(["events", "--follow", "--interval", "4"], {});
    h.through = null;
    h.rounds = 0;
    expect([followed.code, followed.err]).toEqual([EXIT_OK, ""]);
    const shown = followed.each().map((v) => v["signature"] ?? v["error"]);
    expect(shown).toEqual(["a", "fetch failed", "HTTP error (503): Service Unavailable", "b", "HTTP error (502): Bad Gateway", "c"]);
    expect(followed.each().filter((v) => "error" in v).map((v) => v["retry_in"])).toEqual([1, 2, 1]);
    expect(h.sleeps).toEqual([4, 1, 2, 4, 1, 4]);
  });

  it("follows new engine events without repeating them until told to stop", async () => {
    const key = "11111111111111111111111111111112" as Address;
    const tag = new Uint8Array([...EVENT_IX_TAG, ...getPauseRaisedEventEncoder().encode({ by: key, paused: 2 })]);
    h.engineLog = [
      { signature: "new", slot: 2n, blockTime: null, failed: false, emitted: [tag] },
      { signature: "old", slot: 1n, blockTime: null, failed: false, emitted: [] },
    ];
    h.sleeps.length = 0;
    h.rounds = 3;
    const followed = await cli(["events", "--follow", "--interval", "4", "--limit", "5"], {});
    expect(followed.code).toBe(EXIT_OK);
    const shown = followed.out.split("\n}\n").length;
    expect(shown).toBe(2);
    expect(followed.out.indexOf('"old"')).toBeLessThan(followed.out.indexOf('"new"'));
    expect(h.sleeps).toEqual([4, 4, 4]);
    h.sleeps.length = 0;
    h.rounds = 1;
    const quiet = await cli(["events", "--follow", "--output", "text"], {});
    expect(quiet.out.split("\n").filter((l) => l.startsWith("signature: "))).toEqual(["signature: old", "signature: new"]);
    expect(h.sleeps).toEqual([10]);
    h.engineLog = [];
    h.rounds = 0;
  });
});

describe("sending a prepared transaction", () => {
  it("refuses one that needs any signature besides the caller's", async () => {
    const signer = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const view = { transaction: "", signers: [signer.address, other.address], last_valid_block_height: 1n };
    await expect(execute({} as Transport, view, signer)).rejects.toThrow(
      new FlowRefused(`this transaction also needs signatures from ${other.address}`),
    );
  });
});

describe("following events", () => {
  it("says when more transactions landed between polls than one poll fetches", async () => {
    const tx = (signature: string) => ({ signature, slot: 1n, blockTime: null, failed: false, emitted: [] });
    const polls = [[tx("b"), tx("a")], [tx("d"), tx("c")], [tx("e"), tx("d")]];
    const transport = { engineTransactions: async () => polls.shift() ?? [] } as unknown as Transport;
    const runtime = { sleep: async () => polls.length > 0 } as unknown as Runtime;
    const emitted: object[] = [];
    expect(await follow(transport, runtime, 2, 1, (v) => emitted.push(v))).toBe(5);
    expect(emitted.map((v) => ("signature" in v ? v.signature : v))).toEqual([
      "a",
      "b",
      { gap: true, warning: followGap(2) },
      "c",
      "d",
      "e",
    ]);
    expect(followGap(2)).toBe(
      "more than 2 engine transactions landed since the last poll, so some were not shown; raise --limit or lower --interval",
    );
  });
});

async function ataOf(owner: Address, mint: Address): Promise<Address> {
  return findAssociatedTokenAddress({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
}
