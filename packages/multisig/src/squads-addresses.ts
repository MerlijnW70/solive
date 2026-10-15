import { type Address, address, type Codec, getAddressEncoder, getProgramDerivedAddress, getU64Encoder, type ReadonlyUint8Array } from "@solana/kit";

export const SQUADS_PROGRAM = address("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
export const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

export const DISCRIMINATORS = {
  multisigCreateV2: [50, 221, 199, 93, 40, 245, 139, 233],
  vaultTransactionCreate: [48, 250, 78, 168, 208, 226, 218, 211],
  proposalCreate: [220, 60, 73, 224, 30, 108, 79, 159],
  proposalApprove: [144, 37, 164, 136, 188, 216, 42, 248],
  vaultTransactionExecute: [194, 8, 161, 87, 153, 164, 25, 171],
  proposalReject: [243, 62, 134, 156, 230, 106, 246, 135],
  proposalCancelV2: [205, 41, 194, 61, 220, 139, 16, 247],
  configTransactionExecute: [114, 146, 244, 189, 252, 140, 36, 40],
  Multisig: [224, 116, 121, 186, 68, 161, 79, 236],
  Proposal: [26, 94, 189, 187, 116, 136, 53, 33],
  VaultTransaction: [168, 250, 162, 100, 81, 14, 162, 207],
  ProgramConfig: [196, 210, 90, 231, 144, 149, 140, 63],
  ConfigTransaction: [94, 8, 4, 35, 113, 139, 139, 112],
} as const;

export const PERMISSION = { initiate: 1, vote: 2, execute: 4 } as const;
export const ALL_PERMISSIONS = PERMISSION.initiate | PERMISSION.vote | PERMISSION.execute;

type AccountName = "Multisig" | "Proposal" | "VaultTransaction" | "ProgramConfig" | "ConfigTransaction";

export const discriminated = (discriminator: readonly number[], body: ReadonlyUint8Array): Uint8Array => {
  const out = new Uint8Array(discriminator.length + body.length);
  out.set(discriminator);
  out.set(body, discriminator.length);
  return out;
};

export function decodeAccount<T extends object>(name: AccountName, codec: Codec<T>, data: ReadonlyUint8Array): T | null {
  const discriminator = DISCRIMINATORS[name];
  if (data.length < discriminator.length || discriminator.some((b, i) => data[i] !== b)) {
    return null;
  }
  try {
    return codec.decode(data, discriminator.length);
  } catch {
    return null;
  }
}

export const encodeAccount = <T extends object>(name: AccountName, codec: Codec<T>, value: T): Uint8Array =>
  discriminated(DISCRIMINATORS[name], codec.encode(value));

const seedOf = (value: Address) => getAddressEncoder().encode(value);

const pda = async (seeds: (string | ReadonlyUint8Array)[]): Promise<Address> =>
  (await getProgramDerivedAddress({ programAddress: SQUADS_PROGRAM, seeds: ["multisig", ...seeds] }))[0];

export const programConfigPda = () => pda(["program_config"]);
export const multisigPda = (createKey: Address) => pda(["multisig", seedOf(createKey)]);
export const vaultPda = (multisig: Address, index: number) => pda([seedOf(multisig), "vault", new Uint8Array([index])]);
export const transactionPda = (multisig: Address, index: bigint) => pda([seedOf(multisig), "transaction", getU64Encoder().encode(index)]);
export const proposalPda = (multisig: Address, index: bigint) => pda([seedOf(multisig), "transaction", getU64Encoder().encode(index), "proposal"]);
export const ephemeralSignerPda = (transaction: Address, index: number) => pda([seedOf(transaction), "ephemeral_signer", new Uint8Array([index])]);
