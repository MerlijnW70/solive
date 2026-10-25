import { type Instruction, isSignerRole, isWritableRole } from "@solana/kit";
import { SYSTEM_PROGRAM } from "./squads-addresses.js";

const TRANSFER_TAG = 2;
const TRANSFER_BYTES = 12;
const LAMPORTS_PER_SOL = 1_000_000_000n;

export function solText(lamports: bigint): string {
  const fraction = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction === "" ? `${lamports / LAMPORTS_PER_SOL}` : `${lamports / LAMPORTS_PER_SOL}.${fraction}`;
}

export function systemTransferSummary(ix: Instruction): string | null {
  const data = ix.data ?? new Uint8Array();
  if (ix.programAddress !== SYSTEM_PROGRAM || data.length !== TRANSFER_BYTES) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== TRANSFER_TAG) {
    return null;
  }
  const lamports = view.getBigUint64(4, true);
  const accounts = ix.accounts ?? [];
  const [from, to] = accounts;
  if (from === undefined || to === undefined) {
    return `System transfer of ${solText(lamports)} SOL with only ${accounts.length} of its 2 accounts, so the system program refuses it`;
  }
  const notes = [
    isSignerRole(from.role) ? "" : `; ${from.address} does not sign, so the system program refuses it`,
    ...[from, to].map((k) => (isWritableRole(k.role) ? "" : `; ${k.address} is not writable, so the transfer fails`)),
    accounts.length > 2 ? `; it passes ${accounts.length - 2} more accounts, which the system program ignores` : "",
  ];
  return `Transfers ${solText(lamports)} SOL (${lamports} lamports) from ${from.address} to ${to.address}${notes.join("")}`;
}
