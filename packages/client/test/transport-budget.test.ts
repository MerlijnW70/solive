import {
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  generateKeyPairSigner,
  type Instruction,
  AccountRole,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { computeUnitLimit, headroom, MAX_COMPUTE_UNITS } from "@intent-engine/core/internal";
import { memoized, type Transport } from "../src/transport.js";
import { budgeted, PACKET_DATA_SIZE, transactionBytes, withPriority } from "../src/budget.js";
import { isolateMocks, OWNER } from "./transport-stub.js";

isolateMocks();

class Ledger implements Transport {
  #reads = 0;
  #sent: number[] = [];

  get reads(): number {
    return this.#reads;
  }

  get sent(): number[] {
    return [...this.#sent];
  }

  async getAccount() {
    this.#reads += 1;
    return null;
  }

  async getAccounts(addresses: readonly Address[]) {
    this.#reads += 1;
    return addresses.map(() => null);
  }

  async send(instructions: readonly unknown[]) {
    this.#sent.push(instructions.length);
    return "sent";
  }

  async latestBlockhash() {
    return { blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 0n };
  }

  async sendWire() {
    this.#sent.push(0);
    return "wire";
  }

  async submitWire() {
    return "submitted";
  }

  async simulate() {
    return { err: null, logs: [], unitsConsumed: 1_000n, accounts: [] };
  }

  async genesisHash() {
    this.#reads += 1;
    return "GENESIS";
  }

  async intents() {
    return [];
  }

  async engineTransactions() {
    return [];
  }

  async recentFees() {
    return [];
  }

  async budget(instructions: readonly Instruction[]) {
    return [...instructions];
  }

  async airdrop() {
    return "airdropped";
  }
}

class Simulating extends Ledger {
  readonly wires: string[] = [];

  override async simulate(wire?: Base64EncodedWireTransaction) {
    if (wire !== undefined) {
      this.wires.push(wire);
    }
    return super.simulate();
  }
}

describe("budgeting", () => {
  it("budgeting skips simulation for a transaction over the packet limit", async () => {
    const ledger = new Simulating();
    const payer = await generateKeyPairSigner();
    const small: Instruction = { programAddress: OWNER, accounts: [], data: new Uint8Array(8) };
    expect(await budgeted(ledger, 0n, [small], payer.address)).toEqual([small, computeUnitLimit(headroom(1_000n))]);
    expect(ledger.wires).toHaveLength(1);

    const large: Instruction = { programAddress: OWNER, accounts: [], data: new Uint8Array(PACKET_DATA_SIZE) };
    const unsimulated = await budgeted(ledger, 0n, [large], payer.address);
    expect(unsimulated).toEqual([large, computeUnitLimit(MAX_COMPUTE_UNITS)]);
    expect(await transactionBytes(ledger, unsimulated, payer.address)).toBeGreaterThan(PACKET_DATA_SIZE);
    expect(await withPriority(ledger, 0n).send([large], payer)).toBe("sent");
    expect(ledger.wires).toHaveLength(1);

    const keys = await Promise.all(Array.from({ length: 40 }, async () => (await generateKeyPairSigner()).address));
    const wide: Instruction = { programAddress: OWNER, accounts: keys.map((address) => ({ address, role: AccountRole.READONLY })), data: new Uint8Array(8) };
    const table = (await generateKeyPairSigner()).address;
    expect(await transactionBytes(ledger, [wide, computeUnitLimit(MAX_COMPUTE_UNITS)], payer.address)).toBeGreaterThan(PACKET_DATA_SIZE);
    expect(await withPriority(ledger, 0n).budget([wide], payer.address)).toEqual([wide, computeUnitLimit(MAX_COMPUTE_UNITS)]);
    expect(ledger.wires).toHaveLength(1);
    expect(await withPriority(ledger, 0n).budget([wide], payer.address, { [table]: keys })).toEqual([wide, computeUnitLimit(headroom(1_000n))]);
    expect(ledger.wires).toHaveLength(2);
    const wire = ledger.wires[1] ?? "";
    const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes);
    expect("addressTableLookups" in message ? message.addressTableLookups?.map((lookup) => lookup.lookupTableAddress) : []).toEqual([table]);
  });
});

describe("wrapped transports", () => {
  const ix: Instruction = { programAddress: OWNER, accounts: [], data: new Uint8Array([1]) };

  it("withPriority keeps the methods of a class transport", async () => {
    const ledger = new Ledger();
    const wrapped = withPriority(ledger, 0n);
    const { genesisHash, getAccount } = wrapped;
    expect(await genesisHash()).toBe("GENESIS");
    expect(await getAccount(OWNER)).toBeNull();
    expect(await wrapped.airdrop(OWNER, 1n)).toBe("airdropped");
    expect(await wrapped.send([ix], await generateKeyPairSigner())).toBe("sent");
    expect(ledger.sent).toEqual([2]);
    expect(ledger.reads).toBe(2);
  });

  it("memoized keeps the methods of a class transport", async () => {
    const ledger = new Ledger();
    const reading = memoized(ledger);
    const { genesisHash, getAccount, send } = reading;
    expect(await genesisHash()).toBe("GENESIS");
    expect(await getAccount(OWNER)).toBeNull();
    expect(await reading.getAccount(OWNER)).toBeNull();
    expect(ledger.reads).toBe(2);
    expect(await send([ix], await generateKeyPairSigner())).toBe("sent");
    expect(await reading.getAccount(OWNER)).toBeNull();
    expect(ledger.reads).toBe(3);
    expect(await reading.intents()).toEqual([]);
    expect(await withPriority(reading, 0n).latestBlockhash()).toEqual(await ledger.latestBlockhash());
  });
});
