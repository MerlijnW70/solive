import { type Address, getAddressEncoder, lamports } from "@solana/kit";
import { LOOKUP_TABLE_HEADER } from "@intent-engine/solver";
import { h } from "./harness.js";

const ADDRESS_LOOKUP_TABLE_PROGRAM = "AddressLookupTab1e1111111111111111111111111" as Address;

export function lookupTable(addresses: readonly Address[], table: Address): void {
  const header = new Uint8Array(LOOKUP_TABLE_HEADER);
  const view = new DataView(header.buffer);
  view.setUint32(0, 1, true);
  view.setBigUint64(4, 0xffff_ffff_ffff_ffffn, true);
  header[20] = addresses.length;
  const data = Uint8Array.from([...header, ...addresses.flatMap((address) => [...getAddressEncoder().encode(address)])]);
  h.svm.setAccount({ address: table, data, executable: false, lamports: lamports(h.svm.minimumBalanceForRentExemption(BigInt(data.length))), programAddress: ADDRESS_LOOKUP_TABLE_PROGRAM, space: BigInt(data.length) });
}
