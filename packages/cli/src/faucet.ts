import type { Address } from "@solana/kit";
import { PRODUCT_REPOSITORY } from "@intent-engine/core";
import type { Launched } from "./launch.js";

export const GH = "gh";
export const FAUCET_TEMPLATE = "Request devnet SOL";
export const FAUCET_TITLE = "Devnet SOL";
export const FAUCET_MINUTE = 7;
export const FAUCET_RUN_MINUTES = 10;
export const FAUCET_WAIT_MINUTES = 60 + FAUCET_RUN_MINUTES;
export const FAUCET_POLL_SECONDS = 30;

export const FAUCET_SCHEDULE = `a scheduled run answers faucet requests at minute ${FAUCET_MINUTE} of every hour, so SOL arrives within the hour`;
export const GH_HINT = "with the GitHub CLI signed in, setup --faucet files the request and waits for SOL; otherwise ";
export const GH_GONE = "the GitHub CLI (gh) was not found";
export const GH_MISSING = `${GH_GONE}, so `;
export const GH_SIGNED_OUT = "the GitHub CLI is not signed in (run gh auth login), so ";

export const REPOSITORY_ID = "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}";
export const CREATE_ISSUE =
  "mutation($repo:ID!,$title:String!,$body:String!,$template:String!){createIssue(input:{repositoryId:$repo,title:$title,body:$body,issueTemplate:$template}){issue{url}}}";

export const faucetWaiting = (url: string) =>
  `filed ${url}; waiting up to ${FAUCET_WAIT_MINUTES} minutes for SOL, checking every ${FAUCET_POLL_SECONDS} seconds`;
export const faucetPending = (url: string) =>
  `no SOL arrived within ${FAUCET_WAIT_MINUTES} minutes; the faucet answers on ${url}: read it, and run setup again once SOL arrives`;
export const ghFailed = (code: number, output: string) => `the GitHub CLI could not file the faucet request (exit ${code}): ${output.trim()}`;

export type Launch = (program: string, args: readonly string[]) => Promise<Launched | null>;

export type Filed = { url: string } | { hint: string };

const repository = () => {
  const [owner = "", name = ""] = new URL(PRODUCT_REPOSITORY).pathname.split("/").filter((part) => part !== "");
  return { owner, name };
};

async function gh(launch: Launch, args: readonly string[]): Promise<string> {
  const ran = await launch(GH, args);
  if (ran === null) {
    throw new Error(GH_GONE);
  }
  if (ran.code !== 0) {
    throw new Error(ghFailed(ran.code, ran.output));
  }
  return ran.output.trim();
}

export async function fileFaucetRequest(launch: Launch, address: Address): Promise<Filed> {
  const signedIn = await launch(GH, ["auth", "status", "--hostname", "github.com"]);
  if (signedIn === null) {
    return { hint: GH_MISSING };
  }
  if (signedIn.code !== 0) {
    return { hint: GH_SIGNED_OUT };
  }
  const { owner, name } = repository();
  const id = await gh(launch, ["api", "graphql", "-f", `query=${REPOSITORY_ID}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "--jq", ".data.repository.id"]);
  const url = await gh(launch, [
    "api",
    "graphql",
    "-f",
    `query=${CREATE_ISSUE}`,
    "-f",
    `repo=${id}`,
    "-f",
    `title=${FAUCET_TITLE}`,
    "-f",
    `body=${address}`,
    "-f",
    `template=${FAUCET_TEMPLATE}`,
    "--jq",
    ".data.createIssue.issue.url",
  ]);
  return { url };
}
