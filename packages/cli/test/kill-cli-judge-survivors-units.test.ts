import { PassThrough } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { Values } from "../src/arg-options.js";
import { outputCut, relayOutput } from "../src/check-output.js";
import { startFailed } from "../src/container-check.js";
import { FlowRefused } from "../src/flows.js";
import { dockerMissing, SANDBOX_CPUS, SANDBOX_IMAGE, SANDBOX_MEMORY, SANDBOX_TMP, sandboxOf } from "../src/sandbox.js";
import { decodeOutput } from "../src/viper.js";
import { savedSecret, secretBroken, secretFor, type SecretFiles, secretsPath } from "../src/worker-secrets.js";

async function relayed(limit: number, chunks: readonly string[]): Promise<{ written: string[]; shown: number }> {
  const stream = new PassThrough();
  const written: string[] = [];
  const relay = relayOutput([stream], (text) => written.push(text), limit);
  for (const chunk of chunks) {
    stream.write(chunk);
    await tick();
  }
  stream.end();
  await tick();
  return { written, shown: relay.shown() };
}

describe("relayOutput at its limit", () => {
  it("shows output of exactly the limit whole, without the cut notice", async () => {
    expect(await relayed(5, ["abcde"])).toStrictEqual({ written: ["abcde"], shown: 5 });
  });

  it("shows output one past the limit cut, with the notice once", async () => {
    expect(await relayed(5, ["abcdef"])).toStrictEqual({ written: ["abcde", outputCut(5)], shown: 5 });
  });

  it("writes nothing more after the cut, however much output follows", async () => {
    expect(await relayed(5, ["abc", "defgh", "ijk", "lmn"])).toStrictEqual({ written: ["abc", "de", outputCut(5)], shown: 5 });
  });
});

describe("startFailed", () => {
  it("names the exit code alone when docker gave no error", () => {
    expect(startFailed(125, "")).toBe("docker could not start the check's container (exit 125)");
  });

  it("adds docker's error after the exit code", () => {
    expect(startFailed(125, "no such image")).toBe("docker could not start the check's container (exit 125: no such image)");
  });
});

describe("dockerMissing", () => {
  it("says no answer when docker printed nothing", () => {
    expect(dockerMissing("")).toContain("docker is not available (no answer), so");
  });

  it("quotes what docker printed", () => {
    expect(dockerMissing("permission denied")).toContain("docker is not available (permission denied), so");
  });
});

describe("sandboxOf and the GPU flag", () => {
  const box = { image: SANDBOX_IMAGE, memory: SANDBOX_MEMORY, cpus: SANDBOX_CPUS, tmp: SANDBOX_TMP };

  it("passes the GPU only when --sandbox-gpu is given", () => {
    expect(sandboxOf({ sandbox: "docker", "sandbox-gpu": true } as Values)).toStrictEqual({ kind: "docker", ...box, gpu: true });
    expect(sandboxOf({ sandbox: "docker" } as Values)).toStrictEqual({ kind: "docker", ...box, gpu: false });
    expect(sandboxOf({} as Values)).toStrictEqual({ kind: "docker", ...box, gpu: false });
  });

  it("keeps the GPU for a plain node viper box", () => {
    expect(sandboxOf({ sandbox: "viper", "plain-node": true, "sandbox-gpu": true } as Values)).toStrictEqual({ kind: "viper", node: { ...box, gpu: true } });
    expect(sandboxOf({ sandbox: "viper", "plain-node": true } as Values)).toStrictEqual({ kind: "viper", node: { ...box, gpu: false } });
  });
});

describe("decodeOutput of a wrong answer", () => {
  const head = Buffer.from([1, 0, 0, 0, 0, 1, 0, 0, 0]);

  it("reads the boolean answers by their tags", () => {
    expect(decodeOutput(Buffer.concat([head, Buffer.from([1, 2])]), 1)).toStrictEqual([{ verdict: "wrong", detail: false }]);
    expect(decodeOutput(Buffer.concat([head, Buffer.from([1, 3])]), 1)).toStrictEqual([{ verdict: "wrong", detail: true }]);
  });
});

type Saved = { path: string; text: string; secret: boolean };

function filesWith(held: Map<string, string>, saved: Saved[]): SecretFiles {
  return {
    home: "/home/worker",
    readText: async (path) => {
      const text = held.get(path);
      if (text === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return text;
    },
    saveText: async (path, text, secret) => {
      saved.push({ path, text, secret });
      held.set(path, text);
    },
  };
}

describe("worker secrets files", () => {
  const sha256 = "ab".repeat(32);
  const otherSha256 = "cd".repeat(32);
  const secret = "ef".repeat(32);
  const url = "https://" + "work.example.org/a.tar";

  it("saves a new secret as a secret file, never overwriting one", async () => {
    const [worker, intent] = [(await generateKeyPairSigner()).address, (await generateKeyPairSigner()).address];
    const saved: Saved[] = [];
    const made = await secretFor(filesWith(new Map(), saved), worker, intent, sha256, url);
    expect(saved.map(({ path, secret: isSecret }) => [path, isSecret])).toStrictEqual([[secretsPath("/home/worker", worker, intent, sha256), true]]);
    expect(made.secret.length).toBe(32);
  });

  it("refuses a file at its path that names another worker, intent or work, each alone", async () => {
    const [worker, intent, other] = [(await generateKeyPairSigner()).address, (await generateKeyPairSigner()).address, (await generateKeyPairSigner()).address];
    const path = secretsPath("/home/worker", worker, intent, sha256);
    const holding = (fields: object) => filesWith(new Map([[path, JSON.stringify({ worker, intent, sha256, url, secret, ...fields })]]), []);
    for (const fields of [{ worker: other }, { intent: other }, { sha256: otherSha256 }]) {
      const refused = await savedSecret(holding(fields), worker, intent, sha256).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(FlowRefused);
      expect((refused as FlowRefused).message).toBe(secretBroken(path));
    }
    expect(await savedSecret(holding({}), worker, intent, sha256)).toStrictEqual({ worker, intent, sha256, url, secret: Uint8Array.from(Buffer.from(secret, "hex")) });
  });
});
