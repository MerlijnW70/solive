import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnnouncementView, type SpecFetch, type Transport } from "@intent-engine/client";
import { MAX_SPEC_BYTES, opensTo, PLAIN_HTTP_ON_PUBLIC, plainHttpOnPublic, PUBLIC_GENESIS_HASHES, SPEC_TIMEOUT_MS } from "@intent-engine/client/internal";
import { isLocalWorkUrl } from "@intent-engine/core/internal";
import { hex } from "./announcement-views.js";
import { MAX_ARTIFACT_BYTES, removeCopy } from "./artifact.js";
import { temporaryStatus } from "./fetch-class.js";
import { fetchFailure, lastingFailure, reached } from "./fetch-failure.js";
import { type Lookup, systemLookup } from "./public-address.js";

export const FETCH_CAPS = { watch: MAX_ARTIFACT_BYTES, tools: MAX_SPEC_BYTES } as const;

export const FETCHED_NAME = "artifact";

export const NOT_PUBLIC = "points to a private, loopback or local network address, which a judge on a public cluster does not fetch";

export const WORK_IS_LOCAL = "is local to the worker's machine, so it cannot be fetched; get the file's path from the worker and judge that file by path";

export class DeliveryUnfit extends Error {
  readonly reason: string;

  constructor(url: string, reason: string, options?: ErrorOptions) {
    super(`the work at ${url} ${reason}; it is not judged again`, options);
    this.name = "DeliveryUnfit";
    this.reason = reason;
  }
}

export class DeliveryUnreadable extends Error {
  readonly reason: string;

  constructor(url: string, reason: string, options?: ErrorOptions) {
    super(`the work at ${url} ${reason}; it is fetched again later`, options);
    this.name = "DeliveryUnreadable";
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

async function body(response: Response, url: string, cap: number): Promise<Uint8Array> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const reason = `answered ${response.status}`;
    throw temporaryStatus(response.status) ? new DeliveryUnreadable(url, reason) : new DeliveryUnfit(url, reason);
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

export const UNRESOLVED = "has a host name that could not be looked up";

async function checkedAddresses(transport: Transport, url: URL, lookup: Lookup): Promise<{ addresses?: string[] } | "private" | "unresolved"> {
  if (!PUBLIC_GENESIS_HASHES.has(await transport.genesisHash())) {
    return {};
  }
  return reached(url.hostname, lookup, transport.offline === true);
}

type Checked = { url: URL; addresses: { addresses?: string[] } } | { problem: string; temporary?: true };

async function checkedUrl(transport: Transport, raw: string, lookup: Lookup): Promise<Checked> {
  if (isLocalWorkUrl(raw)) {
    return { problem: WORK_IS_LOCAL };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { problem: "is not a url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { problem: "is not an http or https url" };
  }
  if (await plainHttpOnPublic(transport, raw)) {
    return { problem: PLAIN_HTTP_ON_PUBLIC };
  }
  const addresses = await checkedAddresses(transport, url, lookup);
  if (addresses === "private") {
    return { problem: NOT_PUBLIC };
  }
  if (addresses === "unresolved") {
    return { problem: UNRESOLVED, temporary: true };
  }
  return { url, addresses };
}

type Failed = { problem: string; temporary?: true; cause?: unknown };

function failedFetch(error: unknown): Failed {
  if (error instanceof DeliveryUnfit) {
    return { problem: error.reason };
  }
  if (error instanceof DeliveryUnreadable) {
    return { problem: error.reason, temporary: true };
  }
  const problem = `could not be fetched (${fetchFailure(error)})`;
  return lastingFailure(error) ? { problem, cause: error } : { problem, temporary: true, cause: error };
}

export async function fetchBytes(get: SpecFetch, transport: Transport, url: string, lookup: Lookup = systemLookup, cap: number = FETCH_CAPS.watch): Promise<{ bytes: Uint8Array } | { problem: string; temporary?: true }> {
  const checked = await checkedUrl(transport, url, lookup);
  if ("problem" in checked) {
    return checked;
  }
  try {
    return { bytes: await body(await get(url, { redirect: "error", signal: AbortSignal.timeout(SPEC_TIMEOUT_MS), ...checked.addresses }), url, cap) };
  } catch (error) {
    const { problem, temporary } = failedFetch(error);
    return temporary === true ? { problem, temporary } : { problem };
  }
}

export type Announced = { announcement: AnnouncementView; salt: string; url: string };

export async function fetchDelivery(get: SpecFetch, transport: Transport, delivery: Announced, seconds: number, lookup: Lookup = systemLookup): Promise<Fetched> {
  const checked = await checkedUrl(transport, delivery.url, lookup);
  if ("problem" in checked) {
    throw checked.temporary === true ? new DeliveryUnreadable(delivery.url, checked.problem) : new DeliveryUnfit(delivery.url, checked.problem);
  }
  let bytes: Uint8Array;
  try {
    bytes = await body(await get(delivery.url, { redirect: "error", signal: AbortSignal.timeout(seconds * 1000), ...checked.addresses }), delivery.url, FETCH_CAPS.watch);
  } catch (error) {
    const { problem, temporary, cause } = failedFetch(error);
    throw temporary === true ? new DeliveryUnreadable(delivery.url, problem, { cause }) : new DeliveryUnfit(delivery.url, problem, { cause });
  }
  const digest = createHash("sha256").update(bytes).digest();
  const sha256 = digest.toString("hex");
  if (!(await opensTo(delivery.announcement, Uint8Array.from(digest), Uint8Array.from(Buffer.from(delivery.salt, "hex"))))) {
    throw new DeliveryUnfit(delivery.url, `has sha256 ${sha256}, which the commitment ${hex(delivery.announcement.commitment)} of ${delivery.announcement.worker} does not bind`);
  }
  const root = await mkdtemp(join(tmpdir(), "judge-delivery-"));
  try {
    const path = join(root, fetchedName(checked.url));
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    return { root, path, sha256 };
  } catch (error) {
    await removeCopy(root);
    throw error;
  }
}
