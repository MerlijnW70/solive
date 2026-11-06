export const specText = (spec: Uint8Array): string => new TextDecoder().decode(spec);

export const fencedBlocks = (text: string, fence: string): string[] =>
  [...text.matchAll(new RegExp(`^\`\`\`${fence}[ \\t]*\\r?\\n([\\s\\S]*?)^\`\`\`[ \\t]*$`, "gm"))].map((block) => block[1] ?? "");

export const fenceMentions = (text: string, fence: string): number => [...text.matchAll(new RegExp(`(?:\`{3,}|~{3,})[ \\t]*${fence}(?![\\w-])`, "gi"))].length;

const OPENER = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export function plainOpeners(text: string, fence: string): number {
  const plain = new RegExp(`^\`\`\`${fence}[ \\t]*$`);
  let open: { char: string; length: number } | undefined;
  let count = 0;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const found = OPENER.exec(line);
    const marks = found?.[1] ?? "";
    const rest = found?.[2] ?? "";
    if (open !== undefined) {
      if (found !== null && marks[0] === open.char && marks.length >= open.length && rest.trim() === "") {
        open = undefined;
      }
      continue;
    }
    if (found === null || (marks[0] === "`" && rest.includes("`"))) {
      continue;
    }
    count += plain.test(line) ? 1 : 0;
    open = { char: marks[0] ?? "`", length: marks.length };
  }
  return count;
}

export type BlockRead = { bodies: string[]; mentions: number; plain: number };

export const readBlocks = (text: string, fence: string): BlockRead => ({ bodies: fencedBlocks(text, fence), mentions: fenceMentions(text, fence), plain: plainOpeners(text, fence) });

export const ambiguous = (read: BlockRead): boolean => read.mentions !== read.plain || read.bodies.length !== read.plain;

export const strayFence = (fence: string, mentions: number, plain: number): string =>
  `has ${mentions} fence${mentions === 1 ? "" : "s"} that open${mentions === 1 ? "s" : ""} a ${fence} block, of which ${plain} ${plain === 1 ? "is" : "are"} a plain top-level \`\`\`${fence} line closed by \`\`\`; write each that way: not indented, quoted, in a list or inside another fenced block, with three backticks and nothing before or after the name`;

const COLON = /\s*:/y;

export function topKeys(json: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let at = 0;
  while (at < json.length) {
    const char = json[at];
    if (char === '"') {
      let end = at + 1;
      while (end < json.length && json[end] !== '"') {
        end += json[end] === "\\" ? 2 : 1;
      }
      const literal = json.slice(at, end + 1);
      at = end + 1;
      COLON.lastIndex = at;
      if (depth === 1 && COLON.test(json)) {
        keys.push(JSON.parse(literal) as string);
      }
      continue;
    }
    depth += char === "{" || char === "[" ? 1 : char === "}" || char === "]" ? -1 : 0;
    at += 1;
  }
  return keys;
}

export function blockFields(body: string, known: readonly string[], refuse: (why: string) => never, unique = false): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return refuse(`is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("is not a JSON object");
  }
  const fields = parsed as Record<string, unknown>;
  const unknown = Object.keys(fields).find((key) => !known.includes(key));
  if (unknown !== undefined) {
    return refuse(`has a field ${JSON.stringify(unknown)} it does not know`);
  }
  const twice = unique ? topKeys(body).find((key, index, all) => all.indexOf(key) !== index) : undefined;
  if (twice !== undefined) {
    return refuse(`has the field ${JSON.stringify(twice)} more than once`);
  }
  return fields;
}
