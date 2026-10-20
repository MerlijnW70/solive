import { type Address, createNoopSigner, getAddressDecoder, type Instruction } from "@solana/kit";
import { boardTerms, buildMigrate, findConfigPda, INTENT_ENGINE_PROGRAM_ADDRESS, isConfigAccount, isCurrentAccount, migrationOf, storedVersion } from "@intent-engine/core";
import { rentExemptFor, rentSysvar, type RentSysvar, type Transport } from "@intent-engine/client";
import type { Command } from "./command-types.js";
import type { Runtime } from "./runtime.js";
import { AUTHORITY_NEXT, previewed, unsignedFor } from "./admin-commands.js";
import { transactionSigner } from "./ledger-keys.js";
import { NOT_SENT } from "./flows.js";

type Migrate = Extract<Command, { name: "migrate" }>;
type Listed = { address: Address; data: Uint8Array; lamports: bigint };
type Planned = Listed & { name: string; from: string; topUp: bigint };

export const MIGRATE_BATCH = 8;
const ADMIN_AT = 8;

export const NOTHING_TO_MIGRATE = "nothing to migrate: every engine account is current or needs close-legacy";

const adminOf = (data: Uint8Array): Address => getAddressDecoder().decode(data.slice(ADMIN_AT, ADMIN_AT + 32));

async function listed(command: Migrate, transport: Transport): Promise<Listed[]> {
  if (command.address !== null) {
    const view = await transport.getAccount(command.address);
    if (view === null) {
      throw new Error(`${command.address} does not exist`);
    }
    if (view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS) {
      throw new Error(`${command.address} is not an engine account; migrate rewrites only accounts the engine program owns`);
    }
    return [{ address: command.address, data: view.data, lamports: view.lamports }];
  }
  if (transport.engineAccounts === undefined) {
    throw new Error("this connection cannot list program accounts; migrate them one by one with --address");
  }
  return transport.engineAccounts();
}

function unread(entry: Listed): string {
  const stored = storedVersion(entry.data);
  return stored === null
    ? `engine account of ${entry.data.length} bytes that matches no account type; close it with intent-engine close-legacy`
    : `${stored.layout.name} account in a layout no program version wrote: version ${stored.version}, ${entry.data.length} bytes; close it with intent-engine close-legacy`;
}

const countBy = (names: readonly string[]): Record<string, number> =>
  Object.fromEntries([...new Set(names)].sort().map((name) => [name, names.filter((n) => n === name).length]));

const batchesOf = <T>(items: readonly T[]): T[][] =>
  Array.from({ length: Math.ceil(items.length / MIGRATE_BATCH) }, (_, i) => items.slice(i * MIGRATE_BATCH, (i + 1) * MIGRATE_BATCH));

const topUpFor = (rent: RentSysvar, entry: Listed, from: number, to: number): bigint => {
  const newMin = rentExemptFor(rent, to);
  const grown = entry.lamports + newMin - rentExemptFor(rent, from);
  const floor = newMin + (boardTerms(entry.data)?.held ?? 0n);
  const target = grown > floor ? grown : floor;
  return target > entry.lamports ? target - entry.lamports : 0n;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function migrate(command: Migrate, runtime: Runtime, transport: Transport): Promise<object> {
  const payer = await transactionSigner(runtime, command.keypair);
  const [config] = await findConfigPda();
  const found = await listed(command, transport);
  const current = found.filter((entry) => isCurrentAccount(entry.data));
  const outdated = found.filter((entry) => !isCurrentAccount(entry.data));
  const unmigrated = outdated.filter((entry) => migrationOf(entry.data) === null).map((entry) => ({ address: entry.address, reason: unread(entry) }));
  const one = command.address === null ? null : (found[0] ?? null);
  if (one !== null && current.length > 0) {
    throw new Error(`${one.address} is a current ${storedVersion(one.data)?.layout.name ?? "engine"} account; there is nothing to migrate`);
  }
  if (one !== null && unmigrated.length > 0) {
    throw new Error(`${one.address} cannot migrate: ${unread(one)}`);
  }
  const rent = await rentSysvar(transport);
  const planned: Planned[] = outdated.flatMap((entry) => {
    const migration = migrationOf(entry.data);
    if (migration === null) {
      return [];
    }
    const { layout, from } = migration;
    const topUp = from.space < layout.space ? topUpFor(rent, entry, from.space, layout.space) : 0n;
    const view = `${layout.name} account: version ${from.version}, ${from.space} bytes -> version ${layout.version}, ${layout.space} bytes`;
    return [{ ...entry, name: layout.name, from: view, topUp }];
  });
  const configEntry = planned.find((entry) => isConfigAccount(entry.data));
  const admin = configEntry === undefined ? null : adminOf(configEntry.data);
  const byPayer = planned.filter((entry) => entry !== configEntry || admin === payer.address);
  const proposal =
    admin === null || admin === payer.address
      ? null
      : await unsignedFor(transport, admin, [await buildMigrate({ payer: createNoopSigner(admin), account: config })]);
  const instructions: Instruction[] = await Promise.all(
    byPayer.map((entry) => buildMigrate({ payer, account: entry.address, ...(isConfigAccount(entry.data) ? {} : { config }) })),
  );
  const batches = batchesOf(instructions);
  const topUp = byPayer.reduce((sum, entry) => sum + entry.topUp, 0n);
  const configTopUp = configEntry?.topUp ?? 0n;
  const adminTopUp = proposal === null ? 0n : configTopUp;
  const counts = countBy(byPayer.map((entry) => entry.name));
  const summary = [
    one === null
      ? `Migrates ${byPayer.length} outdated engine accounts in ${batches.length} transactions: ${Object.entries(counts).map(([name, n]) => `${n} ${name}`).join(", ") || "none"}`
      : `Migrates ${one.address}, an outdated ${planned[0]?.from ?? "engine account"}`,
    ...(topUp === 0n ? [] : [`Pays ${topUp} lamports of rent from ${payer.address} for the accounts that grow; no account loses lamports`]),
    ...(one === null ? [`Skips ${current.length} accounts that are already current`] : []),
    ...(unmigrated.length === 0 ? [] : [`Cannot migrate ${unmigrated.length} accounts of a layout no program version wrote; close them with intent-engine close-legacy`]),
    ...(proposal === null
      ? []
      : [
          `Only the admin ${admin} migrates the config: import config_proposal.transaction_base58 into the multisig as a proposal`,
          ...(adminTopUp === 0n ? [] : [`The admin ${admin} pays ${adminTopUp} lamports of rent for the config and must hold them before the proposal executes`]),
        ]),
  ];
  const shown = {
    payer: payer.address,
    migrate: counts,
    current: current.length,
    unmigrated,
    top_up_lamports: topUp + adminTopUp,
    ...(configEntry === undefined ? {} : { config: { address: configEntry.address, admin, top_up_lamports: configTopUp } }),
    transactions: batches.length,
    ...(proposal === null ? {} : { config_proposal: proposal }),
    summary,
  };
  if (instructions.length === 0) {
    return { ...shown, sent: false, next: proposal === null ? NOTHING_TO_MIGRATE : AUTHORITY_NEXT };
  }
  if (one !== null) {
    return previewed(transport, instructions, payer, shown, command.yes);
  }
  if (!command.yes) {
    return { ...shown, sent: false, next: NOT_SENT };
  }
  const signatures: string[] = [];
  const failed: { accounts: Address[]; error: string }[] = [];
  for (const [at, batch] of batches.entries()) {
    const accounts = byPayer.slice(at * MIGRATE_BATCH, at * MIGRATE_BATCH + batch.length).map((entry) => entry.address);
    try {
      signatures.push(await transport.send(batch, payer));
    } catch (error) {
      failed.push({ accounts, error: errorText(error) });
    }
  }
  return { ...shown, sent: true, signatures, failed };
}
