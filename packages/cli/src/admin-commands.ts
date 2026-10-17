import {
  type Address,
  createNoopSigner,
  getBase58Decoder,
  getBase64Decoder,
  getBase64Encoder,
  type Instruction,
  isSignerRole,
  isWritableRole,
  type TransactionPartialSigner,
  type TransactionSigner,
} from "@solana/kit";
import {
  buildAcceptAdmin,
  buildProposeAdmin,
  buildUpdateConfig,
  buildInitConfig,
  buildLowerPause,
  buildRaisePause,
  buildUpdateEconomics,
  buildSetCapsRequired,
  buildSetMintCap,
  capWindow,
  findConfigPda,
  findMintCapAddress,
  feeBpsFor,
  kindBit,
  PAUSE_CREATE,
  PAUSE_FILL,
} from "@intent-engine/core";
import { chainTime, clusterDomain, loadConfig, loadMintCap, MissingAccount, type Transport } from "@intent-engine/client";
import type { Authority, Command } from "./command-types.js";
import type { Runtime } from "./runtime.js";
import { redactUrl } from "./render.js";
import { prepare } from "./agent/prepare.js";
import { KIND_NAMES, KINDS, preparedView } from "./agent/shapes.js";
import { NOT_SENT } from "./flows.js";

export const configExists = (config: Address): string =>
  `the engine is already set up on this cluster (config ${config}); change it with update-config, set-economics, raise-pause or lower-pause`;

export const AUTHORITY_NEXT =
  "import transaction_base58 into the multisig as a proposal (its blockhash and fee payer are replaced there), or build one from instructions; it carries no compute budget so it can run from a vault";

function instructionView(ix: Instruction) {
  return {
    program: ix.programAddress,
    accounts: (ix.accounts ?? []).map((meta) => ({
      address: meta.address,
      signer: isSignerRole(meta.role),
      writable: isWritableRole(meta.role),
    })),
    data: getBase64Decoder().decode(ix.data ?? new Uint8Array()),
  };
}

const kindList = (mask: bigint) =>
  KINDS.filter((kind) => (mask & kindBit(kind)) !== 0n)
    .map((kind) => KIND_NAMES[kind])
    .join(", ") || "none";

const pauseList = (flags: number) =>
  [...((flags & PAUSE_CREATE) !== 0 ? ["creating"] : []), ...((flags & PAUSE_FILL) !== 0 ? ["filling"] : [])].join(" and ") ||
  "nothing";

async function administer(
  transport: Transport,
  url: string,
  runtime: Runtime,
  by: Authority,
  build: (signer: TransactionSigner) => Promise<Instruction[]>,
  summary: (signer: Address) => string[],
  extra: object = {},
): Promise<object> {
  const cluster = { url: redactUrl(url), genesisHash: await transport.genesisHash() };
  if ("keypair" in by) {
    const signer = await runtime.loadSigner(by.keypair);
    const instructions = await build(signer);
    const described = { ...extra, cluster, summary: summary(signer.address) };
    if (!by.yes) {
      const simulated = await prepare(transport, instructions, signer.address);
      return { ...described, sent: false, units_consumed: simulated.unitsConsumed, next: NOT_SENT };
    }
    return { ...described, sent: true, signature: await transport.send(instructions, signer) };
  }
  const instructions = await build(createNoopSigner(by.authority));
  const unbudgeted: Transport = { ...transport, budget: async (ixs) => [...ixs] };
  const view = preparedView(await prepare(unbudgeted, instructions, by.authority));
  return {
    ...extra,
    cluster,
    summary: summary(by.authority),
    unsigned: {
      ...view,
      transaction_base58: getBase58Decoder().decode(getBase64Encoder().encode(view.transaction)),
      instructions: instructions.map(instructionView),
      next: AUTHORITY_NEXT,
    },
  };
}

export async function previewed(
  transport: Transport,
  instructions: Instruction[],
  signer: TransactionPartialSigner,
  shown: object,
  yes: boolean,
): Promise<object> {
  if (!yes) {
    const simulated = await prepare(transport, instructions, signer.address);
    return { ...shown, sent: false, units_consumed: simulated.unitsConsumed, next: NOT_SENT };
  }
  return { ...shown, sent: true, signature: await transport.send(instructions, signer) };
}

type AdminCommand = Extract<
  Command,
  {
    name:
      | "init-config"
      | "raise-pause"
      | "lower-pause"
      | "update-config"
      | "propose-admin"
      | "accept-admin"
      | "set-economics"
      | "set-mint-cap"
      | "set-caps-required";
  }
>;

const capLine = (cap: { maxPerOrder: bigint; windowCap: bigint; windowSecs: number }) =>
  `at most ${cap.maxPerOrder} raw units per intent and ${cap.windowCap} per ${cap.windowSecs} second window`;

export async function showMintCap(transport: Transport, mint: Address): Promise<object> {
  const found = await loadMintCap(transport, mint);
  if (found === null) {
    throw new MissingAccount(`${mint} has no cap: mint cap`, await findMintCapAddress(mint));
  }
  const { config } = await loadConfig(transport);
  const now = await chainTime(transport);
  const { cap } = found;
  const window = capWindow(cap, now);
  return {
    address: found.address,
    mint: cap.mint,
    maxPerOrder: cap.maxPerOrder,
    windowCap: cap.windowCap,
    windowSecs: cap.windowSecs,
    window: { start: window.start, ends: window.ends, used: window.used, left: window.left },
    capsRequired: config.capsRequired !== 0,
    summary: [
      `Intents selling ${mint} escrow ${capLine(cap)}`,
      `This window: ${window.used} used, ${window.left} left, until ${window.ends}`,
      config.capsRequired !== 0 ? "Caps are required: every create must pass this cap" : "Caps are off: creates ignore this cap until set-caps-required on",
    ],
  };
}

export async function adminCommand(command: AdminCommand, runtime: Runtime, transport: Transport): Promise<object> {
  switch (command.name) {
    case "init-config": {
      const [config] = await findConfigPda();
      if ((await transport.getAccount(config)) !== null) {
        throw new Error(configExists(config));
      }
      const domain = await clusterDomain(transport);
      return administer(
        transport,
        command.url,
        runtime,
        command.by,
        async (authority) => [
          await buildInitConfig({
            authority,
            domain,
            guardian: command.guardian,
            feeRecipient: command.feeRecipient,
            enabledKinds: command.enabledKinds,
            feeBps: command.feeBps,
            paused: command.paused,
          }),
        ],
        () => [
          `Creates the engine config ${config} for this cluster (domain ${getBase58Decoder().decode(domain)}) with the signer as admin`,
          `Guardian: ${command.guardian}`,
          `Fee recipient: ${command.feeRecipient}`,
          `Fee: ${command.feeBps} bps`,
          `Enabled kinds: ${kindList(command.enabledKinds)}`,
          `Paused: ${pauseList(command.paused)}`,
        ],
        { config, domain },
      );
    }
    case "raise-pause":
      return administer(
        transport,
        command.url,
        runtime,
        command.by,
        async (authority) => [await buildRaisePause({ authority, flags: command.flags })],
        () => [`Pauses ${pauseList(command.flags)} for every intent until the admin lowers the pause`],
      );
    case "lower-pause":
      return administer(
        transport,
        command.url,
        runtime,
        command.by,
        async (admin) => [await buildLowerPause({ admin, flags: command.flags })],
        () => [`Resumes ${pauseList(command.flags)}`],
      );
    case "update-config": {
      const { config } = await loadConfig(transport);
      const c = command.change;
      const update = {
        guardian: c.guardian ?? config.guardian,
        feeRecipient: c.feeRecipient ?? config.feeRecipient,
        feeBps: c.feeBps ?? config.feeBps,
        enabledKinds: c.enabledKinds ?? config.enabledKinds,
        fillDisabledKinds: c.fillDisabledKinds ?? config.fillDisabledKinds,
      };
      const changes = [
        ...(update.guardian === config.guardian ? [] : [`Guardian: ${config.guardian} -> ${update.guardian}`]),
        ...(update.feeRecipient === config.feeRecipient ? [] : [`Fee recipient: ${config.feeRecipient} -> ${update.feeRecipient}`]),
        ...(update.feeBps === config.feeBps ? [] : [`Fee: ${config.feeBps} -> ${update.feeBps} bps`]),
        ...(update.enabledKinds === config.enabledKinds
          ? []
          : [`Enabled kinds: ${kindList(config.enabledKinds)} -> ${kindList(update.enabledKinds)}`]),
        ...(update.fillDisabledKinds === config.fillDisabledKinds
          ? []
          : [`Fills stopped for: ${kindList(config.fillDisabledKinds)} -> ${kindList(update.fillDisabledKinds)}`]),
      ];
      return administer(
        transport,
        command.url,
        runtime,
        command.by,
        async (admin) => [await buildUpdateConfig({ admin, update })],
        () => (changes.length === 0 ? ["Changes nothing: every setting already has the value given"] : changes),
        { update },
      );
    }
    case "propose-admin": {
      const { config } = await loadConfig(transport);
      return administer(
        transport,
        command.url,
        runtime,
        command.by,
        async (admin) => [await buildProposeAdmin({ admin, pendingAdmin: command.pendingAdmin })],
        () => [
          `Proposes ${command.pendingAdmin} as the next admin in place of ${config.admin}`,
          "Nothing changes until that key accepts; a later proposal replaces this one",
        ],
      );
    }
    case "accept-admin": {
      const { config } = await loadConfig(transport);
      return administer(
        transport,
        command.url,
        runtime,
        command.by,
        async (pendingAdmin) => [await buildAcceptAdmin({ pendingAdmin })],
        (signer) => [`Makes ${signer} the admin in place of ${config.admin}`],
      );
    }
    case "set-economics": {
      const { config } = await loadConfig(transport);
      const e = command.economics;
      const kindFees = KINDS.filter((kind) => (BigInt(e.kindFeeMask) & kindBit(kind)) !== 0n)
        .map((kind) => `${KIND_NAMES[kind]} ${feeBpsFor({ feeBps: config.feeBps, ...e }, kind)} bps`)
        .join(", ");
      return administer(
        transport,
        command.url,
        runtime,
        command.by,
        async (admin) => [await buildUpdateEconomics({ admin, economics: e })],
        () => [
          `Crank bounty: ${config.crankBounty} -> ${e.crankBounty} lamports per intent`,
          `Create fee: ${config.createFee} -> ${e.createFee} lamports per intent`,
          `Partner cut: ${config.partnerCutBps} -> ${e.partnerCutBps} bps of each partner fee`,
          `Kind fees: ${kindFees === "" ? "none; every kind pays the base fee" : kindFees}`,
        ],
      );
    }
    case "set-mint-cap": {
      const limits = { maxPerOrder: command.maxPerOrder, windowCap: command.windowCap, windowSecs: command.windowSecs };
      const [found, mintCap] = await Promise.all([loadMintCap(transport, command.mint), findMintCapAddress(command.mint)]);
      return administer(
        transport,
        command.url,
        runtime,
        command.by,
        async (admin) => [await buildSetMintCap({ admin, mint: command.mint, ...limits })],
        (signer) => [
          found === null
            ? `Creates the mint cap ${mintCap} for ${command.mint}, paid by ${signer}: ${capLine(limits)}`
            : `Mint cap of ${command.mint}: ${capLine(found.cap)} -> ${capLine(limits)}`,
          ...(found === null ? [] : [`Keeps the current window: ${found.cap.windowUsed} used since ${found.cap.windowStart}`]),
        ],
        { mintCap },
      );
    }
    case "set-caps-required": {
      const { config } = await loadConfig(transport);
      const now = config.capsRequired !== 0;
      return administer(
        transport,
        command.url,
        runtime,
        command.by,
        async (admin) => [await buildSetCapsRequired({ admin, required: command.required })],
        () => [
          `Caps required: ${now ? "on" : "off"} -> ${command.required ? "on" : "off"}`,
          command.required
            ? "Every create must then pass the input mint's cap, and a mint without a cap takes no new intents"
            : "Creates then ignore mint caps",
        ],
      );
    }
  }
}
