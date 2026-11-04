import type { Address } from "@solana/kit";
import type { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { findConfigPda, findIntentPda, getConfigDecoder, getConfigEncoder } from "@intent-engine/core/internal";
import type { Transport } from "@intent-engine/client";
import { ESCROW_CHANGED, piecesPartlySent } from "../src/agent/wallet/escrow.js";
import { AUCTION_CHANGED, ORDER_CHANGED, partlySent } from "../src/agent/wallet/trade.js";
import { call, connect, fresh, ok, preset } from "./agent-wallet-kit.js";
import { escrowTo, useWallet } from "./bound-books-kit.js";
import { h, transport, world } from "./harness.js";

type Field = "createFee" | "crankBounty";

const RAISED = 900_000;

async function raised(field: Field): Promise<void> {
  const [config] = await findConfigPda();
  const view = h.svm.getAccount(config);
  if (!view.exists) {
    throw new Error("no config");
  }
  const decoded = getConfigDecoder().decode(view.data);
  h.svm.setAccount({ ...view, data: Uint8Array.from(getConfigEncoder().encode({ ...decoded, [field]: decoded[field] + RAISED })) });
}

const JUDGE = "SysvarC1ock11111111111111111111111111111111" as Address;

const TOOLS = [
  ["wallet_auction", { sell: "SOL", buy: "TEST", amount: "0.05", start_receive: "12", end_receive: "9.5", falls_over: 600 }, AUCTION_CHANGED],
  ["wallet_swap", { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5", start_receive: "6" }, ORDER_CHANGED],
  ["wallet_recurring", { sell: "SOL", buy: "TEST", amount: "0.01", min_receive: "1", start_receive: "2", every: 60, times: 2 }, ORDER_CHANGED],
  ["wallet_escrow", { sell: "SOL", amount: "0.05", attestor: JUDGE, spec_hash: "5c".repeat(32) }, ESCROW_CHANGED],
  ["wallet_escrow_plan", { sell: "SOL", attestor: JUDGE, spec_hash: "5d".repeat(32), pieces: [{ name: "one", amount: "0.01" }, { name: "two", amount: "0.01" }] }, ESCROW_CHANGED],
] as const;

describe("offer sends bound to the create fee and crank bounty their preview read", () => {
  let client: Client;

  beforeEach(async () => {
    client = await fresh();
    await ok(client, "wallet_setup");
  });

  for (const [name, args, changed] of TOOLS) {
    for (const field of ["createFee", "crankBounty"] as const) {
      it(`${name}: refuses a send after the ${field} rose, and creates no intent`, async () => {
        const shown = await ok(client, name, args);
        expect(shown["approval"]).toMatch(/^[0-9a-f]{16}$/);
        await raised(field);
        const wires = h.wires.length;
        const refused = await call(client, name, { ...args, approval: shown["approval"], send: true });
        expect(refused).toEqual({ error: true, value: expect.objectContaining({ code: "ReleaseChanged", hint: changed }) });
        expect(h.wires).toHaveLength(wires);
        const again = await ok(client, name, args);
        expect(again["approval"]).not.toBe(shown["approval"]);
        expect(await ok(client, name, { ...args, approval: again["approval"], send: true })).toMatchObject({ sent: true });
      }, 60_000);
    }
  }

  for (const [name, args, changed, phrase] of [
    ["wallet_recurring", TOOLS[2][1], ORDER_CHANGED, (problem: string) => partlySent(1, 2, problem)],
    ["wallet_escrow_plan", TOOLS[4][1], ESCROW_CHANGED, (problem: string) => piecesPartlySent(1, 2, problem)],
  ] as const) {
    it(`${name}: refuses the second send once the create fee rose after the first landed, and sends nothing more`, async () => {
      const shown = await ok(client, name, args);
      const live: Transport = transport;
      let landed = 0;
      h.through = {
        ...live,
        sendWire: async (wire, latest) => {
          const signature = await live.sendWire(wire, latest);
          landed += 1;
          if (landed === 1) {
            await raised("createFee");
          }
          return signature;
        },
      };
      const racing = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
      const done = await ok(racing, name, { ...args, approval: shown["approval"], send: true });
      expect(landed).toBe(1);
      expect(done["next"]).toBe(phrase(`ReleaseChanged: ${changed}`));
      const [first, rest] = done[name === "wallet_recurring" ? "orders" : "pieces"] as Record<string, unknown>[];
      expect(first?.["intent"]).toEqual(expect.any(String));
      expect(rest?.["intent"]).toBeUndefined();
      const owner = (await ok(racing, "wallet_balance"))["address"] as Address;
      const [second] = await findIntentPda({ owner, nonce: BigInt(String(first?.["nonce"])) + 1n });
      expect(h.svm.getAccount(second).exists).toBe(false);
    }, 60_000);
  }

  it("refuses the retry after a real nonce clash when the create fee rose in between, and creates no second intent", async () => {
    const w = await world();
    h.files.clear();
    for (const name of Object.keys(h.env)) {
      delete h.env[name];
    }
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    useWallet(w.owner);
    const args = TOOLS[0][1];
    const shown = await ok(await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]), "wallet_auction", args);
    const nonce = BigInt(shown["nonce"] as string);
    const live: Transport = transport;
    let clashes = 0;
    let clashed: Address | undefined;
    h.through = {
      ...live,
      sendWire: async (wire, latest) => {
        if (clashes === 0) {
          clashes += 1;
          clashed = await escrowTo(w.owner, JUDGE, w.inputMint, w.outputMint, nonce);
          await raised("createFee");
          h.svm.withBlockhashCheck(false);
          try {
            return await live.sendWire(wire, latest);
          } finally {
            h.svm.withBlockhashCheck(true);
          }
        }
        return live.sendWire(wire, latest);
      },
    };
    const racing = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    const wires = h.wires.length;
    const refused = await call(racing, "wallet_auction", { ...args, approval: shown["approval"], send: true });
    expect(clashes).toBe(1);
    expect(clashed).toBe(shown["intent"]);
    expect(refused.value).toMatchObject({ code: "ReleaseChanged", hint: AUCTION_CHANGED });
    expect(h.wires).toHaveLength(wires);
    const [next] = await findIntentPda({ owner: w.owner.address, nonce: nonce + 1n });
    expect(h.svm.getAccount(next).exists).toBe(false);
  }, 60_000);
});
