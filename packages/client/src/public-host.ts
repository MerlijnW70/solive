import { lookup as dnsLookup } from "node:dns/promises";
import type { Lookup } from "./address-ranges.js";

export const systemLookup: Lookup = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((found) => found.address);
