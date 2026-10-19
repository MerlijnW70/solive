import { type Address, type Base64EncodedWireTransaction, getBase64Encoder, getTransactionDecoder, type Instruction } from "@solana/kit";
import { ASSOCIATED_TOKEN_PROGRAM } from "./jupiter.js";
import { CONSERVATIVE_RENT, type Rent, rentExemptAt } from "./rent.js";

export const LAMPORTS_PER_SIGNATURE = 5_000n;

export const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;

export const DEFAULT_MAX_SOL_COST = 10_000_000n;

export const DEFAULT_MAX_RENT = 10_000_000n;

export const TOKEN_ACCOUNT_SPACE = 165;

export const TOKEN_2022_ACCOUNT_SPACE = 170;

export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

const ATA_ADDRESS = 1;
const ATA_MINT = 3;
const ATA_TOKEN_PROGRAM = 5;

export const rentExempt = (space: number): bigint => rentExemptAt(space, CONSERVATIVE_RENT);

const ACCOUNT_TYPE_SPACE = 1;
const EXTENSION_HEADER_SPACE = 4;
const MULTISIG_SPACE = 355;
const EXTENSION_TYPE_SPACE = 2;
const IMMUTABLE_OWNER_SPACE = 0;

const ACCOUNT_EXTENSION_SPACE: ReadonlyMap<number, number> = new Map([
  [1, 8],
  [9, 0],
  [14, 1],
  [16, 64],
  [26, 0],
]);

export function mintExtensions(data: Uint8Array | null): number[] {
  const found: number[] = [];
  if (data === null) {
    return found;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let at = TOKEN_ACCOUNT_SPACE + ACCOUNT_TYPE_SPACE; at + EXTENSION_HEADER_SPACE <= data.length; ) {
    const type = view.getUint16(at, true);
    if (type === 0) {
      break;
    }
    found.push(type);
    at += EXTENSION_HEADER_SPACE + view.getUint16(at + 2, true);
  }
  return found;
}

export function tokenAccountSpace(tokenProgram: Address, mint: Uint8Array | null): number {
  if (tokenProgram !== TOKEN_2022_PROGRAM) {
    return TOKEN_ACCOUNT_SPACE;
  }
  const extensions = [
    IMMUTABLE_OWNER_SPACE,
    ...mintExtensions(mint).flatMap((type) => {
      const space = ACCOUNT_EXTENSION_SPACE.get(type);
      return space === undefined ? [] : [space];
    }),
  ];
  const space = extensions.reduce(
    (total, extension) => total + EXTENSION_HEADER_SPACE + extension,
    TOKEN_ACCOUNT_SPACE + ACCOUNT_TYPE_SPACE,
  );
  return space === MULTISIG_SPACE ? space + EXTENSION_TYPE_SPACE : space;
}

export type SolCost = { signatures: number; unitPrice: bigint; computeUnits: number; tip: bigint };

export function solCost(cost: SolCost): bigint {
  const priority = (cost.unitPrice * BigInt(cost.computeUnits) + MICRO_LAMPORTS_PER_LAMPORT - 1n) / MICRO_LAMPORTS_PER_LAMPORT;
  return LAMPORTS_PER_SIGNATURE * BigInt(cost.signatures) + priority + cost.tip;
}

export const tooCostly = (cost: bigint, cap: bigint): string =>
  `the fill costs ${cost} lamports in fees and tip, more than the cap of ${cap}`;

export const tooMuchRent = (rent: bigint, cap: bigint): string =>
  `the fill opens token accounts that keep ${rent} lamports of rent, more than the cap of ${cap}`;

export function signaturesOf(wire: Base64EncodedWireTransaction): number {
  return Object.keys(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).signatures).length;
}

export async function createdRent(
  instructions: readonly Instruction[],
  exists: (address: Address) => Promise<boolean>,
  mintData: (mint: Address) => Promise<Uint8Array | null> = async () => null,
  rates: Rent = CONSERVATIVE_RENT,
): Promise<bigint> {
  const opened = new Map<Address, { program: Address; mint: Address | undefined }>();
  for (const ix of instructions) {
    const account = ix.accounts?.[ATA_ADDRESS]?.address;
    if (ix.programAddress === ASSOCIATED_TOKEN_PROGRAM && account !== undefined && !opened.has(account)) {
      opened.set(account, { program: ix.accounts?.[ATA_TOKEN_PROGRAM]?.address ?? account, mint: ix.accounts?.[ATA_MINT]?.address });
    }
  }
  let rent = 0n;
  for (const [account, { program, mint }] of opened) {
    if (!(await exists(account))) {
      const data = program === TOKEN_2022_PROGRAM && mint !== undefined ? await mintData(mint) : null;
      rent += rentExemptAt(tokenAccountSpace(program, data), rates);
    }
  }
  return rent;
}
