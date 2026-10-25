import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type Served = { host: string; asked: string[]; close(): Promise<void> };

export async function serve(files: Readonly<Record<string, string | Uint8Array>>): Promise<Served> {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    asked.push(path);
    const body = files[path];
    response.writeHead(body === undefined ? 404 : 200).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = "http://127.0.0.1:" + String((server.address() as AddressInfo).port);
  return { host, asked, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
