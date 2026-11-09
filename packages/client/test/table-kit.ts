import {
  type Address,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  type Instruction,
  isSignerRole,
  type KeyPairSigner,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Signature,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { PACKET_DATA_SIZE } from "../src/internal.js";
import type { World } from "./svm.js";

const LOOKUP_TABLE_PROGRAM = "AddressLookupTab1e1111111111111111111111111" as Address;
const LOOKUP_TABLE_HEADER = 56;

export async function sentWithTable(w: World, instructions: readonly Instruction[], payer: KeyPairSigner): Promise<Signature> {
  const invoked = new Set(instructions.map((ix) => ix.programAddress));
  const looked = [...new Set(instructions.flatMap((ix) => (ix.accounts ?? []).filter((meta) => !isSignerRole(meta.role)).map((meta) => meta.address)))].filter((address) => !invoked.has(address));
  const table = (await generateKeyPairSigner()).address;
  const header = new Uint8Array(LOOKUP_TABLE_HEADER);
  const view = new DataView(header.buffer);
  view.setUint32(0, 1, true);
  view.setBigUint64(4, 0xffff_ffff_ffff_ffffn, true);
  const data = Uint8Array.from([...header, ...looked.flatMap((address) => [...getAddressEncoder().encode(address)])]);
  w.chain.svm.setAccount({ address: table, data, executable: false, lamports: lamports(w.chain.svm.minimumBalanceForRentExemption(BigInt(data.length))), programAddress: LOOKUP_TABLE_PROGRAM, space: BigInt(data.length) });
  const latest = await w.chain.transport.latestBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const wire = getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(compressTransactionMessageUsingAddressLookupTables(message, { [table]: looked })));
  const size = getBase64Encoder().encode(wire).length;
  if (size > PACKET_DATA_SIZE) {
    throw new Error(`a ${size}-byte transaction cannot land even with a lookup table`);
  }
  return w.chain.transport.sendWire(wire, latest);
}
