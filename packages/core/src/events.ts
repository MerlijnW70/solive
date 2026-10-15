import {
  IntentEngineEvent,
  parseAgentPaidEvent,
  identifyIntentEngineEvent,
  parseAdminAcceptedEvent,
  parseAdminProposedEvent,
  parseCapsRequiredSetEvent,
  parseConfigInitializedEvent,
  parseConfigUpdatedEvent,
  parseEconomicsUpdatedEvent,
  parseEpochAdvancedEvent,
  parseFeeWithheldEvent,
  parseFillBegunEvent,
  parseFillEndedEvent,
  parseIntentAttestedEvent,
  parseIntentCancelledEvent,
  parseIntentClosedEvent,
  parseIntentCreatedEvent,
  parseIntentExpiredEvent,
  parseIntentFilledEvent,
  parseIntentSplitEvent,
  parseMandateClosedEvent,
  parseMandateCreatedEvent,
  parseMandateUsedEvent,
  parseMintCapSetEvent,
  parseNonceAdvancedEvent,
  parsePauseLoweredEvent,
  parsePauseRaisedEvent,
  parseRelayerPaidEvent,
  parseUserInitializedEvent,
} from "../generated/client/index.js";

export const EVENT_IX_TAG = new Uint8Array([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

type EventName = (typeof IntentEngineEvent)[IntentEngineEvent];

const PARSERS = {
  AdminAccepted: parseAdminAcceptedEvent,
  AgentPaid: parseAgentPaidEvent,
  AdminProposed: parseAdminProposedEvent,
  CapsRequiredSet: parseCapsRequiredSetEvent,
  ConfigInitialized: parseConfigInitializedEvent,
  ConfigUpdated: parseConfigUpdatedEvent,
  EconomicsUpdated: parseEconomicsUpdatedEvent,
  EpochAdvanced: parseEpochAdvancedEvent,
  FeeWithheld: parseFeeWithheldEvent,
  FillBegun: parseFillBegunEvent,
  FillEnded: parseFillEndedEvent,
  IntentAttested: parseIntentAttestedEvent,
  IntentCancelled: parseIntentCancelledEvent,
  IntentClosed: parseIntentClosedEvent,
  IntentCreated: parseIntentCreatedEvent,
  IntentExpired: parseIntentExpiredEvent,
  IntentFilled: parseIntentFilledEvent,
  IntentSplit: parseIntentSplitEvent,
  MandateClosed: parseMandateClosedEvent,
  MandateCreated: parseMandateCreatedEvent,
  MandateUsed: parseMandateUsedEvent,
  MintCapSet: parseMintCapSetEvent,
  NonceAdvanced: parseNonceAdvancedEvent,
  PauseLowered: parsePauseLoweredEvent,
  PauseRaised: parsePauseRaisedEvent,
  RelayerPaid: parseRelayerPaidEvent,
  UserInitialized: parseUserInitializedEvent,
} satisfies Record<EventName, (data: Uint8Array) => object>;

export type EngineEvent = {
  [K in EventName]: { name: K; notable: boolean; fields: ReturnType<(typeof PARSERS)[K]> };
}[EventName];

export const NOTABLE = new Set([
  "AdminAccepted",
  "AdminProposed",
  "CapsRequiredSet",
  "ConfigInitialized",
  "ConfigUpdated",
  "EconomicsUpdated",
  "MandateClosed",
  "MandateCreated",
  "MintCapSet",
  "PauseLowered",
  "PauseRaised",
]);

export type DecodedEvent = { name: string; notable: boolean; fields: object };

export function decodeEvent(data: Uint8Array): DecodedEvent | null {
  if (!EVENT_IX_TAG.every((b, i) => data[i] === b)) {
    return null;
  }
  const body = data.subarray(EVENT_IX_TAG.length);
  let name: EventName;
  try {
    name = IntentEngineEvent[identifyIntentEngineEvent(body)];
  } catch {
    return null;
  }
  try {
    return { name, notable: NOTABLE.has(name), fields: PARSERS[name](body) };
  } catch {
    return null;
  }
}

export function eventNamed<E extends EngineEvent, N extends E["name"]>(events: readonly E[], name: N): Extract<E, { name: N }> | undefined {
  return events.find((event): event is Extract<E, { name: N }> => event.name === name);
}
