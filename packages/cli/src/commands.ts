import {
  buildAdvanceEpoch,
  buildAdvanceNonce,
  buildCancelIntent,
  buildCloseIntent,
  committeeFloors,
  findIntentPda,
  findUserStatePda,
  findVaultPda,
  getUserStateDecoder,
  nextEpoch,
} from "@intent-engine/core/internal";
import { solverTableAccounts, tick } from "@intent-engine/solver";
import { cancelClaims, clusterDomain, createdAccount, loadConfig, loadIntent, tokenAccountIfMissing, tokenProgramOf } from "@intent-engine/client/internal";
import { agentServer } from "./agent/mcp.js";
import { servedActions } from "./agent/everyday.js";
import { claimsOf } from "./agent/claims.js";
import { budgetOf } from "./agent/budget.js";
import { ESTIMATE_SCAN, walletGuard } from "./agent/wallet.js";
import { relayOf } from "./agent/relay.js";
import { type Command, usageOf } from "./args.js";
import { VERSION } from "./version.js";
import { balances, CLI_SMALL_START, CLI_START, defaultMints, setup } from "./wallet.js";
import { FlowRefused } from "./flows.js";
import { describeIntent, quoteOf, sameBytes } from "./accounts.js";
import { closing, crank, expiring } from "./crank.js";
import { withPriority } from "./compute.js";
import { createTreasuryAccounts, intentInputMints, treasuryView } from "./treasury.js";
import { artifactSha256, judge } from "./judge.js";
import type { Runtime } from "./runtime.js";
import { adminCommand, previewed, showMintCap } from "./admin-commands.js";
import { jobCommand } from "./job-commands.js";
import { announceCommand } from "./announce-commands.js";
import { committeeCommand } from "./committee-commands.js";
import { reputationCommand } from "./reputation-commands.js";
import { claimsCommand } from "./claim-commands.js";
import { engineEvents } from "./event-feed.js";
import { SOLVER_TABLE_NEXT, solverOptions } from "./solve-commands.js";
import { flowCommand, signatureLookup } from "./flow-commands.js";
import { addTo } from "./add-to.js";
import { transactionSigner } from "./ledger-keys.js";
import { judgeDigest } from "./judge-digest.js";
import { floatCommand } from "./float-commands.js";
import { closeLegacy } from "./legacy-commands.js";
import { migrate } from "./migrate-commands.js";

export type { Runtime } from "./runtime.js";
export { AUTHORITY_NEXT, configExists } from "./admin-commands.js";
export { NOT_RELEASED } from "./agent/wallet.js";
export { follow, followGap } from "./event-feed.js";
export {
  decodedChanges,
  ENV_JUPITER_KEY,
  IN_FLIGHT_SECONDS,
  JUPITER_DOMAIN,
  jupiterHost,
  REFRESH_AFTER_SECONDS,
  SOLVER_TABLE_NEXT,
  stillOpen,
  watchSolve,
} from "./solve-commands.js";

import { newEncryptionKey, readJobSpec, sealing } from "./sealed-commands.js";

export * from "./accounts.js";
export * from "./crank.js";

export async function run(command: Command, runtime: Runtime): Promise<object | null> {
  if (command.name === "help") {
    return usageOf(command.verb);
  }
  if (command.name === "version") {
    return { version: VERSION };
  }
  if (command.name === "add-to") {
    return addTo(command.app, command.limits, runtime);
  }
  if (command.name === "seal" || command.name === "unseal") {
    return sealing(command, runtime);
  }
  if (command.name === "profile-encryption-key") {
    return newEncryptionKey(command.out, runtime);
  }
  if (command.name === "hash") {
    return { artifact: command.artifact, sha256: await artifactSha256(command.artifact) };
  }
  if (command.name === "pda") {
    const [intent] = await findIntentPda({ owner: command.owner, nonce: command.nonce });
    const [vault] = await findVaultPda({ intent });
    return { intent, vault };
  }
  const transport = withPriority(runtime.transport(command.url), command.priority);
  switch (command.name) {
    case "mcp": {
      const relay =
        command.relay === undefined ? undefined : relayOf(await runtime.loadSigner(command.relay.keypair), command.relay);
      const agent =
        command.agent === undefined
          ? undefined
          : {
              signer: await runtime.loadSigner(command.agent.keypair),
              budget: budgetOf(command.agent.hourlyLamports),
              owners: new Set(command.agent.owners),
            };
      const wallet =
        command.wallet === null
          ? {}
          : {
              wallet: {
                url: command.url,
                files: runtime,
                env: runtime.env,
                sleep: runtime.sleep,
                now: runtime.now,
                limits: walletGuard(command.wallet, runtime.saleBook),
                ...(command.feePayer === undefined ? {} : { feePayer: command.feePayer }),
                ...(command.encryptionKeypairs === undefined ? {} : { encryptionKeypairs: command.encryptionKeypairs }),
              },
            };
      if (command.wallet !== null) {
        transport.engineTransactions(ESTIMATE_SCAN).catch(() => undefined);
      }
      const served = servedActions({
        wallet: command.wallet !== null,
        allTools: command.allTools,
        relay: relay !== undefined,
        agent: agent !== undefined,
      });
      const confirm = command.confirmUrl === undefined ? {} : { confirm: runtime.transport(command.confirmUrl) };
      await runtime.serve(agentServer({ transport, relay, agent, claims: claimsOf(), url: command.url, fetch: runtime.specFetch, lookup: runtime.lookup, clock: { sleep: runtime.sleep, now: runtime.now }, ...wallet, ...confirm }, served));
      return null;
    }
    case "setup":
      return setup(transport, runtime, command.url, command.keypair, false, command.confirmUrl, command.confirmUrl === undefined ? undefined : runtime.transport(command.confirmUrl), CLI_START, CLI_SMALL_START, {
        file: command.faucet,
        launch: runtime.launch,
        sleep: (seconds) => runtime.sleep(seconds),
        now: runtime.now,
        note: (text) => process.stderr.write(`${text}\n`),
      });
    case "balance": {
      const owner = command.owner ?? (await runtime.loadSigner(command.keypair ?? "")).address;
      return balances(transport, owner, command.mints ?? defaultMints(command.url));
    }
    case "domain":
      return { genesisHash: await transport.genesisHash(), domain: await clusterDomain(transport) };
    case "show-config": {
      const { address, config } = await loadConfig(transport);
      const fields = Object.fromEntries(Object.entries(config).filter(([field]) => field !== "floorMints" && field !== "floorAmounts"));
      return { address, ...fields, committeeFloors: committeeFloors(config), domainMatchesCluster: sameBytes(config.domain, await clusterDomain(transport)) };
    }
    case "show-intent": {
      const { address, intent } = await loadIntent(transport, command.owner, command.nonce);
      return describeIntent(address, intent);
    }
    case "quote": {
      const { address, intent } = await loadIntent(transport, command.owner, command.nonce);
      return { address, ...quoteOf(intent, command.at ?? runtime.now()) };
    }
    case "cancel": {
      const owner = await transactionSigner(runtime, command.keypair);
      const { address, intent } = await loadIntent(transport, owner.address, command.nonce);
      const ref = { nonce: command.nonce, inputMint: intent.inputMint, tokenProgram: await tokenProgramOf(transport, intent.inputMint), capped: intent.capped };
      const refund = await tokenAccountIfMissing(transport, owner, owner.address, intent.inputMint, ref.tokenProgram);
      const claims = await cancelClaims(transport, address, intent.claims);
      const instructions = [
        ...refund.create,
        await buildCancelIntent({ ...ref, owner, ...(claims === undefined ? {} : { claims }) }),
        ...(command.close ? [await buildCloseIntent({ ...ref, owner: owner.address, cranker: owner, rentPayer: intent.rentPayer })] : []),
      ];
      const summary = [
        `Cancels intent ${address} (nonce ${command.nonce}); nobody can fill it afterwards`,
        `Returns what is left in escrow to ${refund.address}, the owner's token account for ${intent.inputMint}`,
        ...(refund.create.length > 0 ? [`Creates ${refund.address} first, since it is missing; the owner pays its rent`] : []),
        ...(claims?.stakeTo === undefined || claims.stakeTo === null ? [] : [claims.stakeTo === owner.address ? `Takes the stake of the lapsed claim on this job, which the worker forfeited` : `Returns the claim stake to ${claims.stakeTo}, the worker who held this job`]),
        ...(command.close ? [`Closes the intent in the same transaction and returns its rent and bounty to ${intent.rentPayer}, who paid them; it can no longer be read afterwards`] : []),
      ];
      return previewed(transport, instructions, owner, { intent: address, summary }, command.yes);
    }
    case "expire": {
      const cranker = await transactionSigner(runtime, command.keypair);
      const { address, intent } = await loadIntent(transport, command.owner, command.nonce);
      const instructions = await expiring(transport, cranker, address, intent, "always", false);
      const summary = [
        `Expires intent ${address} (nonce ${command.nonce}) and returns what is left in escrow to its owner ${command.owner}`,
        ...(instructions.length > 1 ? [`Creates a token account for the owner to take the refund; ${cranker.address} pays its rent`] : []),
      ];
      return previewed(transport, instructions, cranker, { intent: address, summary }, command.yes);
    }
    case "close": {
      const payer = await transactionSigner(runtime, command.keypair);
      const { address, intent } = await loadIntent(transport, command.owner, command.nonce);
      const instructions = await closing(transport, payer, address, intent, "always");
      const summary = [
        `Closes intent ${address} (nonce ${command.nonce}) and returns its rent; it can no longer be read afterwards`,
        ...(instructions.length > 1 ? [`Creates a token account for the owner to take what is left in escrow; ${payer.address} pays its rent`] : []),
      ];
      return previewed(transport, instructions, payer, { intent: address, summary }, command.yes);
    }
    case "follow":
      throw new FlowRefused("events --follow streams to the terminal and runs only from the command line");
    case "monitor":
      throw new FlowRefused("monitor watches the program from the command line only");
    case "events": {
      const transactions = await engineEvents(transport, command.limit);
      const notable = transactions.reduce(
        (n, tx) => n + tx.events.filter((e) => (e as { notable?: boolean }).notable === true).length,
        0,
      );
      return { notable, transactions };
    }
    case "spec":
      return readJobSpec(command, runtime, transport);
    case "jobs":
    case "receipt":
      return jobCommand(command, runtime, transport);
    case "deliver":
    case "deliveries":
    case "refute":
    case "reclaim":
    case "close-book":
      return announceCommand(command, runtime, transport);
    case "judge": {
      return judge(command, runtime, transport);
    }
    case "judge-digest":
      return judgeDigest(command, transport);
    case "committee-create":
    case "committee-show":
    case "committee-vote":
    case "committee-release":
      return committeeCommand(command, runtime, transport);
    case "reputation":
    case "feedback":
      return reputationCommand(command, runtime, transport);
    case "claims-show":
    case "claims-open":
    case "claims-take":
    case "claims-drop":
    case "claims-settle":
    case "claims-standby":
    case "claims-leave":
    case "claims-advance":
    case "profile-show":
    case "profile-set":
    case "profile-close":
      return claimsCommand(command, runtime, transport);
    case "treasury": {
      const view = await treasuryView(transport, command.mints ?? (await intentInputMints(transport)));
      if (!command.create || command.keypair === undefined) {
        return view;
      }
      return createTreasuryAccounts(transport, view, await runtime.loadSigner(command.keypair), command.yes);
    }
    case "solver-table": {
      const { config } = await loadConfig(transport);
      const mints = [];
      for (const mint of command.mints) {
        mints.push({ mint, tokenProgram: await tokenProgramOf(transport, mint) });
      }
      const addresses = await solverTableAccounts(command.solver, config.feeRecipient, mints);
      return { solver: command.solver, count: addresses.length, addresses, next: SOLVER_TABLE_NEXT };
    }
    case "solver-float":
    case "solver-float-show":
    case "solver-float-revoke":
      return floatCommand(command, runtime, transport);
    case "crank": {
      const cranker = await runtime.loadSigner(command.keypair);
      return crank(transport, cranker, command.dryRun, command.fundAccounts);
    }
    case "init-config":
    case "raise-pause":
    case "lower-pause":
    case "update-config":
    case "propose-admin":
    case "accept-admin":
    case "set-economics":
    case "set-mint-cap":
    case "set-caps-required":
    case "set-committee-floor":
      return adminCommand(command, runtime, transport);
    case "show-mint-cap":
      return showMintCap(transport, command.mint);
    case "close-legacy":
      return closeLegacy(command, runtime, transport);
    case "migrate":
      return migrate(command, runtime, transport);
    case "advance-nonce": {
      const owner = await transactionSigner(runtime, command.keypair);
      const ix = await buildAdvanceNonce({ owner, nonceBase: command.base });
      const summary = [`Advances the nonce window of ${owner.address} to base ${command.base}: no intent can be created with a nonce below it afterwards, which cannot be undone`];
      return previewed(transport, [ix], owner, { owner: owner.address, base: command.base, summary }, command.yes);
    }
    case "solve":
      return tick(await solverOptions(command, runtime, transport));
    case "signature-lookup":
      return signatureLookup(transport, command.signature, command.validUntil);
    case "flow":
    case "lookup":
    case "signed-prepare":
    case "signed-submit":
      return flowCommand(command, runtime, transport);
    case "advance-epoch": {
      const owner = await transactionSigner(runtime, command.keypair);
      const [userState] = await findUserStatePda({ owner: owner.address });
      const view = await createdAccount(transport, userState);
      if (view === null) {
        throw new Error(`${owner.address} has no user state`);
      }
      const epoch = nextEpoch(getUserStateDecoder().decode(view.data).epoch);
      const ix = await buildAdvanceEpoch({ owner, epoch });
      return { epoch, signature: await transport.send([ix], owner) };
    }
  }
}
