import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { JudgeRefused } from "./judge-errors.js";

export const SECCOMP_SOURCE = "https://github.com/moby/profiles/blob/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json";

export const SECCOMP_DEFAULT_SHA256 = "6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6";

export const SCHEDULING_SYSCALLS: readonly string[] = ["sched_setaffinity", "sched_setattr", "sched_setparam", "sched_setscheduler", "setpriority"];

type Rule = { names: string[]; action: string } & Record<string, unknown>;

type Profile = { defaultAction: string; syscalls: Rule[] } & Record<string, unknown>;

export function seccompPath(): string {
  const candidates = ["../assets/seccomp-default.json", "../../assets/seccomp-default.json"].map((relative) => fileURLToPath(new URL(relative, import.meta.url)));
  return candidates.find((path) => existsSync(path)) ?? (candidates[0] as string);
}

export function withoutScheduling(profile: Profile): Profile {
  if (profile.defaultAction !== "SCMP_ACT_ERRNO") {
    throw new Error("the default seccomp profile does not deny what it does not list");
  }
  const syscalls = profile.syscalls
    .map((rule) => (rule.action === "SCMP_ACT_ALLOW" ? { ...rule, names: rule.names.filter((name) => !SCHEDULING_SYSCALLS.includes(name)) } : rule))
    .filter((rule) => rule.names.length > 0);
  return { ...profile, syscalls };
}

export async function nodeSeccomp(path: string = seccompPath()): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new JudgeRefused(`the plain Node seccomp profile ${path} is missing; reinstall the CLI. Nothing was run or paid`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== SECCOMP_DEFAULT_SHA256) {
    throw new JudgeRefused(`the plain Node seccomp profile ${path} has sha256 ${sha256}, not the pinned ${SECCOMP_DEFAULT_SHA256}; nothing was run or paid`);
  }
  return JSON.stringify(withoutScheduling(JSON.parse(bytes.toString("utf8")) as Profile));
}
