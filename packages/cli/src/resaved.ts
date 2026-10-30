import { createHash } from "node:crypto";

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const CRLF = Buffer.from("\r\n");
const LF = Buffer.from("\n");

export const RESAVED =
  "a byte-order mark or line ends were added to the file, as PowerShell's Set-Content or an editor on Windows saves text; download it byte for byte, such as with curl.exe -o";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const withoutBom = (bytes: Buffer): Buffer => (bytes.subarray(0, BOM.length).equals(BOM) ? bytes.subarray(BOM.length) : bytes);

const lfEnds = (bytes: Buffer): Buffer => Buffer.from(bytes.toString("latin1").replaceAll("\r\n", "\n"), "latin1");

const lastEndDropped = (bytes: Buffer): Buffer[] =>
  [CRLF, LF].flatMap((end) => (bytes.length >= end.length && bytes.subarray(bytes.length - end.length).equals(end) ? [bytes.subarray(0, bytes.length - end.length)] : []));

export function resavedFrom(bytes: Uint8Array): string[] {
  const own = Buffer.from(bytes);
  const base = withoutBom(own);
  const forms = [base, lfEnds(base)].flatMap((form) => [form, ...lastEndDropped(form)]);
  const mine = sha256(own);
  return [...new Set(forms.map(sha256))].filter((digest) => digest !== mine);
}

export const isResaved = (bytes: Uint8Array, original: string): boolean => resavedFrom(bytes).includes(original.toLowerCase());
