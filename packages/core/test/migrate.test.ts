import { createHash } from "node:crypto";
import { type Address, AccountRole, createNoopSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_LAYOUTS,
  type AccountLayout,
  buildMigrate,
  findConfigPda,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  isConfigAccount,
  LEGACY_BOARD_SPACE,
  LEGACY_CONFIG_SPACE,
  migrationOf,
  OUTDATED_LAYOUTS,
  UNVERSIONED,
} from "../src/index.js";

const PAYER = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" as Address;

const named = (name: string): AccountLayout => {
  const layout = ACCOUNT_LAYOUTS.find((l) => l.name === name);
  if (layout === undefined) throw new Error(name);
  return layout;
};

function account(layout: AccountLayout, version: number, size = layout.space): Uint8Array {
  const data = new Uint8Array(size);
  data.set(layout.discriminator, 0);
  data[8 + layout.versionAt] = version;
  return data;
}

describe("migration", () => {
  it("lists the stand-by line layouts and the first versions of every type", () => {
    const listed = OUTDATED_LAYOUTS.map((o) => [ACCOUNT_LAYOUTS.find((l) => l.discriminator.every((b, i) => b === o.discriminator[i]))?.name, o.space, o.version]);
    expect(listed).toEqual([
      ["config", LEGACY_CONFIG_SPACE, 1],
      ["config", named("config").space, 1],
      ["user", named("user").space, 1],
      ["intent", named("intent").space, 1],
      ["mandate", named("mandate").space, 1],
      ["mint cap", named("mint cap").space, 1],
      ["committee", named("committee").space, 1],
      ["claim board", LEGACY_BOARD_SPACE, 1],
      ["claim board", named("claim board").space, 1],
      ["stand-by entry", named("stand-by entry").space, UNVERSIONED],
      ["profile", named("profile").space, 1],
    ]);
  });

  it("finds the current layout of a listed outdated account and nothing else", () => {
    for (const o of OUTDATED_LAYOUTS) {
      const layout = ACCOUNT_LAYOUTS.find((l) => l.discriminator.every((b, i) => b === o.discriminator[i]));
      if (layout === undefined) throw new Error("unlisted");
      expect(migrationOf(account(layout, o.version, o.space))).toEqual({ layout, from: o });
      expect(migrationOf(account(layout, o.version, o.space + 1))).toBeNull();
    }
    for (const layout of ACCOUNT_LAYOUTS) {
      expect(migrationOf(account(layout, layout.version))).toBeNull();
      expect(migrationOf(account(layout, layout.version + 1))).toBeNull();
    }
    expect(migrationOf(new Uint8Array(64).fill(7))).toBeNull();
    expect(isConfigAccount(account(named("config"), 1, LEGACY_CONFIG_SPACE))).toBe(true);
    expect(isConfigAccount(account(named("user"), 1))).toBe(false);
  });

  it("builds migrate with the config only when it is passed", async () => {
    const [config] = await findConfigPda();
    const tag = [...createHash("sha256").update("global:migrate").digest().subarray(0, 8)];
    const payer = createNoopSigner(PAYER);
    const target = "So11111111111111111111111111111111111111112" as Address;
    const withConfig = await buildMigrate({ payer, account: target, config });
    expect([...withConfig.data]).toEqual(tag);
    expect(withConfig.accounts.slice(0, 3).map(({ address, role }) => ({ address, role }))).toEqual([
      { address: PAYER, role: AccountRole.WRITABLE_SIGNER },
      { address: target, role: AccountRole.WRITABLE },
      { address: config, role: AccountRole.READONLY },
    ]);
    const without = await buildMigrate({ payer, account: config });
    expect(without.accounts[2]?.address).toBe(INTENT_ENGINE_PROGRAM_ADDRESS);
  });
});
