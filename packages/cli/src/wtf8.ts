export class Wtf8Refused extends Error {}

const CHUNK = 8192;
const SHORTEST = [0, 0, 0x80, 0x800, 0x10000];

const continues = (byte: number | undefined): boolean => byte !== undefined && (byte & 0xc0) === 0x80;

const refused = (why: string, at: number): never => {
  throw new Wtf8Refused(`${why} at byte ${at}`);
};

function lengthOf(lead: number, at: number): number {
  if (lead === 0xc0 || lead === 0xc1) return refused("a character written longer than it needs", at);
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  if (lead >= 0xf8) return refused("a byte UTF-8 never uses", at);
  if (lead >= 0xf5) return refused("a character above U+10FFFF", at);
  return refused("a continuation byte that starts no character", at);
}

export function wtf8Decode(bytes: Uint8Array): string {
  const units: number[] = [];
  let highTriple = false;
  let at = 0;
  while (at < bytes.length) {
    const lead = bytes[at] as number;
    if (lead < 0x80) {
      units.push(lead);
      highTriple = false;
      at += 1;
      continue;
    }
    const length = lengthOf(lead, at);
    let point = lead & (0xff >> (length + 1));
    for (let next = 1; next < length; next += 1) {
      const byte = bytes[at + next];
      if (!continues(byte)) refused("a character cut short", at);
      point = (point << 6) | ((byte as number) & 0x3f);
    }
    if (point < (SHORTEST[length] ?? 0)) refused("a character written longer than it needs", at);
    if (point > 0x10ffff) refused("a character above U+10FFFF", at);
    if (point >= 0x10000) {
      units.push(0xd800 | ((point - 0x10000) >> 10), 0xdc00 | ((point - 0x10000) & 0x3ff));
      highTriple = false;
    } else {
      if (highTriple && point >= 0xdc00 && point <= 0xdfff) refused("a surrogate pair written as two triples", at - 3);
      units.push(point);
      highTriple = point >= 0xd800 && point <= 0xdbff;
    }
    at += length;
  }
  let text = "";
  for (let from = 0; from < units.length; from += CHUNK) {
    text += String.fromCharCode(...units.slice(from, from + CHUNK));
  }
  return text;
}

export function wtf8Encode(text: string): Buffer {
  const bytes: number[] = [];
  for (const char of text) {
    const point = char.codePointAt(0) as number;
    if (point < 0x80) {
      bytes.push(point);
    } else if (point < 0x800) {
      bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    } else if (point < 0x10000) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else {
      bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    }
  }
  return Buffer.from(bytes);
}
