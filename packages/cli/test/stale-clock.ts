import type { Address } from "@solana/kit";
import { vi } from "vitest";
import { setNow, transport } from "./harness.js";

const CLOCK = "SysvarC1ock11111111111111111111111111111111" as Address;

export function laterThanTheView(board: Address, at: bigint): void {
  let seen = false;
  let moved = false;
  const after = (addresses: readonly Address[]) => {
    if (addresses.includes(CLOCK) && (seen || addresses.includes(board)) && !moved) {
      moved = true;
      setNow(at);
    }
    if (addresses.includes(board)) seen = true;
  };
  const one = transport.getAccount.bind(transport);
  const many = transport.getAccounts.bind(transport);
  vi.spyOn(transport, "getAccount").mockImplementation(async (address, ...rest) => {
    const account = await one(address, ...rest);
    after([address]);
    return account;
  });
  vi.spyOn(transport, "getAccounts").mockImplementation(async (addresses, ...rest) => {
    const accounts = await many(addresses, ...rest);
    after(addresses);
    return accounts;
  });
}
