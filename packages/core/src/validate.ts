import { type Address, type Instruction, isSignerRole, isWritableRole, type ReadonlyUint8Array } from "@solana/kit";

type Bytes = ReadonlyUint8Array | Uint8Array;

type IdlType =
  | string
  | { array: [IdlType, number] }
  | { vec: IdlType }
  | { defined: { name: string } }
  | { option: IdlType };

type IdlField = { name: string; type: IdlType };

export type IdlLike = {
  address: string;
  instructions: {
    name: string;
    discriminator: number[];
    accounts: {
      name: string;
      signer?: boolean;
      writable?: boolean;
      optional?: boolean;
      address?: string;
    }[];
    args: IdlField[];
  }[];
  types?: { name: string; type: { kind: string; fields?: IdlField[]; alias?: IdlType } }[];
};

const PRIMITIVE: Record<string, number> = {
  bool: 1,
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  u64: 8,
  i64: 8,
  u128: 16,
  i128: 16,
  pubkey: 32,
};

const MAX_TYPE_DEPTH = 32;

function walk(type: IdlType, data: Bytes, at: number, idl: IdlLike, depth = 0): number | undefined {
  if (depth > MAX_TYPE_DEPTH) {
    return undefined;
  }
  if (type === "bytes") {
    if (at + 4 > data.length) {
      return at + 4;
    }
    return at + 4 + new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(at, true);
  }
  if (typeof type === "string") {
    const size = PRIMITIVE[type];
    return size === undefined ? undefined : at + size;
  }
  if ("array" in type) {
    let end: number | undefined = at;
    for (let i = 0; i < type.array[1] && end !== undefined; i++) {
      end = walk(type.array[0], data, end, idl, depth + 1);
    }
    return end;
  }
  if ("vec" in type) {
    if (at + 4 > data.length) {
      return at + 4;
    }
    const count = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(at, true);
    let end = at + 4;
    for (let i = 0; i < count && end <= data.length; i++) {
      const next = walk(type.vec, data, end, idl, depth + 1);
      if (next === undefined || next === end) {
        return next;
      }
      end = next;
    }
    return end;
  }
  if ("defined" in type) {
    const def = idl.types?.find((t) => t.name === type.defined.name);
    if (def?.type.kind === "struct" && def.type.fields) {
      return walkFields(def.type.fields, data, at, idl, depth + 1);
    }
    if (def?.type.kind === "type" && def.type.alias !== undefined) {
      return walk(def.type.alias, data, at, idl, depth + 1);
    }
  }
  return undefined;
}

function walkFields(fields: IdlField[], data: Bytes, at: number, idl: IdlLike, depth = 0): number | undefined {
  let end: number | undefined = at;
  for (const f of fields) {
    if (end === undefined) {
      return undefined;
    }
    end = walk(f.type, data, end, idl, depth);
  }
  return end;
}

const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a.length === b.length && Array.from(a).every((x, i) => x === b[i]);

export function validateIxAgainstIdl(ix: Instruction, idl: IdlLike): string[] {
  const problems: string[] = [];
  if (ix.programAddress !== idl.address) {
    problems.push(`program ${ix.programAddress} is not ${idl.address}`);
  }
  const data = ix.data ?? new Uint8Array();
  const def = idl.instructions.find((i) =>
    sameBytes(data.slice(0, i.discriminator.length), i.discriminator),
  );
  if (!def) {
    return [...problems, "data does not start with any instruction discriminator"];
  }
  const want = walkFields(def.args, data, def.discriminator.length, idl);
  if (want === undefined) {
    problems.push(`${def.name}: arguments cannot be sized from the IDL`);
  } else if (data.length !== want) {
    problems.push(`${def.name}: data is ${data.length} bytes, expected ${want}`);
  }
  const metas = ix.accounts ?? [];
  if (metas.length !== def.accounts.length) {
    problems.push(
      `${def.name}: ${metas.length} accounts, expected ${def.accounts.length}`,
    );
  }
  def.accounts.forEach((spec, i) => {
    const meta = metas[i];
    if (!meta) {
      return;
    }
    const omitted = spec.optional === true && meta.address === (idl.address as Address);
    if (omitted) {
      return;
    }
    if (spec.address !== undefined && meta.address !== spec.address) {
      problems.push(`${def.name}.${spec.name}: must be ${spec.address}, got ${meta.address}`);
    }
    if (spec.signer === true && !isSignerRole(meta.role)) {
      problems.push(`${def.name}.${spec.name}: must sign`);
    }
    if (spec.writable === true && !isWritableRole(meta.role)) {
      problems.push(`${def.name}.${spec.name}: must be writable`);
    }
  });
  return problems;
}
