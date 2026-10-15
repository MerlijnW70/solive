import type { Address, KeyPairSigner } from "@solana/kit";
import {
  buildClaimJob,
  buildCloseProfile,
  buildCreateProfile,
  buildDropClaim,
  buildOpenClaims,
  buildSettleClaims,
  buildUpdateProfile,
  claimBoardAddress,
  claimUntil,
  findIntentPda,
  formatAmount,
  IntentCoreError,
  IntentStatus,
  profileAddress,
  stakeReceiverOnSettle,
} from "@intent-engine/core";
import { type ClaimsView, type Client, createClient, type Transport } from "@intent-engine/client";
import { previewed } from "./admin-commands.js";
import type { Command } from "./command-types.js";
import { FlowRefused } from "./flows.js";
import type { Runtime } from "./runtime.js";

type ClaimCommand = Extract<
  Command,
  { name: "claims-show" | "claims-open" | "claims-take" | "claims-drop" | "claims-settle" | "profile-show" | "profile-set" | "profile-close" }
>;

const NONE = "11111111111111111111111111111111" as Address;

const sol = (lamports: bigint) => `${formatAmount(lamports, 9)} SOL`;

export const noClaims = (intent: Address) => `escrow ${intent} takes no claims; its owner opens them with claims open`;

export const heldBy = (intent: Address, worker: Address, secondsLeft: bigint) =>
  `${worker} holds the claim on escrow ${intent} for ${secondsLeft} more seconds; nothing was sent`;

export const NO_PROFILE = "has published no profile";

const claimsShown = (intent: Address, view: ClaimsView) => ({
  intent,
  board: view.board,
  state: view.state,
  worker: view.worker,
  until: view.until,
  seconds_left: view.secondsLeft,
  stake: view.stake,
  max_secs: view.maxSecs,
  owner: view.owner,
});

async function claimsOf(client: Client, owner: Address, nonce: bigint) {
  const [intent] = await findIntentPda({ owner, nonce });
  const view = await client.claims(owner, nonce);
  if (view === null) {
    throw new FlowRefused(noClaims(intent));
  }
  return { intent, view };
}

async function escrowOpen(client: Client, owner: Address, nonce: bigint, now: bigint) {
  const found = await client.intent(owner, nonce);
  return found !== null && found.intent.status === IntentStatus.Open && now < found.intent.expiresAt ? found.intent.expiresAt : null;
}

async function claimCommand(command: Extract<ClaimCommand, { name: `claims-${string}` }>, runtime: Runtime, transport: Transport, client: Client): Promise<object> {
  if (command.name === "claims-show") {
    const { intent, view } = await claimsOf(client, command.owner, command.nonce);
    return claimsShown(intent, view);
  }
  const signer = await runtime.loadSigner(command.keypair);
  if (command.name === "claims-open") {
    const [intent] = await findIntentPda({ owner: signer.address, nonce: command.nonce });
    const board = await claimBoardAddress(intent);
    if ((await client.claims(signer.address, command.nonce)) !== null) {
      throw new FlowRefused(`escrow ${intent} already takes claims on board ${board}`);
    }
    const instruction = await buildOpenClaims({ owner: signer, intent, maxSecs: command.maxSecs, stake: command.stake });
    const summary = [
      `Opens: claims on escrow ${intent}; a worker holds the job for up to ${command.maxSecs} seconds by staking ${sol(command.stake)}`,
      `Pays rent: ${signer.address}, for the claims board ${board}`,
    ];
    return previewed(transport, [instruction], signer, { intent, board, summary }, command.yes);
  }
  const { intent, view } = await claimsOf(client, command.owner, command.nonce);
  const shown = claimsShown(intent, view);
  switch (command.name) {
    case "claims-take":
      return takeClaim(command, signer, transport, client, intent, view, shown);
    case "claims-drop": {
      if (view.state !== "held" || view.worker !== signer.address) {
        throw new FlowRefused(`${signer.address} holds no claim on escrow ${intent}; nothing was sent`);
      }
      const summary = [`Drops: this worker's claim on escrow ${intent}`, `Returns: its stake of ${sol(view.stake)} to ${signer.address}`];
      return previewed(transport, [await buildDropClaim({ worker: signer, intent })], signer, { ...shown, summary }, command.yes);
    }
    case "claims-settle":
      return settleClaims(command, signer, transport, client, intent, view, shown);
  }
}

async function takeClaim(
  command: Extract<ClaimCommand, { name: "claims-take" }>,
  worker: KeyPairSigner,
  transport: Transport,
  client: Client,
  intent: Address,
  view: ClaimsView,
  shown: object,
) {
  if (view.state === "held" && view.worker !== null) {
    throw new FlowRefused(heldBy(intent, view.worker, view.secondsLeft));
  }
  if (command.secs > view.maxSecs) {
    throw new FlowRefused(`escrow ${intent} lets a worker hold its claim for at most ${view.maxSecs} seconds; pass a lower --secs`);
  }
  const now = await client.chainTime();
  const expiresAt = await escrowOpen(client, command.owner, command.nonce, now);
  if (expiresAt === null) {
    throw new FlowRefused(`escrow ${intent} is no longer open, so its job cannot be claimed`);
  }
  let until: bigint;
  try {
    until = claimUntil(view.maxSecs, now, command.secs, expiresAt);
  } catch (error) {
    throw error instanceof IntentCoreError ? new FlowRefused(`a claim of ${command.secs} seconds would outlive escrow ${intent}, which expires at ${expiresAt}`) : error;
  }
  const summary = [
    `Claims: escrow ${intent} until ${until}, ${command.secs} seconds; until then only ${worker.address} can be paid`,
    `Stakes: ${sol(view.stake)}, returned when a release pays this worker or it drops the claim, and lost to the owner if the claim lapses first`,
    ...(view.state === "lapsed" ? [`Ends: the lapsed claim of ${view.worker}, whose stake goes to the owner ${view.owner}`] : []),
  ];
  const instruction = await buildClaimJob({ worker, intent, owner: view.owner, secs: command.secs });
  return previewed(transport, [instruction], worker, { ...shown, summary }, command.yes);
}

async function settleClaims(
  command: Extract<ClaimCommand, { name: "claims-settle" }>,
  payer: KeyPairSigner,
  transport: Transport,
  client: Client,
  intent: Address,
  view: ClaimsView,
  shown: object,
) {
  const now = await client.chainTime();
  const open = (await escrowOpen(client, command.owner, command.nonce, now)) !== null;
  const board = { owner: view.owner, worker: view.worker ?? NONE, until: view.until, held: view.stake };
  let receiver: Address | null;
  try {
    receiver = stakeReceiverOnSettle(board, now, open);
  } catch (error) {
    if (error instanceof IntentCoreError && view.worker !== null) {
      throw new FlowRefused(`${heldBy(intent, view.worker, view.secondsLeft)}; settle once it lapses or the escrow closes`);
    }
    throw error;
  }
  if (open && receiver === null) {
    throw new FlowRefused(`escrow ${intent} is open and nobody holds its claim, so there is nothing to settle; nothing was sent`);
  }
  const summary = [
    receiver === null ? "Moves: no stake; nobody holds the claim" : `Moves: the stake of ${sol(view.stake)} to ${receiver}`,
    ...(open ? [] : [`Closes: the claims board ${view.board}, returning its rent to the owner ${view.owner}`]),
    `Pays the fee: ${payer.address}`,
  ];
  const instruction = await buildSettleClaims({ intent, owner: view.owner, ...(view.worker === null ? {} : { worker: view.worker }) });
  return previewed(transport, [instruction], payer, { ...shown, summary }, command.yes);
}

async function profileCommand(command: Extract<ClaimCommand, { name: `profile-${string}` }>, runtime: Runtime, transport: Transport, client: Client): Promise<object> {
  if (command.name === "profile-show") {
    const found = await client.profile(command.wallet);
    if (found === null) {
      throw new FlowRefused(`${command.wallet} ${NO_PROFILE}`);
    }
    return {
      wallet: found.wallet,
      profile: await profileAddress(found.wallet),
      skills: found.skills,
      endpoint: found.endpoint,
      doc_url: found.docUrl,
      doc_sha256: found.docSha256,
      updated_at: found.updatedAt,
    };
  }
  const wallet = await runtime.loadSigner(command.keypair);
  const profile = await profileAddress(wallet.address);
  const existing = await client.profile(wallet.address);
  if (command.name === "profile-close") {
    if (existing === null) {
      throw new FlowRefused(`${wallet.address} ${NO_PROFILE}; nothing was sent`);
    }
    const summary = [`Closes: the profile of ${wallet.address} and returns its rent to it`];
    return previewed(transport, [await buildCloseProfile({ wallet })], wallet, { wallet: wallet.address, profile, summary }, command.yes);
  }
  const input = { wallet, ...command.profile };
  const instruction = existing === null ? await buildCreateProfile(input) : await buildUpdateProfile(input);
  const { docUrl, docSha256 } = command.profile;
  const summary = [
    `${existing === null ? "Creates" : "Updates"}: the profile of ${wallet.address} at ${profile}`,
    `Skills: ${command.profile.skills.join(", ")}`,
    `Endpoint: ${command.profile.endpoint}`,
    docUrl === undefined ? "Document: none" : `Document: ${docUrl} with sha256 ${docSha256}`,
    ...(existing === null ? [`Pays rent: ${wallet.address}`] : []),
  ];
  const shown = { wallet: wallet.address, profile, action: existing === null ? "create" : "update", summary };
  return previewed(transport, [instruction], wallet, shown, command.yes);
}

export async function claimsCommand(command: ClaimCommand, runtime: Runtime, transport: Transport): Promise<object> {
  const client = createClient({ url: command.url, transport });
  switch (command.name) {
    case "profile-show":
    case "profile-set":
    case "profile-close":
      return profileCommand(command, runtime, transport, client);
    default:
      return claimCommand(command, runtime, transport, client);
  }
}
