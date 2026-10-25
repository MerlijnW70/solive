import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner, getBase58Decoder, type KeyPairSigner, lamports } from "@solana/kit";
import { getCloseAccountInstruction, getMintToInstruction, getTransferInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import { splitFees } from "@intent-engine/core";
import {
  findConfigPda,
  findIntentPda,
  findUserStatePda,
  getUserStateDecoder,
  findVaultPda,
  INTENT_ENGINE_PROGRAM_ADDRESS,
} from "@intent-engine/core/internal";
import { configExists } from "../src/commands.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { ata, balance, boot, cli, DOMAIN, ESCROW, FEE_BPS, funded, h, NOW, send, transport, world } from "./harness.js";
import { createSwap } from "./cli-kit.js";

describe("cli against the deployed engine", () => {
  let authority: KeyPairSigner;
  let feeRecipient: KeyPairSigner;
  let owner: KeyPairSigner;
  let inputMint: Address;
  let outputMint: Address;
  let ownerInput: Address;

  beforeEach(async () => {
    ({ authority, feeRecipient, owner, inputMint, outputMint, ownerInput } = await world());
  });

  const create = (nonce: string, expiresAt: bigint) => createSwap(inputMint, outputMint, nonce, expiresAt);

  it("creates an intent, initialising the user on first use, then shows and quotes it", async () => {
    const created = await cli(create("7", NOW + 3_600n), { "owner.json": owner });
    expect(created.err).toBe("");
    expect(created.code).toBe(EXIT_OK);
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 7n });
    expect(created.json()["intent"]).toBe(intent);
    expect(created.json()).toMatchObject({ sent: true, nonce: "7", escrow: ESCROW.toString() });
    expect(created.json()["signatures"]).toHaveLength(1);
    expect(h.urls).toEqual(["http://cluster"]);
    expect(balance(ownerInput)).toBe(1_000n - ESCROW);
    expect((await cli(create("8", NOW + 3_600n), { "owner.json": owner })).code).toBe(EXIT_OK);

    const shown = (await cli(["show", "intent", "--owner", owner.address, "--nonce", "7"], {})).json();
    expect(shown).toMatchObject({
      address: intent,
      owner: owner.address,
      inputMint,
      outputMint,
      rentPayer: owner.address,
      nonce: "7",
      escrowed: ESCROW.toString(),
      createdAt: NOW.toString(),
      expiresAt: (NOW + 3_600n).toString(),
      status: "open",
      version: 2,
      flags: 0,
      filled: "0",
      revision: 0,
      params: { kind: "SwapExactIn", amountIn: ESCROW.toString(), minOut: "300" },
    });

    const { protocol, net } = splitFees(ESCROW, FEE_BPS, 0, 0);
    expect((await cli(["quote", "--owner", owner.address, "--nonce", "7"], {})).json()).toEqual({
      address: intent,
      at: (NOW + 1_000n).toString(),
      amountIn: ESCROW.toString(),
      requiredOut: "300",
      feeBps: FEE_BPS,
      partnerBps: 0,
      protocolFee: protocol.toString(),
      partnerFee: "0",
      net: net.toString(),
    });
    expect((await cli(["quote", "--owner", owner.address, "--nonce", "7", "--at", "5"], {})).json()["at"]).toBe("5");

    const config = (await cli(["show", "config"], {})).json();
    expect(config).toMatchObject({ feeBps: FEE_BPS, feeRecipient: feeRecipient.address, domainMatchesCluster: true });
    expect((await cli(["domain"], {})).json()).toEqual({ genesisHash: h.genesis, domain: "11".repeat(32) });
    h.genesis = getBase58Decoder().decode(new Uint8Array(32).fill(0x12));
    expect((await cli(["show", "config"], {})).json()["domainMatchesCluster"]).toBe(false);
    h.genesis = getBase58Decoder().decode(new Uint8Array(31).fill(0x11));
    expect((await cli(["show", "config"], {})).json()["domainMatchesCluster"]).toBe(false);
    h.genesis = getBase58Decoder().decode(DOMAIN);
  });

  it("cancels and closes an intent, returning escrow and rent", async () => {
    await cli(create("1", NOW + 3_600n), { "owner.json": owner });
    const cancelled = await cli(["cancel", "--keypair", "owner.json", "--nonce", "1", "--yes"], { "owner.json": owner });
    expect(cancelled.code).toBe(EXIT_OK);
    expect(balance(ownerInput)).toBe(1_000n);
    expect((await cli(["show", "intent", "--owner", owner.address, "--nonce", "1"], {})).json()["status"]).toBe("cancelled");
    const cranker = await funded();
    const closed = await cli(["close", "--keypair", "c.json", "--owner", owner.address, "--nonce", "1", "--yes"], {
      "c.json": cranker,
    });
    expect(closed.code).toBe(EXIT_OK);
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 1n });
    expect(h.svm.getAccount(intent).exists).toBe(false);
  });

  it("expires an intent once its deadline passes", async () => {
    await cli(create("2", NOW + 10n), { "owner.json": owner });
    const cranker = await funded();
    const args = ["expire", "--keypair", "c.json", "--owner", owner.address, "--nonce", "2", "--yes"];
    const early = await cli(args, { "c.json": cranker });
    expect(early.code).toBe(EXIT_FAILED);
    const clock = h.svm.getClock();
    clock.unixTimestamp = NOW + 10n;
    h.svm.setClock(clock);
    expect((await cli(args, { "c.json": cranker })).code).toBe(EXIT_OK);
    expect(balance(ownerInput)).toBe(1_000n);
    expect((await cli(["show", "intent", "--owner", owner.address, "--nonce", "2"], {})).json()["status"]).toBe("expired");
  });

  it("recreates a missing canonical account only when expire or close has something to refund", async () => {
    const drainAndClose = async () => {
      const held = balance(ownerInput);
      const sink = await ata(authority, (await generateKeyPairSigner()).address, inputMint);
      await send(owner, [
        ...(held > 0n
          ? [getTransferInstruction({ source: ownerInput, destination: sink, authority: owner, amount: held })]
          : []),
        getCloseAccountInstruction({ account: ownerInput, destination: owner.address, owner }),
      ]);
      expect(h.svm.getAccount(ownerInput).exists).toBe(false);
    };
    const cranker = await funded();
    await cli(create("6", NOW + 10n), { "owner.json": owner });
    await cli(create("8", NOW + 3_600n), { "owner.json": owner });
    expect((await cli(["cancel", "--keypair", "owner.json", "--nonce", "8", "--yes"], { "owner.json": owner })).code).toBe(
      EXIT_OK,
    );
    await drainAndClose();
    const clock = h.svm.getClock();
    clock.unixTimestamp = NOW + 10n;
    h.svm.setClock(clock);
    const expireArgs = ["expire", "--keypair", "c.json", "--owner", owner.address, "--nonce", "6", "--yes"];
    expect((await cli(expireArgs, { "c.json": cranker })).code).toBe(EXIT_OK);
    expect(balance(ownerInput)).toBe(ESCROW);
    await drainAndClose();
    const [intent6] = await findIntentPda({ owner: owner.address, nonce: 6n });
    const [vault6] = await findVaultPda({ intent: intent6 });
    await send(authority, [getMintToInstruction({ mint: inputMint, token: vault6, mintAuthority: authority, amount: 5n })]);
    const close6 = ["close", "--keypair", "c.json", "--owner", owner.address, "--nonce", "6", "--yes"];
    expect((await cli(close6, { "c.json": cranker })).code).toBe(EXIT_OK);
    expect(balance(ownerInput)).toBe(5n);
    await drainAndClose();
    const close8 = ["close", "--keypair", "c.json", "--owner", owner.address, "--nonce", "8", "--yes"];
    expect((await cli(close8, { "c.json": cranker })).code).toBe(EXIT_OK);
    expect(h.svm.getAccount(ownerInput).exists).toBe(false);
  });

  it("initialises config with the cluster's own domain and drives the pause from the CLI", async () => {
    const admin = await boot();
    const guardian = await funded();
    const fresh = getBase58Decoder().decode(new Uint8Array(32).fill(0x2a));
    h.genesis = fresh;
    const terms = ["--guardian", guardian.address, "--fee-recipient", feeRecipient.address, "--fee-bps", "7", "--kinds", "swap,limit", "--flags", "fill"];
    const previewed = await cli(["init-config", "--keypair", "admin.json", ...terms], { "admin.json": admin });
    expect(previewed.code).toBe(EXIT_OK);
    const [configAddress] = await findConfigPda();
    expect(previewed.json()).toMatchObject({
      config: configAddress,
      sent: false,
      next: "nothing was sent; check the summary and pass --yes to sign and send",
      summary: [
        `Creates the engine config ${configAddress} for this cluster (domain ${fresh}) with the signer as admin`,
        `Guardian: ${guardian.address}`,
        `Fee recipient: ${feeRecipient.address}`,
        "Fee: 7 bps",
        "Enabled kinds: swap, limit",
        "Paused: filling",
      ],
    });
    expect(BigInt(previewed.json()["units_consumed"] as string)).toBeGreaterThan(0n);
    expect(h.svm.getAccount(configAddress).exists).toBe(false);
    expect((await cli(["init-config", "--authority", admin.address, "--yes", ...terms], {})).err).toBe(
      "--yes signs and sends with --keypair; --authority only prints an unsigned transaction",
    );
    const init = await cli(
      [
        "init-config",
        "--keypair",
        "admin.json",
        "--yes",
        "--guardian",
        guardian.address,
        "--fee-recipient",
        feeRecipient.address,
        "--fee-bps",
        "7",
        "--kinds",
        "swap,limit",
        "--flags",
        "fill",
      ],
      { "admin.json": admin },
    );
    expect(init.err).toBe("");
    expect(init.json()["domain"]).toBe("2a".repeat(32));
    const shown = (await cli(["show", "config"], {})).json();
    expect(shown).toMatchObject({
      admin: admin.address,
      guardian: guardian.address,
      feeRecipient: feeRecipient.address,
      feeBps: 7,
      enabledKinds: "6",
      paused: 2,
      domainMatchesCluster: true,
    });
    const lower = ["lower-pause", "--keypair", "k.json", "--yes", "--flags", "fill"];
    expect((await cli(lower, { "k.json": guardian })).code).toBe(EXIT_FAILED);
    expect((await cli(lower, { "k.json": admin })).code).toBe(EXIT_OK);
    expect((await cli(["show", "config"], {})).json()["paused"]).toBe(0);
    const raise = ["raise-pause", "--keypair", "k.json", "--yes", "--flags", "all"];
    expect((await cli(raise, { "k.json": guardian })).code).toBe(EXIT_OK);
    expect((await cli(["show", "config"], {})).json()["paused"]).toBe(3);
    const sentBefore = h.wires.length;
    const again = await cli(
      [
        "init-config",
        "--keypair",
        "admin.json",
        "--yes",
        "--guardian",
        guardian.address,
        "--fee-recipient",
        feeRecipient.address,
        "--fee-bps",
        "7",
        "--kinds",
        "swap",
      ],
      { "admin.json": admin },
    );
    expect(again.code).toBe(EXIT_FAILED);
    expect(again.err).toBe(configExists(configAddress));
    expect(h.wires).toHaveLength(sentBefore);
    const unsigned = await cli(["init-config", "--authority", admin.address, ...terms], {});
    expect([unsigned.code, unsigned.err]).toEqual([EXIT_FAILED, configExists(configAddress)]);
  });

  it("creates an intent that names a partner and shows it", async () => {
    const partner = await funded();
    const created = await cli(
      [...create("5", NOW + 3_600n), "--partner", partner.address, "--partner-bps", "25"],
      { "owner.json": owner },
    );
    expect(created.code).toBe(EXIT_OK);
    const shown = (await cli(["show", "intent", "--owner", owner.address, "--nonce", "5"], {})).json();
    expect(shown).toMatchObject({ partner: partner.address, partnerBps: 25 });
    await cli(create("6", NOW + 3_600n), { "owner.json": owner });
    const plain = (await cli(["show", "intent", "--owner", owner.address, "--nonce", "6"], {})).json();
    expect(plain).not.toHaveProperty("partner");
    expect(plain).not.toHaveProperty("partnerBps");
  });

  it("advances the signing epoch", async () => {
    await cli(create("0", NOW + 3_600n), { "owner.json": owner });
    const [user] = await findUserStatePda({ owner: owner.address });
    const epoch = async () => {
      const view = await transport.getAccount(user);
      return view === null ? -1n : getUserStateDecoder().decode(view.data).epoch;
    };
    let previous = await epoch();
    expect(previous).toBe(0n);
    for (let i = 0; i < 2; i++) {
      const advanced = await cli(["advance-epoch", "--keypair", "owner.json"], { "owner.json": owner });
      expect(advanced.code).toBe(EXIT_OK);
      expect(typeof advanced.json()["signature"]).toBe("string");
      const now = await epoch();
      expect(advanced.json()["epoch"]).toBe(now.toString());
      expect(now > previous && now - previous <= 2n ** 48n).toBe(true);
      previous = now;
    }
    const stranger = await generateKeyPairSigner();
    expect((await cli(["advance-epoch", "--keypair", "s.json"], { "s.json": stranger })).code).toBe(EXIT_FAILED);
  });

  it("advances the nonce window", async () => {
    await cli(create("0", NOW + 3_600n), { "owner.json": owner });
    const advanced = await cli(["advance-nonce", "--keypair", "owner.json", "--base", "300", "--yes"], { "owner.json": owner });
    expect(advanced.code).toBe(EXIT_OK);
    const stale = await cli(create("3", NOW + 3_600n), { "owner.json": owner });
    expect(stale.code).toBe(EXIT_FAILED);
  });

  it("derives addresses offline", async () => {
    const result = await cli(["pda", "--owner", owner.address, "--nonce", "9"], {});
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 9n });
    const [vault] = await findVaultPda({ intent });
    expect(result.json()).toEqual({ intent, vault });
    expect(h.urls).toEqual([]);
  });

  it("prints the hash a judge computes for a file, offline, whatever the file is called", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hash-"));
    await writeFile(join(dir, "work.mjs"), "export default 1;\n");
    await writeFile(join(dir, "other-name"), "export default 1;\n");
    const first = await cli(["hash", "--artifact", join(dir, "work.mjs")], {});
    const second = await cli(["hash", "--artifact", join(dir, "other-name")], {});
    expect(first.json()).toEqual({ artifact: join(dir, "work.mjs"), sha256: createHash("sha256").update("export default 1;\n").digest("hex") });
    expect((second.json() as { sha256: string }).sha256).toBe((first.json() as { sha256: string }).sha256);
    expect(h.urls).toEqual([]);
  });

  it("reports missing and foreign accounts as failures", async () => {
    const missing = await cli(["show", "intent", "--owner", owner.address, "--nonce", "5"], {});
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 5n });
    expect(missing).toMatchObject({ code: EXIT_FAILED, err: `intent ${intent} does not exist`, out: "" });
    h.svm.setAccount({
      address: intent,
      programAddress: TOKEN_PROGRAM_ADDRESS,
      data: new Uint8Array(400),
      executable: false,
      lamports: lamports(1_000_000n),
      space: 400n,
    });
    expect((await cli(["show", "intent", "--owner", owner.address, "--nonce", "5"], {})).err).toBe(
      `${intent} is not an engine intent`,
    );
    h.svm.setAccount({
      address: intent,
      programAddress: INTENT_ENGINE_PROGRAM_ADDRESS,
      data: new Uint8Array(400),
      executable: false,
      lamports: lamports(1_000_000n),
      space: 400n,
    });
    expect((await cli(["show", "intent", "--owner", owner.address, "--nonce", "5"], {})).err).toBe(
      `${intent} is not an engine intent`,
    );
    const ghost = (await generateKeyPairSigner()).address;
    const noMint = await cli(
      ["create", "swap", "--keypair", "owner.json", "--nonce", "4", "--input-mint", ghost, "--output-mint", outputMint,
        "--expires-at", "1", "--amount-in", "1", "--min-out", "1"],
      { "owner.json": owner },
    );
    expect(noMint.err).toBe(`NotFound: mint ${ghost} does not exist`);
  });

  it("maps usage errors to exit code two", async () => {
    expect(await cli(["fly"], {})).toMatchObject({ code: EXIT_USAGE, out: "" });
    expect([EXIT_OK, EXIT_FAILED, EXIT_USAGE]).toEqual([0, 1, 2]);
  });
});
