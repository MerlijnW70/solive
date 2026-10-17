import { spawnSync } from "node:child_process";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { type TlsLike, trustSystemCertificates } from "../src/system-ca.js";
import { certificateCode, certificateHint, problemOf, SERVER_PROBLEMS, simulationProblem, unfundedSend } from "../src/agent/problems.js";
import { EXIT_FAILED, main } from "../src/main.js";
import { runtime, transport } from "./harness.js";

describe("system certificates", () => {
  it("adds the system store to the default certificates once, keeping the defaults", () => {
    let set: string[] = [];
    const store: TlsLike = {
      getCACertificates: (type) => (type === "system" ? ["system-a", "shared"] : ["default-a", "shared"]),
      setDefaultCACertificates: (certs) => {
        set = certs;
      },
    };
    expect(trustSystemCertificates(store)).toBe(true);
    expect(set).toEqual(["default-a", "shared", "system-a"]);
  });

  it("leaves a Node without the certificate API, or one whose store fails, as it was", () => {
    expect(trustSystemCertificates({})).toBe(false);
    expect(trustSystemCertificates({ getCACertificates: () => [] })).toBe(false);
    const failing: TlsLike = {
      getCACertificates: () => {
        throw new Error("no store");
      },
      setDefaultCACertificates: () => undefined,
    };
    expect(trustSystemCertificates(failing)).toBe(false);
  });

  it("puts the system store in the defaults a Node process uses", () => {
    const api = tls as TlsLike;
    const module = pathToFileURL(fileURLToPath(new URL("../src/system-ca.ts", import.meta.url))).href;
    const script = [
      'import tls from "node:tls";',
      `import { trustSystemCertificates } from "${module}";`,
      'const before = tls.getCACertificates("default");',
      "const trusted = trustSystemCertificates();",
      'const pem = (cert) => cert.replace(/\\s+/g, "");',
      'const after = new Set(tls.getCACertificates("default").map(pem));',
      'console.log(JSON.stringify({ trusted, kept: [...before, ...tls.getCACertificates("system")].every((c) => after.has(pem(c))) }));',
    ].join("\n");
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8" });
    if (typeof api.getCACertificates !== "function" || typeof api.setDefaultCACertificates !== "function") {
      expect(run.status).not.toBe(0);
      return;
    }
    expect([run.status, run.stderr]).toEqual([0, ""]);
    expect(JSON.parse(run.stdout)).toEqual({ trusted: true, kept: true });
  });
});

describe("certificate and funding problems", () => {
  it("names an untrusted certificate instead of calling the node unreachable", () => {
    const failed = new TypeError("fetch failed", { cause: Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) });
    expect(certificateCode(failed)).toBe("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    const url = "https://user:pass@rpc.example.org/v1?api-key=hidden";
    const problem = problemOf(failed, url);
    expect(problem).toEqual({ code: "CertificateUntrusted", retryable: false, hint: certificateHint(url, "UNABLE_TO_VERIFY_LEAF_SIGNATURE") });
    expect(problem.hint).toContain("https://rpc.example.org");
    expect(problem.hint).not.toMatch(/user|pass|hidden/);
    for (const code of ["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "DEPTH_ZERO_SELF_SIGNED_CERT"]) {
      expect(problemOf({ message: "fetch failed", cause: { code } }).code).toBe("CertificateUntrusted");
    }
    expect(certificateCode(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))).toBeNull();
    expect(problemOf(new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) })).code).toBe("Unreachable");
  });

  it("names a fee payer with no SOL instead of a missing account", () => {
    expect(simulationProblem("AccountNotFound", [])).toEqual({ code: "Unfunded", retryable: false, hint: SERVER_PROBLEMS.Unfunded.hint, logs: [] });
    expect(simulationProblem("AccountNotFound", ["Program 11111111111111111111111111111111 failed: custom program error: 0x1"]).code).toBe("TransactionFailed");
    expect(simulationProblem("InsufficientFundsForRent", []).code).toBe("TransactionFailed");
  });
});

describe("the cli on an untrusted certificate", () => {
  it("says the certificate is not trusted, naming the url without its secrets", async () => {
    const untrusted = {
      ...runtime({}),
      transport: () => ({
        ...transport,
        getAccount: async () => {
          throw new TypeError("fetch failed", { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } });
        },
      }),
    };
    const err: string[] = [];
    const code = await main(["show", "config", "--url", "https://user:token@rpc.example.org/key?api-key=xyz"], untrusted, { out: () => undefined, err: (t) => err.push(t) });
    expect([code, err]).toEqual([EXIT_FAILED, [certificateHint("https://user:token@rpc.example.org/key?api-key=xyz", "SELF_SIGNED_CERT_IN_CHAIN")]]);
    expect(err[0]).toContain("https://rpc.example.org");
    expect(err[0]).not.toMatch(/token|xyz|key\?/);
  });
});

describe("a send from a wallet that never held SOL", () => {
  const unfunded = Object.assign(new Error("Transaction simulation failed"), {
    context: { __code: -32002, logs: [] },
    cause: Object.assign(new Error("Attempt to debit an account but found no record of a prior credit."), { context: { __code: 7_050_003 } }),
  });

  it("is named as an unfunded wallet, over MCP and on the command line", async () => {
    expect(unfundedSend(unfunded)).toBe(true);
    expect(unfundedSend(new Error("Transaction simulation failed"))).toBe(false);
    expect(unfundedSend({ cause: { context: { __code: 7_050_004 } } })).toBe(false);
    expect(problemOf(unfunded)).toEqual({ code: "Unfunded", retryable: false, hint: SERVER_PROBLEMS.Unfunded.hint });
    const broke = {
      ...runtime({}),
      transport: () => ({
        ...transport,
        getAccount: async () => {
          throw unfunded;
        },
      }),
    };
    const err: string[] = [];
    const code = await main(["show", "config"], broke, { out: () => undefined, err: (t) => err.push(t) });
    expect([code, err]).toEqual([EXIT_FAILED, [SERVER_PROBLEMS.Unfunded.hint]]);
  });
});
