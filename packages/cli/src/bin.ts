#!/usr/bin/env node
export const REQUIRED_NODE = "22.12.0";

const parts = (version: string): number[] => version.split(".").map((part) => Number.parseInt(part, 10) || 0);

export function nodeTooOld(found: string, required: string = REQUIRED_NODE): boolean {
  const have = parts(found);
  const need = parts(required);
  for (let index = 0; index < need.length; index += 1) {
    const difference = (have[index] ?? 0) - (need[index] ?? 0);
    if (difference !== 0) {
      return difference < 0;
    }
  }
  return false;
}

const DOWNLOAD = ["https:", "", "nodejs.org", "en", "download"].join("/");

export const oldNodeMessage = (found: string, required: string = REQUIRED_NODE): string =>
  `This tool needs Node.js ${required} or newer, but this is Node.js ${found}. Download a current version at ${DOWNLOAD}`;

const found = process.versions.node;

if (nodeTooOld(found)) {
  process.stderr.write(`${oldNodeMessage(found)}\n`);
  process.exitCode = 1;
} else {
  const { runProcess } = await import("./main.js");
  const { quietWebCryptoWarnings } = await import("./node-warnings.js");
  const { trustSystemCertificates } = await import("./system-ca.js");
  quietWebCryptoWarnings();
  trustSystemCertificates();
  process.exitCode = await runProcess(process);
}
