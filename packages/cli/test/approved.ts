import type { Client } from "@modelcontextprotocol/client";

export async function approved(client: Client, name: string, args: object): Promise<Record<string, unknown>> {
  const terms = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "send"));
  const preview = await client.callTool({ name: `solive_${name}`, arguments: terms });
  const shown = (preview.structuredContent ?? {}) as Record<string, unknown>;
  return { ...terms, ...(typeof shown["approval"] === "string" ? { approval: shown["approval"] } : {}), send: true };
}
