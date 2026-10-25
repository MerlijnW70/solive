import { type Address, getBase16Decoder, getBase16Encoder, type ReadonlyUint8Array, type TransactionSigner } from "@solana/kit";
import {
  findProfilePda,
  getCloseProfileInstructionAsync,
  getCreateProfileInstructionAsync,
  getProfileSize,
  getUpdateProfileInstructionAsync,
  PROFILE_DISCRIMINATOR,
} from "../generated/client/index.js";
import { events } from "./builder-accounts.js";
import { ENCRYPTION_KEY_BYTES, encryptionKeyText, isEncryptionKeyText, parseEncryptionKey } from "./encryption-key.js";
import { IntentCoreError, NotAnEngineAccount } from "./errors.js";
import { decodeProfileAccount } from "./account-reads.js";

export const PROFILE_MAX_SKILLS = 8;
export const PROFILE_SKILL_LEN = 16;
export const PROFILE_MAX_URL_LEN = 128;

export type ProfileInput = { skills: string[]; endpoint: string; docUrl?: string; docSha256?: string; encryptionKey?: string };

export type ProfileView = {
  wallet: Address;
  skills: string[];
  endpoint: string;
  docUrl: string | null;
  docSha256: string | null;
  encryptionKey: string | null;
  updatedAt: bigint;
};

const SKILL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const URL_BODY = /^https:\/\/[\x21-\x5b\x5d-\x7e]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ZERO_HASH = "0".repeat(64);

const validUrl = (text: string) => text.length <= PROFILE_MAX_URL_LEN && URL_BODY.test(text);

export function checkProfile(input: ProfileInput): ProfileInput {
  const { skills, endpoint, docUrl, docSha256, encryptionKey } = input;
  const hash = docSha256?.toLowerCase();
  const skillsValid =
    skills.length >= 1 &&
    skills.length <= PROFILE_MAX_SKILLS &&
    new Set(skills).size === skills.length &&
    skills.every((s) => s.length <= PROFILE_SKILL_LEN && SKILL.test(s));
  const docValid =
    (docUrl === undefined) === (hash === undefined) &&
    (docUrl === undefined || validUrl(docUrl)) &&
    (hash === undefined || (SHA256.test(hash) && hash !== ZERO_HASH));
  if (!skillsValid || !validUrl(endpoint) || !docValid || (encryptionKey !== undefined && !isEncryptionKeyText(encryptionKey))) {
    throw new IntentCoreError("ProfileInvalid");
  }
  return {
    skills: [...skills],
    endpoint,
    ...(docUrl === undefined || hash === undefined ? {} : { docUrl, docSha256: hash }),
    ...(encryptionKey === undefined ? {} : { encryptionKey }),
  };
}

function fieldsOf(input: ProfileInput) {
  const checked = checkProfile(input);
  return {
    skills: checked.skills,
    endpoint: checked.endpoint,
    docUrl: checked.docUrl ?? "",
    docHash: checked.docSha256 === undefined ? new Uint8Array(32) : getBase16Encoder().encode(checked.docSha256),
    encryptionKey: checked.encryptionKey === undefined ? new Uint8Array(ENCRYPTION_KEY_BYTES) : parseEncryptionKey(checked.encryptionKey),
  };
}

export async function profileAddress(wallet: Address): Promise<Address> {
  return (await findProfilePda({ wallet }))[0];
}

export async function buildCreateProfile(input: { wallet: TransactionSigner } & ProfileInput) {
  const args = fieldsOf(input);
  return getCreateProfileInstructionAsync({ wallet: input.wallet, args, ...(await events()) });
}

export async function buildUpdateProfile(input: { wallet: TransactionSigner } & ProfileInput) {
  const args = fieldsOf(input);
  return getUpdateProfileInstructionAsync({ wallet: input.wallet, args, ...(await events()) });
}

export async function buildCloseProfile(input: { wallet: TransactionSigner }) {
  return getCloseProfileInstructionAsync({ wallet: input.wallet, ...(await events()) });
}

const ascii = (bytes: ReadonlyUint8Array) => {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(bytes.slice(0, end < 0 ? bytes.length : end));
};

export function profileView(data: ReadonlyUint8Array): ProfileView {
  if (data.length < getProfileSize() || !PROFILE_DISCRIMINATOR.every((b, i) => data[i] === b)) {
    throw new NotAnEngineAccount(null, "the data is not a profile account");
  }
  const stored = decodeProfileAccount(data);
  const docUrl = ascii(stored.docUrl);
  const docSha256 = getBase16Decoder().decode(stored.docHash).toLowerCase();
  return {
    wallet: stored.wallet,
    skills: stored.skills.map(ascii).filter((s) => s !== ""),
    endpoint: ascii(stored.endpoint),
    docUrl: docUrl === "" ? null : docUrl,
    docSha256: docSha256 === ZERO_HASH ? null : docSha256,
    encryptionKey: stored.encryptionKey.some((b) => b !== 0) ? encryptionKeyText(Uint8Array.from(stored.encryptionKey)) : null,
    updatedAt: stored.updatedAt,
  };
}
