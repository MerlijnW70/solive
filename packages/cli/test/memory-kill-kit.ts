import { INFRA_NEXT, oomInfra, oomInfraUnpinned } from "../src/judge-errors.js";
import { killedUnflagged, killedUnflaggedUnpinned } from "../src/verdict-model.js";

const infra = (reason: string): string => `infrastructure error, not a verdict: ${reason}; ${INFRA_NEXT}`;

export const chosenMemoryKills = (memory: string, inBlock = false): string[] =>
  inBlock ? [infra(oomInfraUnpinned(memory)), infra(killedUnflaggedUnpinned(memory))] : [infra(oomInfra(memory)), infra(killedUnflagged(memory))];
