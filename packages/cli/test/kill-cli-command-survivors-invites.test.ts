import type { Address } from "@solana/kit";
import type { SpecFetch, Transport } from "@intent-engine/client";
import { readSpec } from "@intent-engine/client/internal";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invitesOf } from "../src/invites.js";

vi.mock("@intent-engine/client/internal", async (original) => ({ ...(await original<typeof import("@intent-engine/client/internal")>()), readSpec: vi.fn() }));

const reading = vi.mocked(readSpec);
const INTENT = "11111111111111111111111111111112" as Address;
const transport = {} as Transport;
const reach = { lookup: async () => [] } as never;
const get: SpecFetch = async () => new Response("");

describe("who a job invites", () => {
  beforeEach(() => {
    reading.mockReset();
  });

  it("rethrows an error raised before any spec url was fetched", async () => {
    const failure = new TypeError("the node answered nonsense");
    reading.mockRejectedValue(failure);
    await expect(invitesOf(transport, get, INTENT, reach)).rejects.toBe(failure);
  });

  it("reports an unreadable invite list once the spec url was fetched and the read still failed", async () => {
    reading.mockImplementation(async (_transport, fetching) => {
      await fetching("https://" + "example.org/spec", {} as never);
      throw new TypeError("connection reset");
    });
    expect(await invitesOf(transport, get, INTENT, reach)).toStrictEqual({ kind: "unread", reason: "its spec url could not be fetched (connection reset)" });
  });
});
