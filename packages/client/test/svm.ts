import { fileURLToPath } from "node:url";
import {
  type Address,
  appendTransactionMessageInstructions,
  type Blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type KeyPairSigner,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
  type Transaction,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  findAssociatedTokenAddress,
  findEventAuthorityPda,
  findIntentPda,
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
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import type { ProgramAccount, Transport } from "../src/index.js";

export const NOW = 1_700_000_000n;
export const FEE_BPS = 5;
export const SCANNED_NONCES = 16n;
const DOMAIN = new Uint8Array(32).fill(0x11);
const enginePath =
  process.env["INTENT_ENGINE_SO"] ?? fileURLToPath(new URL("../../../target/deploy/intent_engine.so", import.meta.url));

export type Chain = {
  svm: LiteSVM;
  owners: Set<Address>;
  transport: Transport;
  sent: string[];
};

const decodeWire = (wire: string) => getTransactionDecoder().decode(getBase64Encoder().encode(wire));

function landed(chain: Chain, tx: Transaction): string {
  const result = chain.svm.sendTransaction(tx);
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(`${String(result.err())}\n${result.meta().logs().join("\n")}`);
  }
  const signature = getSignatureFromTransaction(tx);
  chain.sent.push(signature);
  return signature;
}

export function svmTransport(chain: Chain): Transport {
  const getAccount = async (address: Address) => {
    const account = chain.svm.getAccount(address);
    return account.exists
      ? { owner: account.programAddress, data: new Uint8Array(account.data), lamports: account.lamports, executable: account.executable }
      : null;
  };
  return {
    getAccount,
    getAccounts: async (addresses) => Promise.all(addresses.map(getAccount)),
    send: async (instructions, payer) => {
      chain.svm.expireBlockhash();
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(payer, m),
        (m) => chain.svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      );
      return landed(chain, await signTransactionMessageWithSigners(message));
    },
    latestBlockhash: async () => ({ blockhash: chain.svm.latestBlockhash() as Blockhash, lastValidBlockHeight: 0n }),
    sendWire: async (wire) => landed(chain, decodeWire(wire)),
    submitWire: async (wire) => landed(chain, decodeWire(wire)),
    simulate: async (wire, watch = []) => {
      const tx = decodeWire(wire);
      const unsigned = Object.fromEntries(
        Object.entries(tx.signatures).map(([signer, signature]) => [signer, signature ?? new Uint8Array(64)]),
      );
      chain.svm.withSigverify(false).withBlockhashCheck(false);
      const result = chain.svm.simulateTransaction({ ...tx, signatures: unsigned } as typeof tx);
      chain.svm.withSigverify(true).withBlockhashCheck(true);
      const meta = result.meta();
      return {
        err: result instanceof FailedTransactionMetadata ? String(result.err()) : null,
        logs: meta.logs(),
        unitsConsumed: meta.computeUnitsConsumed(),
        accounts: watch.map(() => null),
      };
    },
    genesisHash: async () => getBase58Decoder().decode(DOMAIN),
    intents: async (only) => {
      const found: ProgramAccount[] = [];
      for (const owner of only === undefined ? chain.owners : [only]) {
        for (let nonce = 0n; nonce < SCANNED_NONCES; nonce++) {
          const [address] = await findIntentPda({ owner, nonce });
          const account = chain.svm.getAccount(address);
          if (account.exists && account.programAddress === INTENT_ENGINE_PROGRAM_ADDRESS) {
            found.push({ address, data: new Uint8Array(account.data) });
          }
        }
      }
      return found;
    },
    engineTransactions: async () => [],
    recentFees: async () => [],
    budget: async (instructions) => [...instructions],
    airdrop: async (address, amount) => {
      chain.svm.airdrop(address, lamports(amount));
      return "airdrop";
    },
  };
}

export type World = {
  chain: Chain;
  authority: KeyPairSigner;
  feeRecipient: KeyPairSigner;
  owner: KeyPairSigner;
  inputMint: Address;
  outputMint: Address;
};

async function funded(chain: Chain): Promise<KeyPairSigner> {
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
  const chain: Chain = { svm, owners: new Set(), sent: [], transport: undefined as unknown as Transport };
  chain.transport = svmTransport(chain);
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
  chain.owners.add(owner.address);
  const inputMint = await mint(chain, authority);
  const outputMint = await mint(chain, authority);
  await tokenAccount(chain, authority, owner.address, inputMint, 1_000n);
  await tokenAccount(chain, authority, owner.address, outputMint, 0n);
  return { chain, authority, feeRecipient, owner, inputMint, outputMint };
}
