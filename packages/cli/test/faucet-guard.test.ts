import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { askInstantFaucet, FAUCET_DEFAULT_URL, FAUCET_DRIP_PATH, FAUCET_URL_ENV } from "../src/faucet.js";
import { assertNoFaucetHits, FAUCET_ENV, FAUCET_HOST, faucetHit, guardedFetch } from "./faucet-guard.js";

describe("the test suite keeps away from the real instant faucet", () => {
  it("guards the host the product asks and the variable it reads", () => {
    expect(FAUCET_HOST).toBe(new URL(FAUCET_DEFAULT_URL).hostname);
    expect(FAUCET_ENV).toBe(FAUCET_URL_ENV);
  });

  it("fails a fetch to the real host with a message that names it, and fails the test at its end", async () => {
    await expect(fetch(FAUCET_DEFAULT_URL + FAUCET_DRIP_PATH, { method: "POST", body: "{}" })).rejects.toThrow(faucetHit(FAUCET_HOST));
    expect(faucetHit(FAUCET_HOST)).toContain(FAUCET_HOST);
    expect(assertNoFaucetHits).toThrow(faucetHit(FAUCET_HOST));
    expect(assertNoFaucetHits).not.toThrow();
  });

  it("catches a url object and a request too, even when the caller swallows the error", async () => {
    await fetch(new URL(FAUCET_DEFAULT_URL)).catch(() => undefined);
    await fetch(new Request(FAUCET_DEFAULT_URL)).catch(() => undefined);
    expect(assertNoFaucetHits).toThrow(/2 requests/);
  });

  it("lets every other host through", async () => {
    const seen: string[] = [];
    const wrapped = guardedFetch((async (input: unknown) => {
      seen.push(String(input));
      return new Response("ok");
    }) as typeof fetch);
    expect(await (await wrapped("http://127.0.0.1:1/x")).text()).toBe("ok");
    expect(await (await wrapped("https://not-" + FAUCET_HOST + ".example/x")).text()).toBe("ok");
    expect(seen).toHaveLength(2);
    expect(assertNoFaucetHits).not.toThrow();
  });

  it("leaves a test with its own faucet url or fetch working", async () => {
    const asked: string[] = [];
    const fake = async (url: string) => {
      asked.push(url);
      return { status: 429, json: async () => ({ error: "busy" }) };
    };
    const own = await askInstantFaucet(fake, { [FAUCET_URL_ENV]: "http://127.0.0.1:9" }, "addr");
    const fallback = await askInstantFaucet(fake, {}, "addr");
    expect(asked).toEqual(["http://127.0.0.1:9" + FAUCET_DRIP_PATH, FAUCET_DEFAULT_URL + FAUCET_DRIP_PATH]);
    expect(own).toMatchObject({ kind: "limited" });
    expect(fallback).toMatchObject({ kind: "limited" });
    expect(assertNoFaucetHits).not.toThrow();
  });

  it("turns the faucet off for the whole run, and a spawned process inherits that", () => {
    expect(process.env[FAUCET_URL_ENV]).toBe("off");
    const child = spawnSync(process.execPath, ["-e", `process.stdout.write(process.env.${FAUCET_URL_ENV} ?? "unset")`], { encoding: "utf8" });
    expect(child.stdout).toBe("off");
  });

  it("asks no faucet at all while the variable is off, and still targets the default url when it is empty", async () => {
    const asked: string[] = [];
    const fake = async (url: string) => {
      asked.push(url);
      return { status: 200, json: async () => ({}) };
    };
    expect(await askInstantFaucet(fake, process.env, "addr")).toBeNull();
    await askInstantFaucet(fake, { [FAUCET_URL_ENV]: "" }, "addr");
    expect(asked).toEqual([FAUCET_DEFAULT_URL + FAUCET_DRIP_PATH]);
  });
});
