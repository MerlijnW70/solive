import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { type Address, createKeyPairSignerFromBytes, createSolanaRpc, type KeyPairSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { findAssociatedTokenAddress, findConfigPda } from "@intent-engine/core";
import {
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getSyncNativeInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { chainTime, type RpcLike, rpcTransport } from "@intent-engine/client";
import { ACTIONS } from "../src/agent/registry.js";
import { configExists } from "../src/commands.js";
import { EXIT_FAILED, EXIT_OK, loadKeypairFile } from "../src/main.js";
import { VERSION } from "../src/version.js";

const url = process.env["DEVNET_RPC"];
const keypair = process.env["DEVNET_KEYPAIR"];
const bin = fileURLToPath(new URL("../dist/src/bin.js", import.meta.url));
const WRAPPED = "So11111111111111111111111111111111111111112";
const TEST_TOKEN = "ETU8trkkfE8gNVPDGbCaJUoH88wy6yYV6ttJdc9NKB88";
const FILLER = "EuagWg1chJxXVJAXm2GiGiivtMRKGaFCFWY8G8PPM6My";
const LAMPORTS_PER_SOL = 1_000_000_000n;

type Ran = { status: number | null; json: Record<string, any>; err: string };

function keyFile(dir: string, name: string): { file: string; bytes: Uint8Array } {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const bytes = Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify([...bytes]));
  chmodSync(file, 0o600);
  return { file, bytes };
}

describe.skipIf(url === undefined || keypair === undefined)("devnet cli sweep", () => {
  it("runs every command of the built binary against devnet", async () => {
    const rpc = createSolanaRpc(url ?? "");
    const transport = rpcTransport(rpc as unknown as RpcLike);
    const dir = mkdtempSync(join(tmpdir(), "devnet-cli-"));
    const payerFile = keypair ?? "";
    const ownerKey = keyFile(dir, "owner");
    const agentKey = keyFile(dir, "agent");
    const owner = await createKeyPairSignerFromBytes(ownerKey.bytes);
    const agent = await createKeyPairSignerFromBytes(agentKey.bytes);
    const relayer = (await loadKeypairFile(payerFile)) as KeyPairSigner;
    const attestor = (await createKeyPairSignerFromBytes(keyFile(dir, "attestor").bytes)).address;
    const log: [string, Ran][] = [];
    const trail = process.env["SWEEP_LOG"] ?? join(dir, "sweep.json");
    const cli = (line: string, env: Record<string, string> = {}): Ran => {
      const args = line.split(" ");
      const run = spawnSync(process.execPath, [bin, ...args], {
        encoding: "utf8",
        cwd: dir,
        env: { ...process.env, INTENT_ENGINE_URL: url ?? "", INTENT_ENGINE_KEYPAIR: ownerKey.file, ...env },
      });
      let json: Record<string, any> = {};
      try {
        json = JSON.parse(run.stdout) as Record<string, any>;
      } catch {
        json = { raw: run.stdout };
      }
      const ran = { status: run.status, json, err: run.stderr.trim() };
      log.push([line, ran]);
      writeFileSync(trail, JSON.stringify(log, null, 2));
      return ran;
    };
    const ok = (line: string, env?: Record<string, string>) => {
      const ran = cli(line, env);
      expect(ran.err, line).toBe("");
      expect(ran.status, line).toBe(EXIT_OK);
      return ran.json;
    };
    const now = () => BigInt(Math.floor(Date.now() / 1000));
    const drift = (await chainTime(transport)) - now();
    const swap = (min: number, extra = "") =>
      `create swap --input-mint ${WRAPPED} --output-mint ${TEST_TOKEN} --units tokens --amount-in 0.01 --min-out ${min} ${extra}`.trim();

    await transport.send(
      [
        getTransferSolInstruction({ source: relayer, destination: owner.address, amount: (LAMPORTS_PER_SOL * 3n) / 10n }),
        getTransferSolInstruction({ source: relayer, destination: agent.address, amount: LAMPORTS_PER_SOL / 20n }),
      ],
      relayer,
    );
    const wrapped = await findAssociatedTokenAddress({ owner: owner.address, mint: WRAPPED as Address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    await transport.send(
      [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: owner, owner: owner.address, mint: WRAPPED as Address }),
        getTransferSolInstruction({ source: owner, destination: wrapped, amount: LAMPORTS_PER_SOL / 10n }),
        getSyncNativeInstruction({ account: wrapped }),
      ],
      owner,
    );

    const FEE = 5_000n;
    const retried = async (step: () => Promise<unknown>) => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await step();
        } catch (error) {
          if (attempt === 3) {
            throw error;
          }
        }
      }
    };
    const returned = async (signer: KeyPairSigner) => {
      const held = BigInt((await rpc.getBalance(signer.address).send()).value);
      if (held > FEE) {
        await transport.send([getTransferSolInstruction({ source: signer, destination: relayer.address, amount: held - FEE })], signer);
      }
    };
    try {
      expect(ok("version")).toEqual({ version: VERSION });
      expect(String(ok("help")["raw"])).toContain("create swap|limit|dutch|attested");
      expect(String(ok("help create")["raw"])).toContain("create swap|limit|dutch|attested --keypair <file>");
      ok("domain");
      const config = ok("show config");
      ok(`pda --owner ${owner.address} --nonce 0`);
      ok(`treasury --mints ${WRAPPED}`);
      ok(`solver-table --solver ${FILLER} --mints ${WRAPPED},${TEST_TOKEN}`);
      ok("events --limit 3");

      expect(ok(swap(50, "--expires-in 600"))["sent"]).toBe(false);
      expect(ok(swap(50, "--expires-in 600 --yes"))["sent"]).toBe(true);
      ok(`show intent --owner ${owner.address} --nonce 0`);
      ok(`quote --owner ${owner.address} --nonce 0`);
      ok("list");
      ok("cancel --nonce 0 --yes");
      ok(`close --owner ${owner.address} --nonce 0 --yes`);

      ok(`create limit --input-mint ${WRAPPED} --output-mint ${TEST_TOKEN} --units tokens --make 0.01 --take 50 --expires-in 600 --yes`);
      const start = now() + drift - 30n;
      ok(
        `create dutch --input-mint ${WRAPPED} --output-mint ${TEST_TOKEN} --units tokens --amount-in 0.01 --start-out 60 --end-out 50 --start-at ${start} --end-at ${start + 600n} --expires-in 600 --yes`,
      );
      ok(
        `create attested --input-mint ${WRAPPED} --output-mint ${TEST_TOKEN} --units tokens --amount-in 0.01 --min-result 1 --max-result 2 --attestor ${attestor} --spec-hash ${"ab".repeat(32)} --expires-in 600 --yes`,
      );
      for (const nonce of [1, 2, 3]) {
        ok(`cancel --nonce ${nonce} --yes`);
      }
      ok("crank --dry-run");
      ok("crank");

      const short = ok(swap(50, "--expires-in 60 --yes"));
      const deadline = BigInt(String(short["expires_at"] ?? "0"));
      while (now() + drift <= deadline + 5n) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      ok(`expire --owner ${owner.address} --nonce 4 --yes`);
      ok(`close --owner ${owner.address} --nonce 4 --yes`);

      ok("advance-nonce --base 100");
      ok("advance-epoch");
      ok(`approve --mint ${WRAPPED} --amount 0.02 --units tokens --yes`);
      ok(`revoke-approval --mint ${WRAPPED} --yes`);

      const prepared = ok(
        `signed prepare swap --out signed.json --input-mint ${WRAPPED} --output-mint ${TEST_TOKEN} --units tokens --amount-in 0.01 --min-out 50 --expires-in 600 --yes`,
      );
      expect(existsSync(join(dir, "signed.json"))).toBe(true);
      ok(`signed submit --keypair ${payerFile} --file signed.json --yes`);
      ok(`cancel --nonce ${String(prepared["nonce"] ?? "100")} --yes`);

      ok(
        `mandate grant --agent ${agent.address} --input-mint ${WRAPPED} --output-mint ${TEST_TOKEN} --kinds swap --per-intent 0.02 --total 0.02 --max-intents 1 --max-ttl 600 --valid-for 600 --floor-out 100 --floor-in 1 --units tokens --yes`,
      );
      ok(`mandate show --agent ${agent.address}`);
      ok(`mandate use swap --keypair ${agentKey.file} --owner ${owner.address} --amount-in 0.02 --min-out 50 --expires-in 600 --units tokens --yes`);
      ok(`mandate revoke --agent ${agent.address} --yes`);

      ok(`solve --issue ${WRAPPED}:${TEST_TOKEN}=200/1 --min-profit ${TEST_TOKEN}=1`);
      ok("crank");

      const admin = { INTENT_ENGINE_KEYPAIR: payerFile };
      const previews = [
        "raise-pause --flags fill",
        "lower-pause --flags fill",
        "set-economics --bounty 0 --create-fee 0",
        "update-config --fee-bps 5",
        `propose-admin --new-admin ${attestor}`,
      ];
      for (const line of previews) {
        expect(ok(line, admin)).toMatchObject({ sent: false });
      }
      const refused = (line: string) => {
        const ran = cli(line, admin);
        expect(ran.status, line).toBe(EXIT_FAILED);
        return ran.err;
      };
      expect(refused("accept-admin")).toBe("only the proposed admin can accept the admin role");
      expect(refused(`init-config --guardian ${attestor} --fee-recipient ${attestor} --fee-bps 5 --kinds swap`)).toBe(
        configExists(String(config["address"] ?? (await findConfigPda())[0]) as Address),
      );

      const client = new Client({ name: "devnet-cli", version: VERSION });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "mcp", "--url", url ?? ""], stderr: "pipe" }));
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(ACTIONS.map((a) => a.name));
      const served = await client.callTool({ name: "solive_get_config", arguments: {} });
      await client.close();

      writeFileSync(
        trail,
        JSON.stringify({ config, served: served.structuredContent, log }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2),
      );
    } finally {
      await retried(async () => {
        if ((await transport.getAccount(wrapped)) !== null) {
          await transport.send([getCloseAccountInstruction({ account: wrapped, destination: owner.address, owner })], owner);
        }
      });
      await retried(() => returned(owner));
      await retried(() => returned(agent));
    }
  }, 1_800_000);
});
