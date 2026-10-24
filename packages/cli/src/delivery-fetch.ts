import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnnouncementView, opensTo, PLAIN_HTTP_ON_PUBLIC, plainHttpOnPublic, PUBLIC_GENESIS_HASHES, SPEC_TIMEOUT_MS, type SpecFetch, type Transport } from "@intent-engine/client";
import { hex } from "./announcement-views.js";
import { MAX_ARTIFACT_BYTES } from "./artifact.js";
import { type Lookup, publicAddresses, systemLookup } from "./public-address.js";

export const FETCHED_NAME = "artifact";

export const NOT_PUBLIC = "points to a private, loopback or local network address, which a judge on a public cluster does not fetch";

export class DeliveryUnfit extends Error {
  readonly reason: string;

  constructor(url: string, reason: string) {
    super(`the work at ${url} ${reason}; it is not judged again`);
    this.name = "DeliveryUnfit";
    this.reason = reason;
  }
}

export type Fetched = { root: string; path: string; sha256: string };

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export const fetchedName = (url: URL): string => {
  const last = url.pathname.split("/").pop() ?? "";
  return SAFE_NAME.test(last) ? last : FETCHED_NAME;
};

export const tooLarge = (cap: number): string => `is larger than ${cap} bytes`;

async function body(response: Response, url: string, cap = MAX_ARTIFACT_BYTES): Promise<Uint8Array> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new DeliveryUnfit(url, `answered ${response.status}`);
  }
  if (Number(response.headers.get("content-length") ?? "0") > cap) {
    await response.body?.cancel().catch(() => undefined);
    throw new DeliveryUnfit(url, tooLarge(cap));
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let next = await reader?.read(); next !== undefined && next.done !== true; next = await reader?.read()) {
    size += next.value.length;
    if (size > cap) {
      await reader?.cancel();
      throw new DeliveryUnfit(url, tooLarge(cap));
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}

async function checkedAddresses(transport: Transport, url: URL, lookup: Lookup): Promise<{ addresses?: string[] } | null> {
  if (!PUBLIC_GENESIS_HASHES.has(await transport.genesisHash())) {
    return {};
  }
  const addresses = await publicAddresses(url.hostname, lookup);
  return addresses === null ? null : { addresses };
}

export async function fetchSha256(get: SpecFetch, transport: Transport, url: string, lookup: Lookup = systemLookup): Promise<{ sha256: string } | { problem: string }> {
  const found = await fetchBytes(get, transport, url, lookup);
  return "problem" in found ? found : { sha256: createHash("sha256").update(found.bytes).digest("hex") };
}

export async function fetchBytes(get: SpecFetch, transport: Transport, url: string, lookup: Lookup = systemLookup, cap = MAX_ARTIFACT_BYTES): Promise<{ bytes: Uint8Array } | { problem: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { problem: "is not a url" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { problem: "is not an http or https url" };
  }
  if (await plainHttpOnPublic(transport, url)) {
    return { problem: PLAIN_HTTP_ON_PUBLIC };
  }
  const addresses = await checkedAddresses(transport, parsed, lookup);
  if (addresses === null) {
    return { problem: NOT_PUBLIC };
  }
  try {
    return { bytes: await body(await get(url, { redirect: "error", signal: AbortSignal.timeout(SPEC_TIMEOUT_MS), ...addresses }), url, cap) };
  } catch (error) {
    return { problem: error instanceof DeliveryUnfit ? error.reason : `could not be fetched (${fetchFailure(error)})` };
  }
}

const fetchFailure = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  return cause === "" ? message : `${message}: ${cause}`;
};

export type Announced = { announcement: AnnouncementView; salt: string; url: string };

export async function fetchDelivery(get: SpecFetch, transport: Transport, delivery: Announced, seconds: number, lookup: Lookup = systemLookup): Promise<Fetched> {
  let url: URL;
  try {
    url = new URL(delivery.url);
  } catch {
    throw new DeliveryUnfit(delivery.url, "is not a url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DeliveryUnfit(delivery.url, "is not an http or https url");
  }
  if (await plainHttpOnPublic(transport, delivery.url)) {
    throw new DeliveryUnfit(delivery.url, PLAIN_HTTP_ON_PUBLIC);
  }
  const addresses = await checkedAddresses(transport, url, lookup);
  if (addresses === null) {
    throw new DeliveryUnfit(delivery.url, NOT_PUBLIC);
  }
  let bytes: Uint8Array;
  try {
    bytes = await body(await get(delivery.url, { redirect: "error", signal: AbortSignal.timeout(seconds * 1000), ...addresses }), delivery.url);
  } catch (error) {
    if (error instanceof DeliveryUnfit) {
      throw error;
    }
    throw new DeliveryUnfit(delivery.url, `could not be fetched: ${error instanceof Error ? error.message : String(error)}`);
  }
  const digest = createHash("sha256").update(bytes).digest();
  const sha256 = digest.toString("hex");
  if (!(await opensTo(delivery.announcement, Uint8Array.from(digest), Uint8Array.from(Buffer.from(delivery.salt, "hex"))))) {
    throw new DeliveryUnfit(delivery.url, `has sha256 ${sha256}, which the commitment ${hex(delivery.announcement.commitment)} of ${delivery.announcement.worker} does not bind`);
  }
  const root = await mkdtemp(join(tmpdir(), "judge-delivery-"));
  const path = join(root, fetchedName(url));
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  return { root, path, sha256 };
}
