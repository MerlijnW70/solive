import type { Address } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import { testSignature } from "@intent-engine/client/testing";
import { IntentCoreError } from "@intent-engine/core";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { FailedOnChain, MaybeSent, MissingAccount, type SendStatus, TransportLacks } from "@intent-engine/client";
import { ENGINE_ERRORS, failure } from "@intent-engine/client/internal";
import { parse, UsageError } from "../src/args.js";
import { SIGNATURE_NEEDED } from "../src/command-builders.js";
import { signatureLookup } from "../src/flow-commands.js";
import { lookupCommand, maybeSentHint, problemOf, SERVER_PROBLEMS } from "../src/agent/problems.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { cli, transport } from "./harness.js";

const SIG = testSignature("sent");
const OTHER = "11111111111111111111111111111112" as Address;

afterEach(() => {
  delete transport.sendStatus;
});

describe("the lookup command", () => {
  it("parses a signature and an optional last valid block height", () => {
    expect(parse(["lookup", "--signature", SIG, "--valid-until", "120"])).toMatchObject({ name: "signature-lookup", signature: SIG, validUntil: 120n });
    expect(parse(["lookup", "--signature", SIG])).toMatchObject({ name: "signature-lookup", signature: SIG, validUntil: undefined });
    expect(() => parse(["lookup"])).toThrow(new UsageError(SIGNATURE_NEEDED));
    expect(() => parse(["lookup", "--signature", "0OIl"])).toThrow(new UsageError(SIGNATURE_NEEDED));
  });

  it("prints what the transport reports, the failure fields included", async () => {
    const asked: [string, bigint | undefined][] = [];
    const engine = [...ENGINE_ERRORS.values()][0];
    transport.sendStatus = async (signature, lastValidBlockHeight): Promise<SendStatus> => {
      asked.push([signature, lastValidBlockHeight]);
      return lastValidBlockHeight === undefined
        ? { status: "confirmed", signature: SIG, slot: 9n }
        : { status: "failed", ...failure(SIG, { InstructionError: [0, { Custom: engine?.code ?? 0 }] }, [`Program ${INTENT_ENGINE_PROGRAM_ADDRESS} failed: custom program error: 0x1770`]) };
    };
    const confirmed = await cli(["lookup", "--signature", SIG], {});
    expect(confirmed.code).toBe(EXIT_OK);
    expect(confirmed.json()).toMatchObject({ status: "confirmed", signature: SIG });
    const failed = await cli(["lookup", "--signature", SIG, "--valid-until", "77"], {});
    expect(failed.code).toBe(EXIT_OK);
    expect(failed.json()).toMatchObject({ status: "failed", signature: SIG, program: INTENT_ENGINE_PROGRAM_ADDRESS, engine_error: engine?.name });
    expect(asked).toEqual([
      [SIG, undefined],
      [SIG, 77n],
    ]);
  });

  it("refuses a transport that cannot report a status", async () => {
    await expect(signatureLookup(transport, SIG, undefined)).rejects.toBeInstanceOf(TransportLacks);
    const refused = await cli(["lookup", "--signature", SIG], {});
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.err).toContain("this transport has no sendStatus");
  });
});

describe("sdk errors in the MCP server and the CLI", () => {
  it("map by code, so a look-alike with the same name or message is not taken for one", () => {
    expect(problemOf(new MissingAccount("intent", OTHER)).code).toBe("NotFound");
    const lookalike = Object.assign(new Error(`intent ${OTHER} does not exist`), { name: "MissingAccount", code: "missing-account" });
    expect(problemOf(lookalike).code).toBe("Failed");
    expect(problemOf(new IntentCoreError("AmountMismatch")).code).toBe("AmountMismatch");
  });

  it("tell the user to look a maybe-sent transaction up instead of sending it again", async () => {
    const unsure = new MaybeSent(SIG, 321n, `transaction ${SIG} may have reached the node before sending it failed (fetch failed); look the signature up before sending again`);
    expect(lookupCommand(unsure)).toBe(`intent-engine lookup --signature ${SIG} --valid-until 321`);
    expect(lookupCommand(new MaybeSent(SIG, null, "x"))).toBe(`intent-engine lookup --signature ${SIG}`);
    expect(problemOf(unsure)).toEqual({ code: "MaybeSent", retryable: SERVER_PROBLEMS.MaybeSent.retryable, hint: maybeSentHint(unsure), signature: SIG });
    expect(maybeSentHint(unsure)).toContain("do not send it again");
    expect(maybeSentHint(unsure).length).toBeLessThanOrEqual(300);
    transport.sendStatus = async () => {
      throw unsure;
    };
    const printed = await cli(["lookup", "--signature", SIG], {});
    expect(printed.code).toBe(EXIT_FAILED);
    expect(printed.err).toContain(`run intent-engine lookup --signature ${SIG} --valid-until 321`);
  });

  it("keep a landed failure out of the maybe-sent path", () => {
    const failed = new FailedOnChain("failed", failure(SIG, null));
    expect(problemOf(failed).code).not.toBe("MaybeSent");
  });
});
