import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { type Address, isAddress } from "@solana/kit";
import type { PinnedRun } from "./judge-run.js";
import type { Plan } from "./run-plan.js";
import { VIPER_ENGINE_COMMIT, VIPER_WASM_SHA256 } from "./viper.js";
import { settingsDir } from "./wallet.js";

export const RECEIPT_KIND = "judge-receipt";
export const FAIL_RECEIPT_KIND = "judge-fail-receipt";

export type ReceiptKind = typeof RECEIPT_KIND | typeof FAIL_RECEIPT_KIND;
export const RECEIPT_VERSION = 1;
export const RECEIPT_DIR = "receipts";
export const FAIL_RECEIPT_DIR = "fail-receipts";
export const KEY_FILE = "key";
export const KEY_BYTES = 32;
export const MAX_RECEIPT_BYTES = 65_536;
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

const GROUP_OTHER = 0o077;
const GROUP_OTHER_WRITE = 0o022;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;
const SANDBOXES = ["docker", "viper", "none"] as const;

export type Route = { sandbox: (typeof SANDBOXES)[number]; command: string; image?: string; judgeRun?: PinnedRun; engine?: { wasmSha256: string; commit: string } };

export const routeOfPlan = (plan: Plan): Route => ({
  sandbox: plan.sandbox.kind,
  command: plan.run ?? "viper",
  ...(plan.sandbox.kind === "docker" ? { image: plan.sandbox.image } : {}),
  ...(plan.pinned === undefined ? {} : { judgeRun: plan.pinned }),
  ...(plan.sandbox.kind === "viper" ? { engine: { wasmSha256: VIPER_WASM_SHA256, commit: VIPER_ENGINE_COMMIT } } : {}),
});

export type Place = { cluster: string; judge: Address; intent: Address; announcement: Address; deliveredSha256: string };

export type ReceiptOutcome = "pass" | "fail";

export type Receipt = Place & { outcome: "pass"; owner: Address; nonce: bigint; specSha256: string; route: Route };

export type Stored = Omit<Receipt, "outcome"> & { outcome: string };

export type FailReceipt = Omit<Receipt, "outcome"> & { outcome: "fail" };

export type StoreOptions = { uid?: number | undefined; dirUid?: number | undefined };

export type ReceiptProblem = "missing" | "unsafe" | "tampered" | "unwritable";

export class ReceiptRefused extends Error {
  constructor(
    readonly problem: ReceiptProblem,
    readonly why: string,
  ) {
    super(why);
    this.name = "ReceiptRefused";
  }
}

export const receiptsDir = (home: string, kind: ReceiptKind = RECEIPT_KIND): string => join(settingsDir(home), kind === RECEIPT_KIND ? RECEIPT_DIR : FAIL_RECEIPT_DIR);

export const receiptName = (at: Place): string => nameFor(at, RECEIPT_KIND);

const nameFor = (at: Place, kind: ReceiptKind): string =>
  `${createHash("sha256").update(JSON.stringify([kind, at.cluster, at.judge, at.intent, at.announcement, at.deliveredSha256])).digest("hex")}.json`;

export const receiptPath = (home: string, at: Place): string => join(receiptsDir(home), receiptName(at));

const uidOf = (options: StoreOptions): number | undefined => options.uid ?? process.getuid?.();

const dirUidOf = (options: StoreOptions): number | undefined => options.dirUid ?? uidOf(options);

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

const unsafe = (why: string): never => {
  throw new ReceiptRefused("unsafe", why);
};

export const notPrivateDir = (path: string, why: string): string => `the receipt directory ${path} ${why}, so no receipt in it can be trusted`;

async function checkedDir(path: string, uid: number | undefined, loose: number): Promise<void> {
  const found = await lstat(path).catch((error: unknown) => {
    throw codeOf(error) === "ENOENT" ? new ReceiptRefused("missing", `${path} does not exist`) : error;
  });
  if (found.isSymbolicLink()) {
    unsafe(notPrivateDir(path, "is a symbolic link"));
  }
  if (!found.isDirectory()) {
    unsafe(notPrivateDir(path, "is not a directory"));
  }
  if (uid !== undefined && found.uid !== uid) {
    unsafe(notPrivateDir(path, `belongs to user ${found.uid}, not to this user ${uid}`));
  }
  if (uid !== undefined && (found.mode & loose) !== 0) {
    unsafe(notPrivateDir(path, `has mode ${(found.mode & 0o777).toString(8)}, which lets other users write or read it`));
  }
}

async function storeDir(home: string, create: boolean, options: StoreOptions, kind: ReceiptKind = RECEIPT_KIND): Promise<string> {
  const uid = dirUidOf(options);
  const settings = settingsDir(home);
  const dir = receiptsDir(home, kind);
  if (create) {
    await mkdir(settings, { recursive: true, mode: DIR_MODE });
  }
  await checkedDir(settings, uid, GROUP_OTHER_WRITE);
  if (create) {
    await mkdir(dir, { mode: DIR_MODE }).catch((error: unknown) => {
      if (codeOf(error) !== "EEXIST") {
        throw error;
      }
    });
  }
  await checkedDir(dir, uid, GROUP_OTHER);
  return dir;
}

export const notPrivateFile = (path: string, why: string): string => `${path} ${why}, so it is not a receipt this user's judge wrote`;

async function readPrivate(path: string, limit: number, options: StoreOptions): Promise<Buffer> {
  const uid = uidOf(options);
  const found = await lstat(path).catch((error: unknown) => {
    throw codeOf(error) === "ENOENT" ? new ReceiptRefused("missing", `${path} does not exist`) : error;
  });
  if (found.isSymbolicLink()) {
    unsafe(notPrivateFile(path, "is a symbolic link"));
  }
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
    throw codeOf(error) === "ELOOP" ? new ReceiptRefused("unsafe", notPrivateFile(path, "is a symbolic link")) : error;
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      unsafe(notPrivateFile(path, "is not a regular file"));
    }
    if (uid !== undefined && stat.uid !== uid) {
      unsafe(notPrivateFile(path, `belongs to user ${stat.uid}, not to this user ${uid}`));
    }
    if (uid !== undefined && (stat.mode & GROUP_OTHER) !== 0) {
      unsafe(notPrivateFile(path, `has mode ${(stat.mode & 0o777).toString(8)}, which lets other users read or write it`));
    }
    if (stat.size > limit) {
      throw new ReceiptRefused("tampered", notPrivateFile(path, `holds ${stat.size} bytes, more than a receipt's ${limit}`));
    }
    const bytes = await handle.readFile();
    if (bytes.length > limit) {
      throw new ReceiptRefused("tampered", notPrivateFile(path, "grew while it was read"));
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writePrivate(dir: string, bytes: Uint8Array): Promise<string> {
  const temp = join(dir, `.${randomBytes(12).toString("hex")}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, FILE_MODE);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temp, { force: true });
    throw error;
  }
  await handle.close();
  return temp;
}

async function macKey(dir: string, create: boolean, options: StoreOptions): Promise<Buffer> {
  const path = join(dir, KEY_FILE);
  const read = async () => {
    const bytes = await readPrivate(path, KEY_BYTES, options);
    return bytes.length === KEY_BYTES ? bytes : unsafe(notPrivateFile(path, `holds ${bytes.length} bytes, not a ${KEY_BYTES}-byte receipt key`));
  };
  try {
    return await read();
  } catch (error) {
    if (!create || !(error instanceof ReceiptRefused) || error.problem !== "missing") {
      throw error;
    }
  }
  const temp = await writePrivate(dir, randomBytes(KEY_BYTES));
  try {
    await link(temp, path).catch((error: unknown) => {
      if (codeOf(error) !== "EEXIST") {
        throw error;
      }
    });
  } finally {
    await rm(temp, { force: true });
  }
  return read();
}

const macOf = (key: Uint8Array, body: string, kind: ReceiptKind = RECEIPT_KIND): string => createHmac("sha256", key).update(`${kind}\n${body}`).digest("hex");

const routeBody = (route: Route) => ({
  sandbox: route.sandbox,
  command: route.command,
  ...(route.image === undefined ? {} : { image: route.image }),
  ...(route.judgeRun === undefined ? {} : { judge_run: route.judgeRun }),
  ...(route.engine === undefined ? {} : { engine: { wasm_sha256: route.engine.wasmSha256, commit: route.engine.commit } }),
});

const bodyOf = (receipt: Stored, kind: ReceiptKind = RECEIPT_KIND) => ({
  kind,
  version: RECEIPT_VERSION,
  outcome: receipt.outcome,
  cluster: receipt.cluster,
  judge: receipt.judge,
  owner: receipt.owner,
  nonce: receipt.nonce.toString(),
  intent: receipt.intent,
  spec_sha256: receipt.specSha256,
  delivered_sha256: receipt.deliveredSha256,
  announcement: receipt.announcement,
  route: routeBody(receipt.route),
});

export const sealReceipt = (key: Uint8Array, receipt: Stored, kind: ReceiptKind = RECEIPT_KIND): string => {
  const body = JSON.stringify(bodyOf(receipt, kind));
  return `${JSON.stringify({ ...bodyOf(receipt, kind), mac: macOf(key, body, kind) })}\n`;
};

export async function writeReceipt(home: string, receipt: Receipt, options: StoreOptions = {}): Promise<string> {
  if ((receipt.outcome as string) !== "pass") {
    throw new ReceiptRefused("unwritable", `a receipt records only a pass, not ${String(receipt.outcome)}`);
  }
  return writeSealed(home, receipt, RECEIPT_KIND, options);
}

export async function writeFailReceipt(home: string, receipt: FailReceipt, options: StoreOptions = {}): Promise<string> {
  if ((receipt.outcome as string) !== "fail") {
    throw new ReceiptRefused("unwritable", `a fail receipt records only a fail, not ${String(receipt.outcome)}`);
  }
  return writeSealed(home, receipt, FAIL_RECEIPT_KIND, options);
}

async function writeSealed(home: string, receipt: Stored, kind: ReceiptKind, options: StoreOptions): Promise<string> {
  const dir = await storeDir(home, true, options, kind);
  const key = await macKey(dir, true, options);
  const path = join(dir, nameFor(receipt, kind));
  const temp = await writePrivate(dir, Buffer.from(sealReceipt(key, receipt, kind)));
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return path;
}

export async function keptReceipt(home: string, receipt: Receipt | FailReceipt, options: StoreOptions = {}): Promise<{ receipt?: string; receiptRefused?: string }> {
  try {
    return { receipt: receipt.outcome === "fail" ? await writeFailReceipt(home, receipt, options) : await writeReceipt(home, receipt, options) };
  } catch (error) {
    const after = receipt.outcome === "pass" ? "a later attest or vote" : "a later reject";
    return { receiptRefused: `no receipt was saved for this ${receipt.outcome}, so ${after} is refused: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const sameKeys = (value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => key in value);

const ROUTE_KEYS = ["sandbox", "command", "image", "judge_run", "engine"] as const;
const RUN_KEYS = ["image", "run", "timeout", "checkSha256", "memory", "cpus"] as const;
const BODY_KEYS = ["kind", "version", "outcome", "cluster", "judge", "owner", "nonce", "intent", "spec_sha256", "delivered_sha256", "announcement", "route"] as const;

function runOf(value: unknown): PinnedRun | undefined {
  if (!isObject(value) || !sameKeys(value, RUN_KEYS, ["image", "run", "timeout"])) {
    return undefined;
  }
  const strings = RUN_KEYS.filter((key) => key !== "timeout").every((key) => value[key] === undefined || typeof value[key] === "string");
  return strings && typeof value["timeout"] === "number" && Number.isSafeInteger(value["timeout"]) ? (value as PinnedRun) : undefined;
}

function routeOf(value: unknown): Route | undefined {
  if (!isObject(value) || !sameKeys(value, ROUTE_KEYS, ["sandbox", "command"])) {
    return undefined;
  }
  const { sandbox, command, image, judge_run: judgeRun, engine } = value;
  if (!SANDBOXES.includes(sandbox as Route["sandbox"]) || typeof command !== "string" || (image !== undefined && typeof image !== "string")) {
    return undefined;
  }
  const run = judgeRun === undefined ? undefined : runOf(judgeRun);
  const pins = isObject(engine) && sameKeys(engine, ["wasm_sha256", "commit"], ["wasm_sha256", "commit"]) && typeof engine["wasm_sha256"] === "string" && typeof engine["commit"] === "string" ? engine : undefined;
  if ((judgeRun !== undefined && run === undefined) || (engine !== undefined && pins === undefined)) {
    return undefined;
  }
  return {
    sandbox: sandbox as Route["sandbox"],
    command,
    ...(image === undefined ? {} : { image: image as string }),
    ...(run === undefined ? {} : { judgeRun: run }),
    ...(pins === undefined ? {} : { engine: { wasmSha256: pins["wasm_sha256"] as string, commit: pins["commit"] as string } }),
  };
}

export function parsedReceipt(text: string, key: Uint8Array, path: string, kind: ReceiptKind = RECEIPT_KIND): Stored {
  const tampered = (why: string): never => {
    throw new ReceiptRefused("tampered", notPrivateFile(path, why));
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return tampered("is not JSON");
  }
  if (!isObject(parsed) || typeof parsed["mac"] !== "string") {
    return tampered("carries no receipt mac");
  }
  const { mac, ...body } = parsed;
  const want = Buffer.from(macOf(key, JSON.stringify(body), kind), "hex");
  const given = Buffer.from(mac as string, "hex");
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return tampered("does not carry the mac this user's receipt key gives it: it was changed after the judge wrote it, or another key wrote it");
  }
  if (!sameKeys(body, BODY_KEYS, BODY_KEYS) || body["kind"] !== kind || body["version"] !== RECEIPT_VERSION) {
    return tampered(`is not a version ${RECEIPT_VERSION} ${kind}`);
  }
  const addresses = (["cluster", "judge", "owner", "intent", "announcement"] as const).every((name) => typeof body[name] === "string");
  const route = routeOf(body["route"]);
  const sha = (name: string) => typeof body[name] === "string" && SHA256.test(body[name] as string);
  if (!addresses || !isAddress(body["judge"] as string) || !isAddress(body["owner"] as string) || !isAddress(body["intent"] as string) || !isAddress(body["announcement"] as string)) {
    return tampered("names a wallet or account that is not an address");
  }
  if (typeof body["nonce"] !== "string" || !DECIMAL.test(body["nonce"]) || !sha("spec_sha256") || !sha("delivered_sha256") || typeof body["outcome"] !== "string" || route === undefined) {
    return tampered("holds a field that is not in a receipt's form");
  }
  return {
    outcome: body["outcome"],
    cluster: body["cluster"] as string,
    judge: body["judge"] as Address,
    owner: body["owner"] as Address,
    nonce: BigInt(body["nonce"]),
    intent: body["intent"] as Address,
    specSha256: body["spec_sha256"] as string,
    deliveredSha256: body["delivered_sha256"] as string,
    announcement: body["announcement"] as Address,
    route,
  };
}

export async function readReceipt(home: string, at: Place, options: StoreOptions = {}, kind: ReceiptKind = RECEIPT_KIND): Promise<Stored> {
  const dir = await storeDir(home, false, options, kind);
  const key = await macKey(dir, false, options);
  const path = join(dir, nameFor(at, kind));
  const bytes = await readPrivate(path, MAX_RECEIPT_BYTES, options);
  return parsedReceipt(bytes.toString("utf8"), key, path, kind);
}
