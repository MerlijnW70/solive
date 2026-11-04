import { type Base64EncodedWireTransaction, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import type { Transport } from "@intent-engine/client";
import { type RpcLike, rpcTransport } from "@intent-engine/client/internal";

export const TIMEOUTS = [408, 425] as const;

export const httpError = (statusCode: number, message = "Request Timeout") => new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message, statusCode });

export type Gateway = { transport: Transport; sends: () => number };

export function forwardsThenAnswers(live: Transport, status: number): Gateway {
  let sends = 0;
  const node = {
    sendTransaction: (wire: Base64EncodedWireTransaction) => ({
      send: async () => {
        sends += 1;
        await live.submitWire(wire);
        throw httpError(status);
      },
    }),
  };
  const client = rpcTransport(node as unknown as RpcLike, async () => undefined);
  return { transport: { ...live, sendWire: (wire, latest) => client.sendWire(wire, latest), submitWire: (wire) => client.submitWire(wire) }, sends: () => sends };
}

export function passesThrough(live: Transport, status: number, lands: boolean): Gateway {
  let sends = 0;
  return {
    transport: {
      ...live,
      sendWire: async (wire, latest) => {
        sends += 1;
        if (lands) {
          await live.sendWire(wire, latest);
        }
        throw httpError(status);
      },
    },
    sends: () => sends,
  };
}
