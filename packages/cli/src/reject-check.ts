import type { Address } from "@solana/kit";
import type { DeliveryOpeners, Transport } from "@intent-engine/client";
import { loadAnnouncement, opensTo } from "@intent-engine/client/internal";
import { openedBy } from "./announcement-views.js";

export const unopened = (announcement: Address, sha256: string): string =>
  `no key given opens the announcement ${announcement}, so the work it commits to cannot be checked against sha256 ${sha256}; give the judge's key, or its encryption key file; nothing was signed or sent`;

export const otherWork = (announcement: Address, sha256: string): string =>
  `the announcement ${announcement} commits to other work than sha256 ${sha256}; nothing was signed or sent`;

export async function workRefusal(transport: Transport, announcement: Address, sha256: string, openers: DeliveryOpeners): Promise<string | undefined> {
  const view = await loadAnnouncement(transport, announcement);
  if (view === null) {
    return `${announcement} is not an announcement of this program; nothing was signed or sent`;
  }
  const [opened] = await openedBy([view], openers);
  if (opened === undefined) {
    return unopened(announcement, sha256);
  }
  const committed = await opensTo(view, Uint8Array.from(Buffer.from(sha256, "hex")), Uint8Array.from(Buffer.from(opened.salt, "hex")));
  return committed ? undefined : otherWork(announcement, sha256);
}
