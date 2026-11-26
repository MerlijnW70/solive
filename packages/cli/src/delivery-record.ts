import type { Address } from "@solana/kit";
import type { Runtime } from "./runtime.js";
import { settingsDir } from "./wallet.js";

export type OwnDelivery = {
  intent: Address;
  sha256: string;
  announcement: Address;
  seq: string;
  signature: string | null;
  slot: string;
  worker: Address;
  cluster: string;
};

export const deliveryBookPath = (home: string, intent: Address): string => `${settingsDir(home)}/delivered/${intent}.json`;

export const recordUnkept = (path: string, reason: string): string =>
  `the announcement is confirmed, but this machine's delivery record ${path} could not be written (${reason}), so a judge on this machine cannot tell this delivery is in flight`;

const HEX64 = /^[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is OwnDelivery => {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["intent"] === "string" &&
    typeof entry["sha256"] === "string" &&
    HEX64.test(entry["sha256"]) &&
    typeof entry["announcement"] === "string" &&
    typeof entry["seq"] === "string" &&
    (entry["signature"] === null || typeof entry["signature"] === "string") &&
    typeof entry["slot"] === "string" &&
    typeof entry["worker"] === "string" &&
    typeof entry["cluster"] === "string"
  );
};

async function keptDeliveries(runtime: Pick<Runtime, "home" | "readText">, intent: Address): Promise<OwnDelivery[]> {
  let text: string;
  try {
    text = await runtime.readText(deliveryBookPath(runtime.home, intent));
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter(isRecord).filter((entry) => entry.intent === intent) : [];
}

export async function ownDeliveries(runtime: Pick<Runtime, "home" | "readText">, intent: Address, cluster: string): Promise<OwnDelivery[]> {
  return (await keptDeliveries(runtime, intent)).filter((entry) => entry.cluster === cluster);
}

export async function ownDelivery(runtime: Pick<Runtime, "home" | "readText">, intent: Address, sha256: string, cluster: string): Promise<OwnDelivery | null> {
  return (await ownDeliveries(runtime, intent, cluster)).find((entry) => entry.sha256 === sha256) ?? null;
}

export async function keepDelivery(runtime: Pick<Runtime, "home" | "readText" | "saveText">, record: OwnDelivery): Promise<string | undefined> {
  const path = deliveryBookPath(runtime.home, record.intent);
  try {
    const kept = (await keptDeliveries(runtime, record.intent)).filter((entry) => entry.announcement !== record.announcement);
    await runtime.saveText(path, `${JSON.stringify([...kept, record], null, 2)}\n`, false);
    return undefined;
  } catch (error) {
    return recordUnkept(path, error instanceof Error ? error.message : String(error));
  }
}
