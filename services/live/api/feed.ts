import { getCache } from "@vercel/functions";
import { createHandler, liveFeed } from "../src/http.js";

export default createHandler(liveFeed({ env: process.env, cache: () => getCache() }));
