import { createHash } from "node:crypto";
import { type Address, getAddressDecoder } from "@solana/kit";
import {
  type Config,
  findConfigPda,
  findProgramDataAddress,
  getConfigDecoder,
  getConfigDiscriminatorBytes,
  INTENT_ENGINE_PROGRAM_ADDRESS,
} from "@intent-engine/core";
import { type AccountView, CLOCK_SYSVAR, loadMintCap, type Transport } from "@intent-engine/client";
import { UsageError } from "./arg-values.js";
import type { MonitorSpec } from "./command-types.js";
import { fillsIn, inputMintsOf } from "./monitor-fills.js";
import { capChanges, type Floors, floorChanges, floorsOf, isFloors, isMintCaps, type MintCaps, mintCapsOf } from "./monitor-limits.js";
import { printableLines, redactUrl, render } from "./render.js";
import type { Runtime } from "./runtime.js";

export const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
export const PROGRAM_DATA_HEADER = 45;
export const STALL_INTERVALS = 3;
export const MONITOR_SCAN = 100;

export const CONFIG_FIELDS = [
  "admin",
  "pendingAdmin",
  "guardian",
  "feeRecipient",
  "feeBps",
  "kindFeeMask",
  "kindFeeBps",
  "partnerCutBps",
  "crankBounty",
  "createFee",
  "enabledKinds",
  "fillDisabledKinds",
  "paused",
  "capsRequired",
  "version",
  "domain",
] as const;

type ConfigField = (typeof CONFIG_FIELDS)[number];
type Value = string | number | number[];
type ConfigValues = Record<ConfigField, Value>;

export type Baseline = {
  program: Address;
  config: ConfigValues;
  committeeFloors: Floors;
  mintCaps: MintCaps;
  upgradeAuthority: string;
  programHash: string;
};

export type Snapshot = {
  slot: bigint;
  config: ConfigValues | null;
  committeeFloors: Floors | null;
  mintCaps: MintCaps;
  upgradeAuthority: string | null;
  programHash: string | null;
};

export type AlertKind =
  | "config"
  | "upgrade-authority"
  | "program-hash"
  | "fill-amount"
  | "fill-rate"
  | "mint-cap"
  | "committee-floor"
  | "mint-cap-limit"
  | "rpc";

export type Alert = { kind: AlertKind; field: string; expected: unknown; observed: unknown; slot: number | null } & Record<string, unknown>;

type Io = { out(text: string): void; err(text: string): void };

export const NO_AUTHORITY = "none";
export const MISSING = "missing";

export const baselineExists = (file: string) =>
  `${file} already exists; --write-baseline never overwrites a baseline, so move the old one away first`;

export const notABaseline = (file: string) =>
  `--expect ${file} is not a monitor baseline; write one with monitor --write-baseline <file>`;

export const otherProgram = (file: string, program: string) =>
  `--expect ${file} is a baseline for program ${program}, not ${INTENT_ENGINE_PROGRAM_ADDRESS}; write a new one with monitor --write-baseline <file>`;

const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);

function decodedConfig(view: AccountView | null | undefined): Config | null {
  const discriminator = getConfigDiscriminatorBytes();
  if (view === null || view === undefined || view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS || !sameBytes(view.data.subarray(0, discriminator.length), discriminator)) {
    return null;
  }
  try {
    return getConfigDecoder().decode(view.data);
  } catch {
    return null;
  }
}

function configValues(c: Config): ConfigValues {
  return {
    admin: c.admin,
    pendingAdmin: c.pendingAdmin,
    guardian: c.guardian,
    feeRecipient: c.feeRecipient,
    feeBps: c.feeBps,
    kindFeeMask: c.kindFeeMask,
    kindFeeBps: [...c.kindFeeBps],
    partnerCutBps: c.partnerCutBps,
    crankBounty: c.crankBounty,
    createFee: c.createFee,
    enabledKinds: c.enabledKinds.toString(),
    fillDisabledKinds: c.fillDisabledKinds.toString(),
    paused: c.paused,
    capsRequired: c.capsRequired,
    version: c.version,
    domain: [...c.domain],
  };
}

export function executableHash(data: Uint8Array): string {
  let end = data.length;
  while (end > PROGRAM_DATA_HEADER && data[end - 1] === 0) {
    end--;
  }
  return createHash("sha256").update(data.subarray(PROGRAM_DATA_HEADER, end)).digest("hex");
}

const u32 = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);

function programState(program: AccountView | null | undefined, data: AccountView | null | undefined, programData: Address) {
  const linked =
    program !== null &&
    program !== undefined &&
    program.owner === LOADER &&
    program.data.length >= 36 &&
    u32(program.data) === 2 &&
    getAddressDecoder().decode(program.data.subarray(4, 36)) === programData;
  if (!linked || data === null || data === undefined || data.owner !== LOADER || data.data.length < PROGRAM_DATA_HEADER || u32(data.data) !== 3) {
    return { upgradeAuthority: null, programHash: null };
  }
  const upgradeAuthority = data.data[12] === 1 ? getAddressDecoder().decode(data.data.subarray(13, PROGRAM_DATA_HEADER)) : NO_AUTHORITY;
  return { upgradeAuthority, programHash: executableHash(data.data) };
}

export async function snapshot(transport: Transport): Promise<Snapshot> {
  const [configAddress] = await findConfigPda();
  const programData = await findProgramDataAddress();
  const [clock, config, program, data] = await transport.getAccounts([CLOCK_SYSVAR, configAddress, INTENT_ENGINE_PROGRAM_ADDRESS, programData]);
  if (clock === null || clock === undefined || clock.data.length < 8) {
    throw new Error("the node returned no clock, so it cannot say which slot it has reached");
  }
  const slot = new DataView(clock.data.buffer, clock.data.byteOffset, clock.data.byteLength).getBigUint64(0, true);
  const decoded = decodedConfig(config);
  return {
    slot,
    config: decoded === null ? null : configValues(decoded),
    committeeFloors: decoded === null ? null : floorsOf(decoded),
    mintCaps: await mintCapsOf(transport),
    ...programState(program, data, programData),
  };
}

export function baselineOf(now: Snapshot): Baseline {
  if (now.config === null || now.committeeFloors === null || now.upgradeAuthority === null || now.programHash === null) {
    throw new Error(`cannot write a baseline: the config or the upgradeable program ${INTENT_ENGINE_PROGRAM_ADDRESS} is missing on this cluster`);
  }
  return {
    program: INTENT_ENGINE_PROGRAM_ADDRESS,
    config: now.config,
    committeeFloors: now.committeeFloors,
    mintCaps: now.mintCaps,
    upgradeAuthority: now.upgradeAuthority,
    programHash: now.programHash,
  };
}

const isValue = (v: unknown) =>
  typeof v === "string" || (typeof v === "number" && Number.isInteger(v)) || (Array.isArray(v) && v.every((x) => Number.isInteger(x)));

export function parseBaseline(text: string, file: string): Baseline {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UsageError(notABaseline(file));
  }
  const b = json as Partial<Baseline> | null;
  const config = b?.config as Record<string, unknown> | undefined;
  if (
    b === null ||
    typeof b !== "object" ||
    typeof b.program !== "string" ||
    typeof b.upgradeAuthority !== "string" ||
    typeof b.programHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(b.programHash) ||
    config === null ||
    typeof config !== "object" ||
    Object.keys(config).length !== CONFIG_FIELDS.length ||
    !CONFIG_FIELDS.every((field) => isValue(config[field])) ||
    !isFloors(b.committeeFloors) ||
    !isMintCaps(b.mintCaps)
  ) {
    throw new UsageError(notABaseline(file));
  }
  if (b.program !== INTENT_ENGINE_PROGRAM_ADDRESS) {
    throw new UsageError(otherProgram(file, b.program));
  }
  return b as Baseline;
}

export async function writeBaseline(file: string, runtime: Runtime, transport: Transport): Promise<object> {
  const exists = await runtime.readText(file).then(
    () => true,
    () => false,
  );
  if (exists) {
    throw new UsageError(baselineExists(file));
  }
  const baseline = baselineOf(await snapshot(transport));
  await runtime.writeText(file, `${render(baseline)}\n`);
  return { wrote: file, ...baseline };
}

export async function readBaseline(file: string, runtime: Runtime): Promise<Baseline> {
  let text: string;
  try {
    text = await runtime.readText(file);
  } catch {
    throw new UsageError(`--expect ${file} cannot be read; write it with monitor --write-baseline <file>`);
  }
  return parseBaseline(text, file);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export type MonitorState = {
  alerted: Map<string, string>;
  lastSlot: bigint | null;
  stalledFor: number;
  failing: boolean;
  seen: Set<string> | null;
};

export const freshState = (): MonitorState => ({ alerted: new Map(), lastSlot: null, stalledFor: 0, failing: false, seen: null });

type Finding = { key: string; alert: Alert };

export function capStatus(mint: Address, cap: { outstanding: bigint; totalLimit: bigint } | null): string {
  if (cap === null) {
    return `${mint} has no mint cap`;
  }
  const limit = cap.totalLimit === 0n ? "no total limit" : `a total limit of ${cap.totalLimit}`;
  return `mint cap of ${mint}: ${cap.outstanding} raw units outstanding, ${limit}`;
}

async function capFindings(transport: Transport, spec: MonitorSpec, slot: bigint): Promise<Finding[]> {
  const found: Finding[] = [];
  for (const mint of spec.maxFill.keys()) {
    const cap = (await loadMintCap(transport, mint))?.cap;
    if (cap !== undefined && cap.totalLimit > 0n && cap.outstanding >= cap.totalLimit) {
      found.push({
        key: `mintCap.${mint}`,
        alert: { kind: "mint-cap", field: mint, expected: `below ${cap.totalLimit}`, observed: cap.outstanding.toString(), slot: Number(slot) },
      });
    }
  }
  return found;
}

function differences(baseline: Baseline, now: Snapshot): Finding[] {
  const slot = Number(now.slot);
  const found: Finding[] = [];
  const compare = (key: string, kind: AlertKind, field: string, expected: unknown, observed: unknown) => {
    if (!same(expected, observed)) {
      found.push({ key, alert: { kind, field, expected, observed, slot } });
    }
  };
  if (now.config === null) {
    compare("config", "config", "config", "present", MISSING);
  } else {
    for (const field of CONFIG_FIELDS) {
      compare(`config.${field}`, "config", field, baseline.config[field], now.config[field]);
    }
  }
  const limits = [...(now.committeeFloors === null ? [] : floorChanges(baseline.committeeFloors, now.committeeFloors)), ...capChanges(baseline.mintCaps, now.mintCaps, MISSING)];
  for (const { key, kind, field, mint, expected, observed } of limits) {
    found.push({ key, alert: { kind, field, expected, observed, slot, mint } });
  }
  compare("upgradeAuthority", "upgrade-authority", "upgradeAuthority", baseline.upgradeAuthority, now.upgradeAuthority ?? MISSING);
  compare("programHash", "program-hash", "programHash", baseline.programHash, now.programHash ?? MISSING);
  return found;
}

function stateAlerts(found: Finding[], state: MonitorState): Alert[] {
  const keys = new Set(found.map((f) => f.key));
  for (const key of [...state.alerted.keys()]) {
    if (!keys.has(key)) {
      state.alerted.delete(key);
    }
  }
  const fresh: Alert[] = [];
  for (const { key, alert } of found) {
    const observed = JSON.stringify(alert.observed);
    if (state.alerted.get(key) !== observed) {
      state.alerted.set(key, observed);
      fresh.push(alert);
    }
  }
  return fresh;
}

function slotAlerts(now: Snapshot, state: MonitorState): Alert[] {
  if (state.lastSlot === null || now.slot > state.lastSlot) {
    state.lastSlot = now.slot;
    state.stalledFor = 0;
    return [];
  }
  state.stalledFor++;
  if (state.stalledFor !== STALL_INTERVALS) {
    return [];
  }
  const slot = Number(state.lastSlot);
  return [{ kind: "rpc", field: "slot", expected: `a slot above ${slot}`, observed: Number(now.slot), slot, intervals: STALL_INTERVALS }];
}

async function fillAlerts(transport: Transport, spec: MonitorSpec, state: MonitorState, since: bigint): Promise<Alert[]> {
  if (spec.maxFill.size === 0 && spec.maxFills === null) {
    return [];
  }
  const limit = Math.max(MONITOR_SCAN, (spec.maxFills ?? 0) + 1);
  const fetched = await transport.engineTransactions(limit);
  const seen = state.seen;
  const fresh = fetched.filter((tx) => (seen === null ? tx.blockTime !== null && tx.blockTime >= since : !seen.has(tx.signature)));
  state.seen = new Set([...(seen ?? []), ...fetched.map((tx) => tx.signature)].slice(-limit * 4));
  const { fills, known } = fillsIn(fresh);
  const alerts: Alert[] = [];
  if (spec.maxFill.size > 0 && fills.length > 0) {
    const mints = await inputMintsOf(transport, fills, known);
    for (const fill of fills) {
      const mint = mints.get(fill.intent);
      const cap = mint === undefined ? undefined : spec.maxFill.get(mint);
      const where = { slot: Number(fill.slot), intent: fill.intent, signature: fill.signature };
      if (mint === undefined) {
        alerts.push({ kind: "fill-amount", field: "inputMint", expected: "a readable input mint", observed: MISSING, ...where, amountIn: fill.amountIn.toString() });
      } else if (cap !== undefined && fill.amountIn > cap) {
        alerts.push({ kind: "fill-amount", field: mint, expected: cap.toString(), observed: fill.amountIn.toString(), ...where });
      }
    }
  }
  const gap = seen !== null && fetched.length >= limit && fresh.length === fetched.length;
  const burst = gap || (spec.maxFills !== null && fills.length > spec.maxFills);
  if (burst) {
    const slot = (gap ? fresh : fills).reduce((top, { slot: at }) => (at > top ? at : top), 0n);
    alerts.push({
      kind: "fill-rate",
      field: gap ? "transactions" : "fills",
      expected: gap ? `fewer than ${limit} engine transactions per interval` : spec.maxFills,
      observed: gap ? `${limit} or more` : fills.length,
      slot: Number(slot),
      interval: spec.interval,
    });
  }
  return alerts;
}

const scrubbed = (text: string, url: string) => printableLines(text.split(url).join(redactUrl(url)));

export async function checkOnce(
  transport: Transport,
  baseline: Baseline,
  spec: MonitorSpec,
  state: MonitorState,
  now: bigint,
  url: string,
): Promise<Alert[]> {
  let alerts: Alert[];
  try {
    const current = await snapshot(transport);
    alerts = [
      ...stateAlerts([...differences(baseline, current), ...(await capFindings(transport, spec, current.slot))], state),
      ...slotAlerts(current, state),
      ...(await fillAlerts(transport, spec, state, now - BigInt(spec.since))),
    ];
  } catch (error) {
    if (state.failing) {
      return [];
    }
    state.failing = true;
    const message = error instanceof Error ? error.message : String(error);
    const slot = state.lastSlot === null ? null : Number(state.lastSlot);
    return [{ kind: "rpc", field: "read", expected: "a successful read", observed: scrubbed(message, url), slot, rpc: redactUrl(url) }];
  }
  state.failing = false;
  return alerts;
}

export const line = (alert: Alert) => JSON.stringify(alert, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

async function post(webhook: string, body: string, runtime: Runtime, io: Io): Promise<void> {
  const where = redactUrl(webhook);
  try {
    const reply = await runtime.fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body });
    if (!reply.ok) {
      io.err(`the webhook at ${where} answered ${reply.status}; the alert is on stdout`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`the webhook at ${where} failed: ${scrubbed(message, webhook)}; the alert is on stdout`);
  }
}

export async function monitor(url: string, file: string, spec: MonitorSpec, runtime: Runtime, transport: Transport, io: Io): Promise<number> {
  const baseline = await readBaseline(file, runtime);
  const state = freshState();
  io.err(
    `watching program ${INTENT_ENGINE_PROGRAM_ADDRESS} on ${redactUrl(url)} every ${spec.interval}s` +
      (spec.webhook === null ? "" : `; alerts also go to ${redactUrl(spec.webhook)}`),
  );
  for (const mint of spec.maxFill.keys()) {
    try {
      io.err(capStatus(mint, (await loadMintCap(transport, mint))?.cap ?? null));
    } catch (error) {
      io.err(`the mint cap of ${mint} cannot be read: ${scrubbed(error instanceof Error ? error.message : String(error), url)}`);
    }
  }
  let raised = 0;
  for (;;) {
    for (const alert of await checkOnce(transport, baseline, spec, state, runtime.now(), url)) {
      const text = line(alert);
      io.out(text);
      raised++;
      if (spec.webhook !== null) {
        await post(spec.webhook, text, runtime, io);
      }
    }
    if (spec.once || !(await runtime.sleep(spec.interval))) {
      return raised;
    }
  }
}
