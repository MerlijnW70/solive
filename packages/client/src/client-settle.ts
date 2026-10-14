import { type Address, getAddressDecoder } from "@solana/kit";
import {
  attestedProofMessage,
  buildFillAttested,
  decodeParams,
  feeBpsFor,
  IntentStatus,
  isSha256Hex,
  Kind,
  releaseMemo,
  signEd25519Instruction,
  splitFees,
} from "@intent-engine/core";
import { chainTime, createdAccount, loadIntent, SYSTEM_PROGRAM_ADDRESS } from "./accounts.js";
import { EscrowExpired, NotSettleable, PayeeMoved, PayToNotWallet } from "./client-errors.js";
import type { ClientContext, SettleProofInput } from "./client-types.js";
import { memoInstruction } from "./jobs.js";
import { tokenAccountIfMissing } from "./setup.js";

export function proofSettlement({ transport, send, mint, config }: ClientContext) {
  const settleProof = async (input: SettleProofInput) => {
    const { judge, owner, nonce, payTo, result } = input;
    const deliveredSha256 = input.deliveredSha256?.toLowerCase();
    const payer = input.payer ?? judge;
    if (deliveredSha256 !== undefined && !isSha256Hex(deliveredSha256)) {
      throw new RangeError("deliveredSha256 must be 64 hex digits");
    }
    const [{ address, intent: held }, settings] = await Promise.all([loadIntent(transport, owner, nonce), config()]);
    const params = decodeParams(held.kind, Uint8Array.from(held.params));
    if (params.kind !== Kind.AttestedResult) {
      throw new NotSettleable(address, "is not an AttestedResult intent");
    }
    if (params.specHash.every((b) => b === 0)) {
      throw new NotSettleable(address, "commits no spec hash, so it is not a proof intent");
    }
    if (held.status !== IntentStatus.Open) {
      throw new NotSettleable(address, "is not open");
    }
    if (params.attestor !== judge.address) {
      throw new NotSettleable(address, `names ${params.attestor} as its judge, not ${judge.address}`);
    }
    if (held.expiresAt <= (await chainTime(transport))) {
      throw new EscrowExpired(address, held.expiresAt);
    }
    const holder = await transport.getAccount(payTo);
    if (holder !== null && holder.owner !== SYSTEM_PROGRAM_ADDRESS) {
      throw new PayToNotWallet(payTo, holder.owner);
    }
    const { tokenProgram } = await mint(held.inputMint);
    const account = (wallet: Address) => tokenAccountIfMissing(transport, payer, wallet, held.inputMint, tokenProgram);
    const amountIn = held.escrowed - held.filled;
    const kindBps = feeBpsFor(settings, held.kind);
    const maxFeeBps = kindBps + held.partnerBps;
    const shares = splitFees(amountIn - params.judgeFee, kindBps, held.partnerBps, held.partnerCutBps);
    const feeRecipient = shares.protocol > 0n ? settings.feeRecipient : undefined;
    const partner = shares.partner > 0n ? held.partner : undefined;
    const paidJudge = params.judgeFee > 0n ? judge.address : undefined;
    const payee = await account(payTo);
    if (payee.create.length === 0) {
      const existing = await createdAccount(transport, payee.address);
      const data = existing === null || existing.owner !== tokenProgram || existing.data.length < 64 ? null : existing.data;
      if (
        data === null ||
        getAddressDecoder().decode(data.subarray(0, 32)) !== held.inputMint ||
        getAddressDecoder().decode(data.subarray(32, 64)) !== payTo
      ) {
        throw new PayeeMoved(payTo, payee.address);
      }
    }
    const others = await Promise.all([feeRecipient, partner, paidJudge].filter((wallet) => wallet !== undefined).map(account));
    const fields = { amountIn, result, maxFeeBps };
    const message = await attestedProofMessage(judge.address, {
      ...fields,
      domain: Uint8Array.from(settings.domain),
      intent: address,
      payee: payee.address,
      filled: held.filled,
      revision: held.revision,
      specHash: params.specHash,
    });
    const settle = await buildFillAttested({
      ...fields,
      solver: judge,
      owner,
      nonce,
      inputMint: held.inputMint,
      inputTokenProgram: tokenProgram,
      payee: payee.address,
      ...(feeRecipient === undefined ? {} : { feeRecipient }),
      ...(partner === undefined ? {} : { partner }),
      ...(paidJudge === undefined ? {} : { judge: paidJudge }),
    });
    const setup = [payee, ...others].flatMap(({ create }) => create);
    const recorded = deliveredSha256 === undefined ? [] : [memoInstruction(judge, releaseMemo(deliveredSha256))];
    return send([...setup, await signEd25519Instruction(judge, message), settle, ...recorded], payer);
  };
  return settleProof;
}
