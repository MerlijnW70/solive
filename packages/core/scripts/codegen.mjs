import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createFromRoot } from "codama";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";

const idlPath = fileURLToPath(new URL("../../../idl/intent_engine.json", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const idl = JSON.parse(readFileSync(idlPath, "utf8"));
const aliases = new Map(
  (idl.types ?? []).filter((t) => t.type.kind === "type").map((t) => [t.name, t.type.alias]),
);
const resolve = (node, seen = new Set()) => {
  if (Array.isArray(node)) {
    return node.map((n) => resolve(n, seen));
  }
  if (node !== null && typeof node === "object") {
    if (node.defined !== undefined && aliases.has(node.defined.name)) {
      if (seen.has(node.defined.name)) {
        throw new Error(`IDL type alias ${node.defined.name} refers to itself`);
      }
      return resolve(aliases.get(node.defined.name), new Set([...seen, node.defined.name]));
    }
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolve(v, seen)]));
  }
  return node;
};
const unclaimed = (instruction) => ({
  ...instruction,
  accounts: instruction.accounts.map((account) => {
    if (account.optional !== true || (account.pda === undefined && account.address === undefined)) return account;
    const { pda: _derived, address: _fixed, ...rest } = account;
    return rest;
  }),
});
const flat = resolve({
  ...idl,
  instructions: idl.instructions.map(unclaimed),
  types: (idl.types ?? []).filter((t) => !aliases.has(t.name)),
});
await createFromRoot(rootNodeFromAnchor(flat)).accept(
  renderVisitor(packageRoot, {
    generatedFolder: "generated/client",
    syncPackageJson: false,
    importExtension: "js",
    kitImportStrategy: "rootOnly",
    erasableSyntax: true,
  }),
);

writeFileSync(
  fileURLToPath(new URL("../generated/idl.json", import.meta.url)),
  `${JSON.stringify(idl, null, 2)}
`,
);

const words = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
const engineErrors = (idl.errors ?? []).map(({ code, name, msg }) => `  { code: ${code}, name: ${JSON.stringify(name)}, message: ${JSON.stringify(msg ?? words(name))} },`);
writeFileSync(
  fileURLToPath(new URL("../generated/engine-errors.ts", import.meta.url)),
  [
    "export type EngineErrorEntry = { readonly code: number; readonly name: string; readonly message: string };",
    "",
    "export const ENGINE_ERROR_LIST: readonly EngineErrorEntry[] = [",
    ...engineErrors,
    "];",
    "",
  ].join("\n"),
);
