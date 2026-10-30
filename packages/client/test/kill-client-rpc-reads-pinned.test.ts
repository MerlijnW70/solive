import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pinnedFetch } from "../src/node.js";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? "";
    const status = Number(/^\/status\/(\d+)$/.exec(path)?.[1] ?? 0);
    if (status === 302) {
      response.writeHead(302, { location: "/elsewhere" }).end();
    } else if (status === 204) {
      response.writeHead(204).end();
    } else if (status > 0) {
      response.writeHead(status).end("body " + String(status));
    } else if (path === "/gzip") {
      response.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync("zipped"));
    } else {
      response.writeHead(200, { "x-seen-host": request.headers.host ?? "" }).end("hello");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://" + "pinned.test:" + String((server.address() as AddressInfo).port);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const get = (path: string, addresses: readonly string[] = ["127.0.0.1"], signal = new AbortController().signal) =>
  pinnedFetch(base + path, { redirect: "error", signal, addresses });

describe("a fetch pinned to checked addresses", () => {
  it("connects to the checked address whatever the host name says", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
    expect(response.headers.get("x-seen-host")).toBe(new URL(base).host);
  });

  it("decodes a compressed body", async () => {
    expect(await (await get("/gzip")).text()).toBe("zipped");
  });

  it("hands back every status from 200 to 599", async () => {
    for (const status of [200, 404, 500, 599]) {
      const response = await get("/status/" + String(status));
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("body " + String(status));
    }
  });

  it("hands back an empty answer without a body", async () => {
    const response = await get("/status/204");
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it("refuses a status above 599", async () => {
    await expect(get("/status/600")).rejects.toMatchObject({ code: "fetch-failed", reason: "status", detail: "answered status 600" });
  });

  it("refuses a redirect", async () => {
    await expect(get("/status/302")).rejects.toMatchObject({ code: "fetch-failed", reason: "redirect" });
  });

  it("refuses to connect with no checked address", async () => {
    await expect(get("/", [])).rejects.toMatchObject({ code: "fetch-failed", reason: "no-address" });
  });

  it("listens for the abort of the request only once", async () => {
    const controller = new AbortController();
    const listen = vi.spyOn(controller.signal, "addEventListener");
    await (await get("/", ["127.0.0.1"], controller.signal)).text();
    expect(listen).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
  });
});
