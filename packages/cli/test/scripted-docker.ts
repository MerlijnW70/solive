import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProbeLimits } from "../src/sandbox-doctor.js";

export type Answer = { code: number; out?: string };

export type Plan = {
  version?: Answer;
  imageId?: Answer;
  imageEnv?: Answer;
  pull?: Answer;
  runs?: { match: string; code: number; oom?: boolean }[];
  unlink?: boolean;
};

export type Call = { args: string[]; stdout: string };

export const FAST_LIMITS: ProbeLimits = { probeSeconds: 20, timeoutProbeSeconds: 2 };

const quoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

const reply = (answer: Answer): string => `printf '%s' ${quoted(answer.out ?? "")}; exit ${answer.code}`;

export const scriptedDocker = (log: string, tmp: string, plan: Plan): string => {
  const runs = (plan.runs ?? []).map(({ match, code, oom }) => `    *${quoted(match)}*) code=${code}; oom=${oom === true};;`).join("\n");
  return `#!/bin/sh
PATH=/usr/bin:/bin
printf '%s\\0' "$#" "$(readlink /proc/$$/fd/1 2> /dev/null)" "$@" >> ${quoted(log)}
all="$*"
case "$1" in
  version) ${reply(plan.version ?? { code: 0, out: "27.0.0" })};;
  image)
    case "$all" in
      *'{{.Id}}'*) ${reply(plan.imageId ?? { code: 0, out: "sha256:feed" })};;
      *) ${reply(plan.imageEnv ?? { code: 0, out: "null" })};;
    esac;;
  pull) ${reply(plan.pull ?? { code: 1 })};;
  run)
    ${plan.unlink === true ? `ls ${quoted(tmp)} | grep -E '^sandbox-doctor-(canary-[0-9a-f]+\\.json|[0-9a-f]{12}\\.txt)$' | while read -r name; do rm -f ${quoted(tmp)}/"$name"; done` : ":"}
    code=0; oom=false
    case "$all" in
${runs}
    esac
    printf '{"Running":false,"ExitCode":%s,"OOMKilled":%s,"Error":"","StartedAt":"2026-01-01T00:00:00Z"}' "$code" "$oom" > ${quoted(dirname(log))}/"state-$3"
    exit "$code";;
  container)
    if [ "$3" = --format ] && [ -f ${quoted(dirname(log))}/"state-$5" ]; then
      cat ${quoted(dirname(log))}/"state-$5"
      exit 0
    fi
    exit 1;;
  *) exit 0;;
esac
`;
};

export async function readCalls(log: string): Promise<Call[]> {
  const fields = (await readFile(log, "utf8").catch(() => "")).split("\0");
  fields.pop();
  const calls: Call[] = [];
  for (let at = 0; at < fields.length; ) {
    const count = Number(fields[at]);
    calls.push({ stdout: fields[at + 1] ?? "", args: fields.slice(at + 2, at + 2 + count) });
    at += 2 + count;
  }
  return calls;
}
