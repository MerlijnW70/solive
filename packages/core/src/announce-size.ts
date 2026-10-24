import {
  type Address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getAddressDecoder,
  getTransactionEncoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getAnnounceDeliveryInstruction, INTENT_ENGINE_PROGRAM_ADDRESS } from "../generated/client/index.js";
import { computeUnitLimit, computeUnitPrice } from "./compute.js";
import { MAX_BLOB_RECIPIENTS, MAX_BLOB_URL } from "./delivery.js";
import { sealedBlobLength } from "./sealed-delivery-v4.js";
import { InvalidInput } from "./errors.js";

export const PACKET_DATA_SIZE = 1_232;
export const PRIORITY_UNIT_LIMIT = 200_000;
export const PRIORITY_UNIT_PRICE = 1_000n;

export type AnnounceShape = {
  recipients: number;
  committee: boolean;
  relayer: boolean;
  board: boolean;
  claimList: boolean;
  feeTo: boolean;
  priorityFee: boolean;
  version: "legacy" | 0;
};

const ROLES = ["worker", "payer", "config", "intent", "attestor", "judgeProfile", "board", "claimList", "book", "announcement", "feeTo", "eventAuthority", "blockhash"] as const;

type Role = (typeof ROLES)[number];

const STAND_IN: Record<Role, Address> = Object.fromEntries(
  ROLES.map((role, i) => [role, getAddressDecoder().decode(new Uint8Array(32).fill(i + 1))]),
) as Record<Role, Address>;

function checkShape(shape: AnnounceShape): void {
  const { recipients, committee } = shape;
  if (!Number.isInteger(recipients) || recipients < 1 || recipients > MAX_BLOB_RECIPIENTS) {
    throw new InvalidInput("recipients", "range", `an announcement is sealed to between 1 and ${MAX_BLOB_RECIPIENTS} recipients`);
  }
  if (!committee && recipients !== 1) {
    throw new InvalidInput("recipients", "range", "an announcement to a single judge is sealed to exactly 1 recipient");
  }
}

function announceInstruction(shape: AnnounceShape, url: number): Instruction {
  const at = STAND_IN;
  const worker = createNoopSigner(at.worker);
  return getAnnounceDeliveryInstruction({
    worker,
    payer: shape.relayer ? createNoopSigner(at.payer) : worker,
    config: at.config,
    intent: at.intent,
    attestor: at.attestor,
    ...(shape.committee ? { committee: at.attestor } : { judgeProfile: at.judgeProfile }),
    ...(shape.board ? { board: at.board } : {}),
    ...(shape.claimList ? { claimList: at.claimList } : {}),
    ...(shape.feeTo ? { feeTo: at.feeTo } : {}),
    book: at.book,
    announcement: at.announcement,
    eventAuthority: at.eventAuthority,
    program: INTENT_ENGINE_PROGRAM_ADDRESS,
    commitment: new Uint8Array(32),
    blob: new Uint8Array(sealedBlobLength(shape.recipients, url)),
  });
}

export function announceWireSize(shape: AnnounceShape, url: number): number {
  checkShape(shape);
  const instructions = [
    ...(shape.priorityFee ? [computeUnitLimit(PRIORITY_UNIT_LIMIT), computeUnitPrice(PRIORITY_UNIT_PRICE)] : []),
    announceInstruction(shape, url),
  ];
  const message = pipe(
    createTransactionMessage({ version: shape.version }),
    (m) => setTransactionMessageFeePayer(shape.relayer ? STAND_IN.payer : STAND_IN.worker, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: STAND_IN.blockhash as string as Blockhash, lastValidBlockHeight: 0n }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return getTransactionEncoder().encode(compileTransaction(message)).length;
}

export function maxSealedUrl(shape: AnnounceShape): number {
  checkShape(shape);
  let best = 0;
  for (let url = 1; url <= MAX_BLOB_URL; url += 1) {
    if (announceWireSize(shape, url) <= PACKET_DATA_SIZE) {
      best = url;
    }
  }
  return best;
}
