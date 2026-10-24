import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports as toLamports } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_VERSION,
  findConfigPda,
  findIntentPda,
  findUserStatePda,
  getConfigSize,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  INTENT_VERSION,
  LEGACY_CONFIG_SPACE,
  profileAddress,
  PROFILE_VERSION,
  USER_VERSION,
} from "@intent-engine/core";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { AUTHORITY_NEXT } from "../src/admin-commands.js";
import { MIGRATE_ONE_OR_ALL } from "../src/args.js";
import { NOTHING_TO_MIGRATE } from "../src/migrate-commands.js";
import { balance, cli, funded, h, transport, unlisting, type World, world } from "./harness.js";

type Json = Record<string, any>;

const VERSION_AT = { config: 8 + 139, user: 8 + 72, intent: 8 + 164, profile: 8 + 456 };

describe("migrate on the command line", () => {
  let w: World;
  let keys: Record<string, KeyPairSigner>;
  let tracked: Address[];

  beforeEach(async () => {
    w = await world();
    keys = { "owner.json": w.owner, "payer.json": await funded(), "admin.json": w.authority };
    tracked = [];
    h.through = {
      ...transport,
      engineAccounts: async () =>
        tracked.flatMap((address) => {
          const account = h.svm.getAccount(address);
          return account.exists && account.programAddress === INTENT_ENGINE_PROGRAM_ADDRESS
            ? [{ address, data: new Uint8Array(account.data), lamports: account.lamports }]
            : [];
        }),
    };
  });

  afterEach(() => {
    h.through = null;
  });

  const createIntent = async (): Promise<Address> => {
    const judge = (await funded()).address;
    const args = ["create", "attested", "--keypair", "owner.json", "--input-mint", w.inputMint, "--output-mint", w.outputMint, "--expires-in", "3600"];
    const terms = ["--units", "raw", "--amount-in", "100", "--min-result", "1", "--max-result", "1", "--attestor", judge, "--nonce", "0", "--yes"];
    const created = await cli([...args, ...terms], keys);
    expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
    return (await findIntentPda({ owner: w.owner.address, nonce: 0n }))[0];
  };

  const rewrite = (address: Address, edit: (data: Uint8Array) => Uint8Array, lamports?: bigint) => {
    const account = h.svm.getAccount(address);
    if (!account.exists) {
      throw new Error("account missing");
    }
    const data = edit(new Uint8Array(account.data));
    h.svm.setAccount({ ...account, data, space: BigInt(data.length), lamports: toLamports(lamports ?? account.lamports) });
  };

  const setVersion = (address: Address, at: number, version: number) =>
    rewrite(address, (data) => {
      data[at] = version;
      return data;
    });

  const versionOf = (address: Address, at: number) => {
    const account = h.svm.getAccount(address);
    return account.exists ? account.data[at] : undefined;
  };

  const lamportsOf = (address: Address) => h.svm.getBalance(address) ?? 0n;

  it("previews, then migrates every outdated account in batches, skips current ones, names what it cannot read and proposes the config step to its admin", async () => {
    const intent = await createIntent();
    const [user] = await findUserStatePda({ owner: w.owner.address });
    const set = await cli(["profile", "set", "--keypair", "owner.json", "--skills", "rust", "--endpoint", "https://worker.example/jobs", "--yes"], keys);
    expect([set.code, set.err]).toEqual([EXIT_OK, ""]);
    const profile = await profileAddress(w.owner.address);
    const [config] = await findConfigPda();
    const odd = (await funded()).address;
    h.svm.setAccount({ address: odd, lamports: toLamports(5_000_000n), data: new Uint8Array(40).fill(7), programAddress: INTENT_ENGINE_PROGRAM_ADDRESS, executable: false, space: 40n });
    const small = h.svm.minimumBalanceForRentExemption(BigInt(LEGACY_CONFIG_SPACE));
    const grown = h.svm.minimumBalanceForRentExemption(BigInt(getConfigSize()));
    rewrite(
      config,
      (data) => {
        const shrunk = data.slice(0, LEGACY_CONFIG_SPACE);
        shrunk[VERSION_AT.config] = 1;
        return shrunk;
      },
      small,
    );
    setVersion(intent, VERSION_AT.intent, 1);
    setVersion(user, VERSION_AT.user, 1);
    setVersion(profile, VERSION_AT.profile, 1);
    tracked = [config, user, intent, profile, odd];

    const all = ["migrate", "--keypair", "payer.json", "--all"];
    const preview = (await cli(all, keys)).json() as Json;
    expect(preview).toMatchObject({
      sent: false,
      payer: keys["payer.json"]?.address,
      migrate: { intent: 1, profile: 1, user: 1 },
      current: 0,
      transactions: 1,
      top_up_lamports: (grown - small).toString(),
      config: { address: config, admin: w.authority.address, top_up_lamports: (grown - small).toString() },
      unmigrated: [{ address: odd, reason: "engine account of 40 bytes that matches no account type; close it with intent-engine close-legacy" }],
    });
    expect(preview["config_proposal"]["next"]).toBe(AUTHORITY_NEXT);
    expect(preview["config_proposal"]["fee_payer"]).toBe(w.authority.address);
    expect(preview["summary"]).toEqual([
      "Migrates 3 outdated engine accounts in 1 transactions: 1 intent, 1 profile, 1 user",
      "Skips 0 accounts that are already current",
      "Cannot migrate 1 accounts of a layout no program version wrote; close them with intent-engine close-legacy",
      `Only the admin ${w.authority.address} migrates the config: import config_proposal.transaction_base58 into the multisig as a proposal`,
      `The admin ${w.authority.address} pays ${grown - small} lamports of rent for the config and must hold them before the proposal executes`,
    ]);
    expect(versionOf(intent, VERSION_AT.intent)).toBe(1);

    const sent = (await cli([...all, "--yes"], keys)).json() as Json;
    expect(sent).toMatchObject({ sent: true, failed: [] });
    expect(sent["signatures"]).toHaveLength(1);
    expect([versionOf(intent, VERSION_AT.intent), versionOf(user, VERSION_AT.user), versionOf(profile, VERSION_AT.profile)]).toEqual([
      INTENT_VERSION,
      USER_VERSION,
      PROFILE_VERSION,
    ]);
    expect(versionOf(config, VERSION_AT.config)).toBe(1);

    const again = (await cli([...all, "--yes"], keys)).json() as Json;
    expect(again).toMatchObject({ sent: false, migrate: {}, current: 3, transactions: 0, next: AUTHORITY_NEXT });

    const byAdmin = ["migrate", "--keypair", "admin.json", "--address", config];
    const admin = (await cli(byAdmin, keys)).json() as Json;
    expect(admin).toMatchObject({ sent: false, top_up_lamports: (grown - small).toString() });
    expect(admin["summary"]).toEqual([
      `Migrates ${config}, an outdated config account: version 1, ${LEGACY_CONFIG_SPACE} bytes -> version ${CONFIG_VERSION}, ${getConfigSize()} bytes`,
      `Pays ${grown - small} lamports of rent from ${w.authority.address} for the accounts that grow; no account loses lamports`,
    ]);
    const done = await cli([...byAdmin, "--yes"], keys);
    expect([done.code, done.err]).toEqual([EXIT_OK, ""]);
    expect(versionOf(config, VERSION_AT.config)).toBe(CONFIG_VERSION);
    expect(lamportsOf(config)).toBe(grown);

    const last = (await cli([...all, "--yes"], keys)).json() as Json;
    expect(last).toMatchObject({ sent: false, current: 4, transactions: 0, next: NOTHING_TO_MIGRATE });
    const tokens = balance(w.ownerInput);
    const cancelled = await cli(["cancel", "--keypair", "owner.json", "--nonce", "0", "--yes"], keys);
    expect([cancelled.code, cancelled.err]).toEqual([EXIT_OK, ""]);
    expect(balance(w.ownerInput)).toBe(tokens + 100n);
  });

  it("migrates one account after a preview and refuses current, unreadable and foreign ones", async () => {
    const intent = await createIntent();
    const one = (yes: boolean, address: Address = intent) => cli(["migrate", "--keypair", "payer.json", "--address", address, ...(yes ? ["--yes"] : [])], keys);
    const current = await one(true);
    expect(current.code).toBe(EXIT_FAILED);
    expect(current.err).toContain(`${intent} is a current intent account; there is nothing to migrate`);

    setVersion(intent, VERSION_AT.intent, 1);
    const preview = (await one(false)).json() as Json;
    expect(preview).toMatchObject({ sent: false, migrate: { intent: 1 }, top_up_lamports: "0" });
    expect(preview["summary"]).toEqual([`Migrates ${intent}, an outdated intent account: version 1, 464 bytes -> version ${INTENT_VERSION}, 464 bytes`]);
    expect(versionOf(intent, VERSION_AT.intent)).toBe(1);
    const held = lamportsOf(intent);
    const sent = await one(true);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(versionOf(intent, VERSION_AT.intent)).toBe(INTENT_VERSION);
    expect(lamportsOf(intent)).toBe(held);

    setVersion(intent, VERSION_AT.intent, 0);
    const unread = await one(true);
    expect(unread.code).toBe(EXIT_FAILED);
    expect(unread.err).toContain(`${intent} cannot migrate: intent account in a layout no program version wrote: version 0, 464 bytes; close it with intent-engine close-legacy`);
    const foreign = await one(false, w.ownerInput);
    expect(foreign.err).toContain(`${w.ownerInput} is not an engine account; migrate rewrites only accounts the engine program owns`);
    const missing = (await generateKeyPairSigner()).address;
    expect((await one(false, missing)).err).toContain(`${missing} does not exist`);

    h.through = unlisting;
    const unlisted = await cli(["migrate", "--keypair", "payer.json", "--all"], keys);
    expect(unlisted.code).toBe(EXIT_FAILED);
    expect(unlisted.err).toContain("this connection cannot list program accounts; migrate them one by one with --address");
    for (const args of [["migrate", "--keypair", "payer.json"], ["migrate", "--keypair", "payer.json", "--all", "--address", intent]]) {
      const refused = await cli(args, keys);
      expect(refused.code).toBe(EXIT_USAGE);
      expect(refused.err).toContain(MIGRATE_ONE_OR_ALL);
    }
  });
});
