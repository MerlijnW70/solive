import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner, getAddressEncoder, getBase58Decoder, type KeyPairSigner, lamports } from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  findAssociatedTokenAddress,
  findEventAuthorityPda,
  findProgramDataAddress,
  getInitConfigInstructionAsync,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  ALL_KINDS_MASK,
} from "@intent-engine/core";
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { LiteSVM } from "litesvm";
import type { Transport } from "../src/index.js";
import { svmTransport } from "../src/svm.js";

export const NOW = 1_700_000_000n;
export const FEE_BPS = 5;
const DOMAIN = new Uint8Array(32).fill(0x11);
const enginePath =
  process.env["INTENT_ENGINE_SO"] ?? fileURLToPath(new URL("../../../target/deploy/intent_engine.so", import.meta.url));

export type Chain = {
  svm: LiteSVM;
  transport: Transport;
  sent: string[];
};

export type World = {
  chain: Chain;
  authority: KeyPairSigner;
  feeRecipient: KeyPairSigner;
  owner: KeyPairSigner;
  inputMint: Address;
  outputMint: Address;
};

export async function funded(chain: Chain): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  chain.svm.airdrop(signer.address, lamports(100_000_000_000n));
  return signer;
}

async function mint(chain: Chain, authority: KeyPairSigner): Promise<Address> {
  const created = await generateKeyPairSigner();
  const space = BigInt(getMintSize());
  await chain.transport.send(
    [
      getCreateAccountInstruction({
        payer: authority,
        newAccount: created,
        lamports: chain.svm.minimumBalanceForRentExemption(space),
        space,
        programAddress: TOKEN_PROGRAM_ADDRESS,
      }),
      getInitializeMint2Instruction({ mint: created.address, decimals: 6, mintAuthority: authority.address }),
    ],
    authority,
  );
  return created.address;
}

async function tokenAccount(chain: Chain, authority: KeyPairSigner, owner: Address, of: Address, amount: bigint): Promise<void> {
  const address = await findAssociatedTokenAddress({ owner, mint: of, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  await chain.transport.send(
    [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: authority, owner, mint: of }),
      ...(amount > 0n ? [getMintToInstruction({ mint: of, token: address, mintAuthority: authority, amount })] : []),
    ],
    authority,
  );
}

export async function world(): Promise<World> {
  const svm = new LiteSVM().withPrecompiles();
  svm.addProgramFromFile(INTENT_ENGINE_PROGRAM_ADDRESS, enginePath);
  const clock = svm.getClock();
  clock.unixTimestamp = NOW;
  svm.setClock(clock);
  const inner = svmTransport(svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
  const sent: string[] = [];
  const recorded = async (pending: Promise<string>) => {
    const signature = await pending;
    sent.push(signature);
    return signature;
  };
  const chain: Chain = {
    svm,
    sent,
    transport: {
      ...inner,
      send: (instructions, payer) => recorded(inner.send(instructions, payer)),
      sendWire: (wire, latest) => recorded(inner.sendWire(wire, latest)),
      submitWire: (wire) => recorded(inner.submitWire(wire)),
    },
  };
  const authority = await funded(chain);
  const programData = await findProgramDataAddress();
  const account = svm.getAccount(programData);
  if (!account.exists) {
    throw new Error("program data missing");
  }
  const data = new Uint8Array(account.data);
  data[12] = 1;
  data.set(getAddressEncoder().encode(authority.address), 13);
  svm.setAccount({ ...account, data });
  const feeRecipient = await funded(chain);
  const [eventAuthority] = await findEventAuthorityPda();
  await chain.transport.send(
    [
      await getInitConfigInstructionAsync({
        authority,
        engineProgram: INTENT_ENGINE_PROGRAM_ADDRESS,
        programData,
        eventAuthority,
        program: INTENT_ENGINE_PROGRAM_ADDRESS,
        domain: DOMAIN,
        guardian: authority.address,
        feeRecipient: feeRecipient.address,
        enabledKinds: ALL_KINDS_MASK,
        feeBps: FEE_BPS,
        paused: 0,
      }),
    ],
    authority,
  );
  const owner = await funded(chain);
  const inputMint = await mint(chain, authority);
  const outputMint = await mint(chain, authority);
  await tokenAccount(chain, authority, owner.address, inputMint, 1_000n);
  await tokenAccount(chain, authority, owner.address, outputMint, 0n);
  return { chain, authority, feeRecipient, owner, inputMint, outputMint };
}
