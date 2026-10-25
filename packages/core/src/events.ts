import {
  IntentEngineEvent,
  parseAccountMigratedEvent,
  parseAgentPaidEvent,
  parseAnnounceFeeSetEvent,
  parseAnnouncementClosedEvent,
  parseCommitteeKeysSyncedEvent,
  parseDeliveryAnnouncedEvent,
  parseDeliveryBookClosedEvent,
  parseDeliveryReleasedEvent,
  parseReleaseRefutedEvent,
  identifyIntentEngineEvent,
  parseAdminAcceptedEvent,
  parseAdminProposedEvent,
  parseCapsRequiredSetEvent,
  parseClaimDroppedEvent,
  parseClaimantsListedEvent,
  parseClaimsClosedEvent,
  parseClaimsOpenedEvent,
  parseJobClaimedEvent,
  parseLineLeftEvent,
  parseProfileClosedEvent,
  parseProfileSetEvent,
  parseStakeMovedEvent,
  parseStoodByEvent,
  parseCommitteeAttestedEvent,
  parseCommitteeCreatedEvent,
  parseCommitteeFloorSetEvent,
  parseConfigInitializedEvent,
  parseConfigUpdatedEvent,
  parseEconomicsUpdatedEvent,
  parseEpochAdvancedEvent,
  parseFeeWithheldEvent,
  parseHeldShareClaimedEvent,
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
  parseLegacyClosedEvent,
  parseMintCapSetEvent,
  parseNonceAdvancedEvent,
  parsePauseLoweredEvent,
  parsePauseRaisedEvent,
  parseRelayerPaidEvent,
  parseShareHeldEvent,
  parseUserInitializedEvent,
} from "../generated/client/index.js";

export const EVENT_IX_TAG = new Uint8Array([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export type EngineEventName = (typeof IntentEngineEvent)[IntentEngineEvent];

const PARSERS = {
  AccountMigrated: parseAccountMigratedEvent,
  AdminAccepted: parseAdminAcceptedEvent,
  AgentPaid: parseAgentPaidEvent,
  AnnounceFeeSet: parseAnnounceFeeSetEvent,
  AnnouncementClosed: parseAnnouncementClosedEvent,
  CommitteeKeysSynced: parseCommitteeKeysSyncedEvent,
  DeliveryAnnounced: parseDeliveryAnnouncedEvent,
  DeliveryBookClosed: parseDeliveryBookClosedEvent,
  DeliveryReleased: parseDeliveryReleasedEvent,
  ReleaseRefuted: parseReleaseRefutedEvent,
  AdminProposed: parseAdminProposedEvent,
  CapsRequiredSet: parseCapsRequiredSetEvent,
  ClaimDropped: parseClaimDroppedEvent,
  ClaimantsListed: parseClaimantsListedEvent,
  ClaimsClosed: parseClaimsClosedEvent,
  ClaimsOpened: parseClaimsOpenedEvent,
  JobClaimed: parseJobClaimedEvent,
  LineLeft: parseLineLeftEvent,
  ProfileClosed: parseProfileClosedEvent,
  ProfileSet: parseProfileSetEvent,
  StakeMoved: parseStakeMovedEvent,
  StoodBy: parseStoodByEvent,
  CommitteeAttested: parseCommitteeAttestedEvent,
  CommitteeCreated: parseCommitteeCreatedEvent,
  CommitteeFloorSet: parseCommitteeFloorSetEvent,
  ConfigInitialized: parseConfigInitializedEvent,
  ConfigUpdated: parseConfigUpdatedEvent,
  EconomicsUpdated: parseEconomicsUpdatedEvent,
  EpochAdvanced: parseEpochAdvancedEvent,
  FeeWithheld: parseFeeWithheldEvent,
  HeldShareClaimed: parseHeldShareClaimedEvent,
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
  LegacyClosed: parseLegacyClosedEvent,
  MintCapSet: parseMintCapSetEvent,
  NonceAdvanced: parseNonceAdvancedEvent,
  PauseLowered: parsePauseLoweredEvent,
  PauseRaised: parsePauseRaisedEvent,
  RelayerPaid: parseRelayerPaidEvent,
  ShareHeld: parseShareHeldEvent,
  UserInitialized: parseUserInitializedEvent,
} satisfies Record<EngineEventName, (data: Uint8Array) => object>;

export type EngineEvent = {
  [K in EngineEventName]: { name: K; notable: boolean; fields: ReturnType<(typeof PARSERS)[K]> };
}[EngineEventName];

export const NOTABLE = new Set([
  "AdminAccepted",
  "AdminProposed",
  "AnnounceFeeSet",
  "CapsRequiredSet",
  "CommitteeCreated",
  "CommitteeFloorSet",
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
  let name: EngineEventName;
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
