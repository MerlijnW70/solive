import { type Address, getBase58Decoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { ACCOUNT_LAYOUTS } from "@intent-engine/core/internal";
import type { EngineTransaction, ListedSignature, Transport } from "@intent-engine/client";
import { svmTransport } from "@intent-engine/client/svm";
import { testSignature } from "@intent-engine/client/testing";
import { heldPastLimit, heldReadsSpent, loadAnnouncement, releaseUnread, SIGNATURE_PAGE } from "@intent-engine/client/internal";
import { HELD_UNSURE, NOTHING_HELD as CLI_NOTHING_HELD } from "../src/announce-commands.js";
import { heldIncomplete } from "../src/agent/wallet/held.js";
import { NOTHING_HELD } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { call, connect, ok, preset } from "./agent-wallet-kit.js";
import { keyed } from "./announce.js";
import { heldRelease, keyOf } from "./held-kit.js";
import { cli, DOMAIN, h, world } from "./harness.js";

const WORK = "6d".repeat(32);
const RELEASES = 7;
const PADDING = 3 * SIGNATURE_PAGE + 17;
const VERSION_AT = 8 + (ACCOUNT_LAYOUTS.find((layout) => layout.name === "announcement")?.versionAt ?? 0);
const UNREAD = heldIncomplete([]);

type Routed = { through: Transport; hidden: Set<Address>; padded: Map<Address, ListedSignature[]>; fake: Set<string> };

async function routed(): Promise<Routed> {
  await world();
  const through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
  const hidden = new Set<Address>();
  const padded = new Map<Address, ListedSignature[]>();
  const fake = new Set<string>();
  const signatures = through.signaturesOf as NonNullable<Transport["signaturesOf"]>;
  const transactions = through.transactionsOf as NonNullable<Transport["transactionsOf"]>;
  h.through = {
    ...through,
    signaturesOf: async (of, limit, before, until) => {
      if (hidden.has(of)) {
        return [];
      }
      const all = padded.get(of);
      if (all === undefined) {
        return signatures.call(through, of, limit, before, until);
      }
      const from = before === undefined ? 0 : all.findIndex(({ signature }) => signature === before) + 1;
      return all.slice(from, from + limit);
    },
    transactionsOf: async (listed) => [
      ...(await transactions.call(through, listed.filter(({ signature }) => !fake.has(signature)))),
      ...listed.filter(({ signature }) => fake.has(signature)).map(({ signature }): EngineTransaction => ({ signature, slot: 1n, blockTime: null, failed: false, emitted: [] })),
    ],
  };
  return { through, hidden, padded, fake };
}

async function pad(made: Routed, announcement: Address): Promise<void> {
  const paidAt = (await loadAnnouncement(made.through, announcement))?.paidAt ?? 0n;
  const own = await (made.through.signaturesOf as NonNullable<Transport["signaturesOf"]>).call(made.through, announcement, SIGNATURE_PAGE);
  const newer = Array.from({ length: PADDING }, (_, i): ListedSignature => ({ signature: testSignature(`pad ${i}`), slot: 1n, blockTime: paidAt + 1n + BigInt(i % 7), failed: false, memo: null }));
  for (const { signature } of newer) {
    made.fake.add(signature);
  }
  made.padded.set(announcement, [...newer, ...own]);
}

function newerVersion(account: Address): void {
  const view = h.svm.getAccount(account);
  if (!view.exists) {
    throw new Error("announcement missing");
  }
  const data = new Uint8Array(view.data);
  data[VERSION_AT] = 255;
  h.svm.setAccount({ ...view, data });
}

async function walletServer(): Promise<{ client: Awaited<ReturnType<typeof connect>>; wallet: Address }> {
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  const client = await connect(["mcp", "--url", "devnet", "--wallet"]);
  return { client, wallet: (await ok(client, "wallet_setup"))["address"] as Address };
}

describe("a held share read that stops short", () => {
  it("says the MCP list is incomplete, keeps the past-limit reason, and advises raising announcements only when that limited it", async () => {
    const made = await routed();
    const { client } = await walletServer();
    expect(await ok(client, "wallet_claim_held")).toMatchObject({ shares: [], complete: true, summary: [], next: NOTHING_HELD });
    for (let i = 0; i < RELEASES; i++) {
      made.hidden.add((await heldRelease(await keyed(), WORK, made.through)).announcement);
    }
    const narrow = await ok(client, "wallet_claim_held", { announcements: RELEASES - 1 });
    expect(narrow).toMatchObject({ shares: [], complete: false, sent: false, next: heldIncomplete(["announcements"]) });
    const summary = narrow["summary"] as string[];
    expect(summary).toHaveLength(6);
    expect(summary[0]).toBe(heldPastLimit(1, RELEASES - 1));
    expect(summary.at(-1)).toBe("2 more announcements could not be read in full, so their held shares are not listed");
    expect(summary.slice(1, -1).every((reason) => [...made.hidden].some((announcement) => reason === releaseUnread(announcement)))).toBe(true);
    const wide = await ok(client, "wallet_claim_held", { announcements: RELEASES });
    expect([wide["complete"], wide["next"], (wide["summary"] as string[]).includes(heldPastLimit(1, RELEASES - 1))]).toEqual([false, UNREAD, false]);
    expect(UNREAD).not.toContain("raise");
    expect((await call(client, "wallet_claim_held", { announcements: 0 })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "announcements" }] });
  });

  it("passes reads to the client and advises raising them only when the read budget ran out", async () => {
    const made = await routed();
    const { client, wallet } = await walletServer();
    const held = await heldRelease(await keyOf(wallet), WORK, made.through);
    await pad(made, held.announcement);
    const short = await ok(client, "wallet_claim_held", { reads: 1 });
    expect(short).toMatchObject({ shares: [], complete: false, next: heldIncomplete(["reads"]), summary: [heldReadsSpent(held.announcement, 1)] });
    expect(await ok(client, "wallet_claim_held")).toMatchObject({ complete: true, shares: [{ announcement: held.announcement }] });
  });

  it("says an undecodable announcement left the MCP list incomplete without advising wider bounds", async () => {
    const made = await routed();
    const { client } = await walletServer();
    newerVersion((await heldRelease(await keyed(), WORK, made.through)).announcement);
    const listed = await ok(client, "wallet_claim_held");
    expect(listed).toMatchObject({ shares: [], complete: false, next: UNREAD, summary: ["1 announcement accounts could not be decoded, so their held shares are not listed"] });
  });

  it("says the CLI list is incomplete instead of nothing held, with the reasons and the undecodable accounts", async () => {
    const made = await routed();
    const coauthor = await keyed("coauthor.json");
    expect((await cli(["claim-held", "--keypair", "coauthor.json"], {})).json()).toMatchObject({ shares: [], complete: true, next: CLI_NOTHING_HELD });
    const first = await heldRelease(coauthor, WORK, made.through);
    made.hidden.add(first.announcement);
    const listed = await cli(["claim-held", "--keypair", "coauthor.json"], {});
    expect([listed.code, listed.err]).toEqual([EXIT_OK, ""]);
    expect(listed.json()).toMatchObject({ shares: [], complete: false, reasons: [releaseUnread(first.announcement)], next: HELD_UNSURE });
    expect("unreadable" in listed.json()).toBe(false);
    made.hidden.clear();
    newerVersion(first.announcement);
    const undecoded = (await cli(["claim-held", "--keypair", "coauthor.json"], {})).json();
    expect(undecoded).toMatchObject({ shares: [], complete: false, next: HELD_UNSURE, unreadable: [{ address: first.announcement }] });
  });
});
