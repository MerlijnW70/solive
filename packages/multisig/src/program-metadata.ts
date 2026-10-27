import { type Address, type Instruction, isSignerRole, type ReadonlyUint8Array } from "@solana/kit";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import type { Chain } from "./chain.js";
import type { SetTarget } from "./proposal-effects.js";
import {
  canonicalMetadata,
  type Compression,
  contentHash,
  decodeMetadataInstruction,
  type Encoding,
  type Fields,
  type MetadataAccount,
  metadataAccount,
  type MetadataInstruction,
  PROGRAM_METADATA,
  PROGRAM_METADATA_CLIENT,
  type Role,
  type Slot,
} from "./program-metadata-layout.js";

export type IdlBuffer = { buffer: Address; authority: Address | null; hash: string | null; sets: "idl" };

export type MetadataContext = {
  vault: Address | null;
  position: number;
  engineData: Address;
  upgradeAuthority: () => Promise<Address | null>;
};

export type MetadataReview = { summary: string; buffer?: IdlBuffer; problem?: string; relayed?: string; sets?: SetTarget };

type Target = { address: Address; state: MetadataAccount; idl: boolean; text: string; note: string };

const ENGINE: Address = INTENT_ENGINE_PROGRAM_ADDRESS;

const nobody = (key: Address | null) => key ?? "nobody";

export const metadataRelayedText = (position: number, vault: Address, risks: readonly string[]) =>
  `instruction ${position} passes the vault ${vault} as a signer to the program-metadata program ${PROGRAM_METADATA} for more than an update of the intent engine's IDL: ${risks.join("; ")}`;

const slotOf = (d: MetadataInstruction, role: Role): Slot | undefined => d.slots.find((s) => s.role === role);

async function authorityText(state: MetadataAccount, authority: Slot | undefined, ctx: MetadataContext): Promise<string> {
  if (state.kind !== "metadata") {
    return "";
  }
  const immutable = state.mutable ? "" : "; it is immutable, so the program refuses every change";
  const key = authority?.address ?? null;
  if (key === null) {
    return immutable;
  }
  if (state.authority === key) {
    return `; ${key} may change it as its authority${immutable}`;
  }
  const upgradedBy = await ctx.upgradeAuthority();
  if (state.canonical && upgradedBy === key) {
    return `; ${key} may change it as the intent engine's upgrade authority${immutable}`;
  }
  return `; ${key} is not its authority: it names ${state.authority ?? "no authority of its own"} and the intent engine is upgraded by ${nobody(upgradedBy)}, so the program refuses it${immutable}`;
}

async function target(chain: Chain, on: Slot & { address: Address }, idl: Address, authority: Slot | undefined, ctx: MetadataContext): Promise<Target> {
  const at = on.address;
  const state = metadataAccount(await chain.account(at));
  if (at === idl) {
    const missing = state.kind === "missing" ? ", which does not exist yet" : "";
    return { address: at, state, idl: true, text: `the canonical IDL account ${at} of the intent engine ${ENGINE}${missing}`, note: await authorityText(state, authority, ctx) };
  }
  const not = on.role === "buffer" ? "" : `, not the canonical IDL account ${idl} of the intent engine`;
  switch (state.kind) {
    case "metadata":
      return {
        address: at,
        state,
        idl: false,
        text: `${at}, the ${state.canonical ? "canonical" : `non-canonical (authority ${nobody(state.authority)})`} "${state.seed}" metadata of program ${state.program}${not}`,
        note: "",
      };
    case "buffer":
      return { address: at, state, idl: false, text: `buffer ${at}, controlled by ${nobody(state.authority)}`, note: "" };
    case "missing":
      return { address: at, state, idl: false, text: `${at}, which does not exist${on.role === "buffer" ? " yet" : not}`, note: "" };
    case "other":
      return { address: at, state, idl: false, text: `${at}, which is not a program-metadata account${not}`, note: "" };
  }
}

function contentText(data: ReadonlyUint8Array, compression: Compression, encoding: Encoding): { text: string; hash: string | null } {
  const content = contentHash(data, compression, encoding);
  if ("error" in content) {
    return { text: `${data.length} bytes that do not decode: ${content.error}`, hash: null };
  }
  return { text: `${data.length} bytes that decode through ${compression} and ${encoding} to ${content.bytes} IDL bytes with sha256 ${content.hash}`, hash: content.hash };
}

async function bufferSource(chain: Chain, at: Address, fields: Fields): Promise<{ text: string; check: IdlBuffer }> {
  const state = metadataAccount(await chain.account(at));
  if (state.kind !== "buffer") {
    return { text: `buffer ${at}, which is missing or not a program-metadata buffer, so the program refuses it`, check: { buffer: at, authority: null, hash: null, sets: "idl" } };
  }
  const { text, hash } = contentText(state.data, fields.compression ?? "none", fields.encoding ?? "none");
  return { text: `buffer ${at}, controlled by ${nobody(state.authority)}, holding ${text}`, check: { buffer: at, authority: state.authority, hash, sets: "idl" } };
}

async function copySource(chain: Chain, at: Address, ctx: MetadataContext): Promise<{ text: string; problem?: string }> {
  const state = metadataAccount(await chain.account(at));
  if (state.kind !== "buffer") {
    return {
      text: `buffer ${at}, which is missing or not a program-metadata buffer`,
      problem: `instruction ${ctx.position} copies the data of ${at}, which is missing or not a program-metadata buffer, so this tool cannot show what it writes`,
    };
  }
  const text = `buffer ${at}, controlled by ${nobody(state.authority)}, holding ${state.data.length} bytes with sha256 ${contentText(state.data, "none", "none").hash ?? "none"}`;
  if (ctx.vault === null || state.authority !== ctx.vault) {
    return {
      text,
      problem: `instruction ${ctx.position} copies the data of buffer ${at}, controlled by ${nobody(state.authority)}, not the vault, so what it writes can change after approval`,
    };
  }
  return { text };
}

function slotText(slot: Slot, ctx: MetadataContext, risks: string[]): string {
  const key = slot.address;
  if (key === null) {
    return `${slot.role}: none`;
  }
  switch (slot.role) {
    case "authority":
      return `authority ${key}${slot.signer ? " (signs)" : ", which does not sign, so the program refuses it"}`;
    case "program":
      if (key !== ENGINE) {
        risks.push(`it names program ${key}, not the intent engine ${ENGINE}`);
        return `program ${key}, not the intent engine`;
      }
      return `program ${key} (the intent engine)`;
    case "program data":
      if (key !== ctx.engineData) {
        risks.push(`it names program data ${key}, not the intent engine's ${ctx.engineData}`);
        return `program data ${key}, not the intent engine's`;
      }
      return `program data ${key} (the intent engine's)`;
    case "destination":
      return `destination ${key}${key === ctx.vault ? " (the vault)" : ""}`;
    default:
      return `${slot.role} ${key}`;
  }
}

function fieldText(fields: Fields, fromBuffer: string | null): string {
  const parts: string[] = [];
  if (fields.seed !== undefined) {
    parts.push(fields.seed === null ? "seed: none" : `seed "${fields.seed}"`);
  }
  for (const [name, value] of [
    ["encoding", fields.encoding],
    ["compression", fields.compression],
    ["format", fields.format],
    ["data source", fields.dataSource],
  ] as const) {
    if (value !== undefined) {
      parts.push(`${name} ${value}`);
    }
  }
  if (fields.offset !== undefined) {
    parts.push(`offset ${fields.offset}`);
  }
  if (fields.length !== undefined) {
    parts.push(`length ${fields.length}`);
  }
  if (fields.newAuthority !== undefined) {
    parts.push(`new authority ${fields.newAuthority ?? "none"}`);
  }
  if (fields.data !== undefined) {
    if (fields.data !== null && fields.compression !== undefined && fields.encoding !== undefined) {
      parts.push(`data: ${contentText(fields.data, fields.compression, fields.encoding).text}`);
    } else if (fields.data !== null) {
      parts.push(`data: ${fields.data.length} bytes`);
    } else {
      parts.push(fromBuffer === null ? "data: none" : `data: none, taken from ${fromBuffer}`);
    }
  }
  return parts.length === 0 ? "no fields" : parts.join(", ");
}

function headline(d: MetadataInstruction, on: Target | null, source: string | null, ctx: MetadataContext, risks: string[]): string {
  const { fields } = d;
  const where = on?.text ?? "nothing";
  const destination = slotOf(d, "destination")?.address ?? null;
  const leaves = destination !== null && destination !== ctx.vault;
  const idlOnly = (what: string) => {
    if (on !== null && !on.idl && on.state.kind !== "metadata") {
      risks.push(`it ${what} ${on.text}`);
    }
  };
  switch (d.name) {
    case "Write":
      return `Writes ${fields.data === null ? `the data of ${source ?? "no source buffer"}` : `${fields.data?.length ?? 0} bytes`} at offset ${fields.offset ?? 0} into ${where}`;
    case "Initialize":
      idlOnly("creates");
      return `Creates ${where}`;
    case "SetAuthority": {
      const next = fields.newAuthority ?? null;
      if (ctx.vault !== null && next !== ctx.vault) {
        risks.push(`it hands the authority of ${where} to ${next ?? "nobody but the program's upgrade authority"}, not the vault`);
      }
      return next === null ? `Removes the authority of ${where}, leaving it to the program's upgrade authority` : `Hands the authority of ${where} to ${next}`;
    }
    case "SetData":
      idlOnly("sets the data of");
      if (fields.data === null && source === null) {
        return `Sets the data of ${where} from neither a buffer nor instruction data, so the program refuses it`;
      }
      if (fields.data !== null && fields.data !== undefined && source !== null) {
        return `Sets the data of ${where} from both ${source} and the instruction data, so the program refuses it`;
      }
      return `Sets the data of ${where} from ${source ?? "the instruction data"}`;
    case "SetImmutable":
      idlOnly("makes immutable");
      return `Makes ${where} immutable: it can never change again`;
    case "Trim":
      if (on?.idl === true && leaves) {
        risks.push(`it trims the IDL account and sends its spare lamports to ${destination}, outside the vault`);
      }
      return `Trims ${where} to its data; the spare lamports go to ${nobody(destination)}`;
    case "Close":
      if (on?.idl === true && leaves) {
        risks.push(`it closes the IDL account and sends its lamports to ${destination}, outside the vault`);
      }
      return `Closes ${where}; its lamports go to ${nobody(destination)}`;
    case "Allocate":
      if (fields.seed !== null && fields.seed !== undefined && on?.idl !== true) {
        risks.push(`it allocates ${where} with seed "${fields.seed}" for a program's metadata`);
      }
      return `Allocates ${where} as a buffer${fields.seed === null || fields.seed === undefined ? "" : ` with seed "${fields.seed}"`}`;
    case "Extend":
      return `Extends ${where} by ${fields.length ?? 0} bytes`;
  }
}

export async function describeMetadata(chain: Chain, ix: Instruction, ctx: MetadataContext): Promise<MetadataReview> {
  const result = decodeMetadataInstruction(ix);
  if ("malformed" in result) {
    return {
      summary: `Program metadata instruction that does not decode at the ${PROGRAM_METADATA_CLIENT} layout: ${result.malformed}`,
      problem: `instruction ${ctx.position} is a program-metadata instruction that does not decode at the ${PROGRAM_METADATA_CLIENT} layout (${result.malformed}), so approving it would sign for an effect the tool cannot show`,
    };
  }
  const d = result.decoded;
  const idl = await canonicalMetadata(ENGINE);
  const authority = slotOf(d, "authority");
  const onSlot = d.slots[0];
  const on = onSlot === undefined || onSlot.address === null ? null : await target(chain, { ...onSlot, address: onSlot.address }, idl, authority, ctx);
  const risks: string[] = [];
  if (on !== null && !on.idl && on.state.kind === "metadata") {
    risks.push(`it acts on ${on.text}`);
  }
  const bufferAt = d.name === "SetData" ? (slotOf(d, "buffer")?.address ?? null) : null;
  const source = bufferAt === null ? null : await bufferSource(chain, bufferAt, d.fields);
  const copiedAt = d.name === "Write" && d.fields.data === null ? (slotOf(d, "source buffer")?.address ?? null) : null;
  const copied = copiedAt === null ? null : await copySource(chain, copiedAt, ctx);
  const head = headline(d, on, source?.text ?? copied?.text ?? null, ctx, risks);
  const accounts = d.slots.map((slot) => slotText(slot, ctx, risks));
  const extra = d.extra === 0 ? "" : `; it passes ${d.extra} more accounts`;
  const summary = `Program metadata ${d.name}: ${head}${on?.note ?? ""}; accounts: ${accounts.join(", ")}${extra}; ${fieldText(d.fields, bufferAt ?? copiedAt)}`;
  const vault = ctx.vault;
  const changesIdl = d.name === "SetData" || ((d.name === "Write" || d.name === "Initialize") && on?.idl === true);
  const sets: { sets?: SetTarget } = changesIdl && on !== null ? { sets: { account: on.address, sets: "idl" } } : {};
  const problem: { problem?: string } = copied?.problem === undefined ? {} : { problem: copied.problem };
  if (vault === null || !(ix.accounts ?? []).some((meta) => meta.address === vault && isSignerRole(meta.role))) {
    return { summary, ...(source === null ? {} : { buffer: source.check }), ...problem, ...sets };
  }
  if (authority?.address !== vault) {
    risks.push(`it passes the vault's signature in a role other than the authority`);
  }
  return {
    summary: risks.length === 0 ? summary : `${summary}; it receives the vault's signature`,
    ...(source === null ? {} : { buffer: source.check }),
    ...problem,
    ...(risks.length === 0 ? {} : { relayed: metadataRelayedText(ctx.position, vault, risks) }),
    ...sets,
  };
}
