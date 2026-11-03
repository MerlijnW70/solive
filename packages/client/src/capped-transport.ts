import { type RpcTransport, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { parseJsonWithBigInts, stringifyJsonWithBigInts } from "@solana/rpc-spec-types";
import { methodOf, ReplyTooLarge } from "./rpc-limits.js";

type Runtime = { process?: { versions?: { node?: unknown } } };

export const onNode = (): boolean => typeof (globalThis as Runtime).process?.versions?.node === "string";

export const replyHeaders = (node: boolean): Record<string, string> => ({
  ...(node ? { "accept-encoding": "br,gzip,deflate" } : {}),
  accept: "application/json",
  "content-type": "application/json; charset=utf-8",
});

async function cappedText(response: Response, method: string, maxReplyBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return "";
  }
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxReplyBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ReplyTooLarge(method, maxReplyBytes);
    }
    parts.push(value);
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.byteLength;
  }
  return new TextDecoder().decode(whole);
}

export function cappedTransport(url: string, maxReplyBytes: number, node: boolean = onNode()): RpcTransport {
  const headers = replyHeaders(node);
  const capped = async ({ payload, signal }: Parameters<RpcTransport>[0]) => {
    const response = await fetch(url, { method: "POST", body: stringifyJsonWithBigInts(payload), headers, ...(signal === undefined ? {} : { signal }) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: response.headers, message: response.statusText, statusCode: response.status });
    }
    return parseJsonWithBigInts(await cappedText(response, methodOf(payload), maxReplyBytes));
  };
  return capped as RpcTransport;
}
