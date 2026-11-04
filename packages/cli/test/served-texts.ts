import { type Serving, servedActions } from "../src/agent/everyday.js";
import { marketFor, proseFor } from "../src/agent/mcp.js";
import type { AnyAction } from "../src/agent/actions.js";

export const SERVINGS: Readonly<Record<string, Serving>> = {
  "--wallet": { wallet: true, allTools: false, relay: false, agent: false },
  "--wallet --relayer": { wallet: true, allTools: false, relay: true, agent: false },
  "--wallet --agent": { wallet: true, allTools: false, relay: false, agent: true },
  "--wallet --relayer --agent": { wallet: true, allTools: false, relay: true, agent: true },
  "--wallet --all-tools": { wallet: true, allTools: true, relay: false, agent: false },
};

export const EVERYDAY = servedActions({ wallet: true, allTools: false, relay: false, agent: false });

export const EVERY = servedActions({ wallet: true, allTools: true, relay: false, agent: false });

export const proseOf = (served: readonly AnyAction[] = EVERYDAY): string => proseFor(served).join("\n");

export const guideOf = (served: readonly AnyAction[] = EVERYDAY): string => marketFor(served).join("\n");
