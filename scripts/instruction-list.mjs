import { readFileSync } from "node:fs";

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const fail = (why) => {
  process.stderr.write(`refusing: ${why}\n`);
  process.exit(1);
};

function base58(text) {
  let value = 0n;
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) fail(`${text} is not base58`);
    value = value * 58n + BigInt(digit);
  }
  const bytes = [];
  while (value > 0n) {
    bytes.unshift(Number(value % 256n));
    value /= 256n;
  }
  for (const char of text) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

const text = readFileSync(0, "utf8");
const transactions = text.split(/^\[Transaction #\d+\]$/m).slice(1);
if (transactions.length !== 1) fail(`the export holds ${transactions.length} transactions, and one proposal carries one`);
const instructions = (transactions[0] ?? "")
  .split(/^------ IX #\d+ ------$/m)
  .slice(1)
  .map((block) => block.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim() !== ""))
  .filter((lines) => lines[0]?.trim() !== COMPUTE_BUDGET)
  .map((lines) => {
    if (lines.length < 2) fail("an exported instruction has no data line");
    const [program, ...rest] = lines;
    const data = rest.pop();
    const accounts = rest.map((line) => {
      const [address, ...flags] = line.trim().split(/\s+/);
      return { address, signer: flags.includes("S"), writable: flags.includes("W") };
    });
    return { program: program.trim(), accounts, data: base58(data.trim()).toString("base64") };
  });
if (instructions.length === 0) fail("the export holds no instruction besides compute budget ones");
process.stdout.write(`${JSON.stringify({ unsigned: { instructions } })}\n`);
