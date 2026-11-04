import type { Address } from "@solana/kit";
import { feeBpsFor, formatAmount, Kind, NATIVE_MINT, splitFees } from "@intent-engine/core";
import { isMemoUrl, MEMO_URL_RULE } from "@intent-engine/core/internal";
import { chainTime, loadConfig, mintOf, plainHttpOnPublic, WARN_NO_JUDGE_KEY } from "@intent-engine/client/internal";
import { TOKEN_NAMES, tokenNamed } from "../../tokens.js";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { escrowJudge, MAX_EXPIRES_IN, MIN_EXPIRES_IN, neverSettles, SPEC_URL_PLAIN } from "../create.js";
import { tool } from "../names.js";
import { AgentRefusal, problemOf, UNTRUSTED_DETAIL } from "../problems.js";
import { InvalidInput, account, amount, flag, hex32, integer, list, object, optional, text } from "../schema.js";
import { LANDING_SECONDS, access, mintNamed, raw, salesOf, checkSale, checkHour, refusedBeforeSending, PREVIEW_APPROVAL, PREVIEW_APPROVAL_NEXT, oneAtATime, signerOf, termsApproval } from "./guard.js";
import { createFeesOf, offerFields, type Token } from "./offer.js";
import { costLines, escrowCosts, pieceCostLines } from "./costs.js";
import { ALLOW_WRONG_SPEC, allowWrongSpec, CLAIMS_NEED_SPEC, claimInputs, claimTerms, refuseWrongSpec, specPreflight, wrongSpecLines } from "./escrow-terms.js";
import { pieceUploadPlans, planLines, readerLines, specTextProblem, uploadBound, uploadFailed, uploadInputs, uploadLine, uploadOutputs, uploadPlan, UPLOAD_PUBLIC, uploadsAfterSend, withUploadHint } from "../spec-upload.js";
import { type Claimants, claimantsOf, listedLines, offeredWithClaims, previewFees, specReader } from "./escrow-claims.js";

export { stakeBelowRent } from "../../stake-floor.js";
export { CLAIMS_NEED_SPEC, CLAIMS_TOGETHER, claimsLine, notSealedTo, SPEC_TOO_LARGE } from "./escrow-terms.js";

export const ESCROW_CHANGED =
  "this escrow differs from its preview: the spec at spec_url, the wallets it is sealed to, its claim list or another term changed, or no approval was given; preview it again and show the user";

const ESCROW_APPROVAL = "pass it back with send: true; a send whose spec, claim list or terms differ from this preview is refused";

const APPROVAL_INPUT = "the approval the preview returned; needed with send";

export const ESCROW_EXPIRES_IN = 86_400;

export const NO_SPEC_HASH = `no spec_hash, so workers cannot find this escrow with ${tool("find_jobs")}; give spec_hash and spec_url to list it`;

export const JOB_LIVE = `offered, no worker guaranteed: tell the user; ${tool("wallet_worker")} starts one; ${tool("wallet_check_delivery")} then ${tool("wallet_attest")} the earliest announcer`;

export const SPEC_MUST = "the spec must say what to deliver, in what form, and how it is checked";

export const SPEC_ANSWER_OUT =
  "the earliest announcer is paid, so for work anyone could compute keep the answer and its sha256 out of the spec, or another wallet can build it and announce first";

export const CLAIMS_ADVICE = "for such work give claim_stake and claim_secs to open claims, which reserve the job for one worker";

export const SPEC_NO_ANSWER = `${SPEC_ANSWER_OUT}; ${CLAIMS_ADVICE}`;

export const recordAccountWhy = (mint: Address) =>
  `Why: the program needs a token account for the recorded output ${mint} even though an escrow pays nothing into it; later escrows that record the same token reuse it`;

const createsRecordAccount = (mint: Address) => `Setup: creates your token account for ${mint} (you pay its rent)`;

export const explainedSetup = (summary: readonly string[], mint: Address): string[] =>
  summary.flatMap((line) => (line === createsRecordAccount(mint) ? [line, recordAccountWhy(mint)] : [line]));

export const RECORD_MINT_NEEDED = "selling SOL on this RPC needs record_mint: any other token's mint, which only labels the escrow";

function recordedMint(sell: Address, url: string, chosen: string | undefined): Address {
  if (chosen !== undefined) {
    return mintNamed(chosen, url, "record_mint");
  }
  if (sell !== NATIVE_MINT) {
    return NATIVE_MINT;
  }
  const test = tokenNamed("TEST", url);
  if (test instanceof Error) {
    throw new InvalidInput([{ path: "record_mint", message: RECORD_MINT_NEEDED }]);
  }
  return test as Address;
}

export const walletEscrow = define({
  name: tool("wallet_escrow"),
  title: "Escrow a payment for an attestor to release",
  description: `Locks payment until its attestor (the judge) approves; this wallet may be the attestor. spec_url lists it in ${tool("find_jobs")}; ${SPEC_MUST}. ${ALLOW_WRONG_SPEC}. ${UPLOAD_PUBLIC} ${PREVIEW_APPROVAL}`,
  effect: "submit",
  repeats: true,
  input: object({
    sell: text("SOL, TEST or a mint address: the token to pay with"),
    amount: text("whole tokens to escrow, such as 0.05"),
    attestor: account("the wallet whose signature alone releases the escrow, such as this wallet's own address to judge the work yourself, or a committee's address; at or above the token's committee floor it must be a committee of 2 or more"),
    min_result: optional(amount("least result the attestor may attest, a plain count not whole tokens; default 1")),
    max_result: optional(amount("greatest result the attestor may attest, a plain count not whole tokens; default min_result")),
    spec_hash: optional(hex32(`64 hex: the sha256 of the acceptance spec the attestor must verify; ${SPEC_MUST}. Setting it binds the release to a signature over that exact spec, so the attestor cannot sign a generic result; never put the answer or its sha256 in the spec of work others could compute`)),
    spec_url: optional(text(`where the acceptance spec is published, ${MEMO_URL_RULE}; needs spec_hash. Recorded in a memo this wallet signs with the escrow`)),
    judge_fee: optional(text("whole tokens of sell paid to the attestor out of the escrow when it settles, such as 0.001; needs spec_hash and must be below amount")),
    expires_in: optional(integer(MIN_EXPIRES_IN, MAX_EXPIRES_IN, `least seconds the escrow stays open once sent; default ${ESCROW_EXPIRES_IN}`)),
    record_mint: optional(text("a token the escrow records as its output, other than sell; only a label. Default SOL, or TEST when selling SOL on devnet")),
    ...uploadInputs,
    ...claimInputs,
    ...allowWrongSpec,
    approval: optional(text(APPROVAL_INPUT)),
    send: optional(flag("true signs and sends; leave out to preview")),
  }),
  output: object({ ...offerFields, ...uploadOutputs, approval: text(ESCROW_APPROVAL) }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const wallet = access(ctx);
    const sold = mintNamed(input.sell, wallet.url, "sell");
    const least = input.min_result ?? 1n;
    const most = input.max_result ?? least;
    if (most < least) {
      throw new InvalidInput([{ path: "max_result", message: "must be at least min_result" }]);
    }
    const specHash = input.spec_hash;
    if (input.judge_fee !== undefined && specHash === undefined) {
      throw new InvalidInput([{ path: "judge_fee", message: "needs spec_hash" }]);
    }
    if (input.spec_url !== undefined && specHash === undefined) {
      throw new InvalidInput([{ path: "spec_url", message: "needs spec_hash" }]);
    }
    if (input.spec_text !== undefined) {
      checkedText(input.spec_text, specHash, "spec_text");
    }
    const claims = await claimTerms(input, false, ctx.transport);
    if (claims !== undefined && specHash === undefined) {
      throw new InvalidInput([{ path: "claim_stake", message: CLAIMS_NEED_SPEC }]);
    }
    if (input.spec_url !== undefined && !isMemoUrl(input.spec_url)) {
      throw new InvalidInput([{ path: "spec_url", message: `must be ${MEMO_URL_RULE}` }]);
    }
    const spec = specReader(ctx);
    const preflight = input.spec_url !== undefined && specHash !== undefined ? await specPreflight(ctx, await spec(input.spec_url), specHash, input.attestor) : undefined;
    if (input.send === true) {
      refuseWrongSpec(preflight, input.allow_wrong_spec, "spec_url");
    }
    const upload = specHash === undefined ? undefined : await uploadPlan(ctx, { specHash, specText: input.spec_text, found: input.spec_url === undefined ? undefined : await spec(input.spec_url), publish: input.publish_spec });
    let settled: { amount: bigint; judgeFee: bigint; decimals: number } | undefined;
    const buy = recordedMint(sold, wallet.url, input.record_mint);
    const signer = await signerOf(ctx);
    const workers = claims !== undefined && input.spec_url !== undefined ? await claimantsOf(ctx, signer.address, spec)(input.spec_url, input.attestor) : undefined;
    const listed = claims === undefined ? undefined : { terms: claims, workers };
    const costs = await escrowCosts(ctx.transport, { owner: signer.address, sell: sold, buy, claims: claims !== undefined, listed: workers !== undefined });
    let network = 0n;
    let sends = 1;
    const priced = (lamports: bigint, count: number) => {
      network = lamports;
      sends = count;
    };
    let approval = "";
    const fees = await createFeesOf(ctx.transport);
    const bound = { previewNext: PREVIEW_APPROVAL_NEXT, approval: input.approval, changed: ESCROW_CHANGED };
    const escrowed = await offeredWithClaims(ctx, call, { sell: sold, buy, send: input.send, priced, ...bound }, (token, _, now) => {
      const amountIn = raw(input.amount, token.decimals, "amount");
      const judgeFee = input.judge_fee === undefined ? 0n : raw(input.judge_fee, token.decimals, "judge_fee");
      approval = termsApproval({
        action: "escrow",
        ...fees,
        owner: signer.address,
        sell: sold,
        buy,
        amount: amountIn,
        judge_fee: judgeFee,
        min_result: least,
        max_result: most,
        attestor: input.attestor,
        spec_hash: specHash ?? null,
        spec_url: input.spec_url ?? null,
        expires_in: input.expires_in ?? ESCROW_EXPIRES_IN,
        claims: claims === undefined ? null : { stake: claims.stake, max_secs: claims.maxSecs },
        workers: workers ?? null,
        spec: preflight ?? null,
        allow_wrong_spec: input.allow_wrong_spec === true,
        mirror: uploadBound(upload),
      });
      settled = { amount: amountIn, judgeFee, decimals: token.decimals };
      return {
        order: {
          kind: "attested",
          amount_in: amountIn,
          min_result: least,
          max_result: most,
          attestor: input.attestor,
          ...(specHash === undefined ? {} : { spec_hash: specHash }),
          ...(input.judge_fee === undefined ? {} : { judge_fee: judgeFee }),
        },
        expires_at: now + BigInt((input.expires_in ?? ESCROW_EXPIRES_IN) + LANDING_SECONDS),
        ...(input.spec_url === undefined ? {} : { spec_url: input.spec_url }),
        approval,
      };
    }, JOB_LIVE, listed, signer);
    const summary = [
      ...explainedSetup((escrowed["summary"] as string[]) ?? [], buy),
      ...(claims === undefined ? [] : [claims.line, ...listedLines(workers)]),
      ...(settled === undefined ? [] : [await feeLine(ctx, settled), ...costLines(costs, network, settled.amount, 1, sends)]),
      ...(upload === undefined || escrowed["sent"] === true ? [] : [uploadLine(upload)]),
    ];
    const ownKey = input.attestor === signer.address && signer.device === undefined;
    const warnings = [
      ...((escrowed["warnings"] as string[]) ?? []).filter((line) => !(ownKey && line.startsWith(WARN_NO_JUDGE_KEY))),
      ...(input.send === true ? [] : wrongSpecLines(preflight, input.allow_wrong_spec)),
      ...(input.send === true ? [] : readerLines(upload, input.spec_url !== undefined)),
      ...(specHash === undefined ? [NO_SPEC_HASH] : input.send === true ? [] : [claims === undefined ? SPEC_NO_ANSWER : SPEC_ANSWER_OUT]),
    ];
    if (escrowed["sent"] !== true || upload === undefined) {
      return { ...escrowed, summary, warnings, approval };
    }
    const { fields, failed } = await uploadsAfterSend(ctx, [upload]);
    return { ...escrowed, summary, warnings, approval, ...fields[0], ...(failed ? { next: withUploadHint(escrowed["next"], uploadFailed(input.spec_url !== undefined)) } : {}) };
  },
});

async function feeLine(ctx: AgentContext, settled: { amount: bigint; judgeFee: bigint; decimals: number }): Promise<string> {
  const bps = feeBpsFor((await loadConfig(ctx.transport)).config, Kind.AttestedResult);
  const { net } = splitFees(settled.amount - settled.judgeFee, bps, 0, 0);
  return `Payee receives: ${formatAmount(net, settled.decimals)}, after the ${bps / 100}% protocol fee at today's config`;
}

export const MAX_PIECES = 12;

export const PIECE_ONE = "Piece 1 only";

export const piecesPartlySent = (sent: number, total: number, problem: string) =>
  `${sent} of ${total} pieces were escrowed; the next failed with ${problem}. To finish, escrow only the ${total - sent} remaining pieces; do not repeat this call`;

export const piecesMayHaveLanded = (sent: number, total: number, problem: string) =>
  `${sent} of ${total} pieces were escrowed and the next may have landed too (${problem}); check ${tool("wallet_intents")} before escrowing any again, and do not repeat this call`;

export const pieceUnsettled = (index: number, name: string) => `nothing was escrowed: piece ${index} (${name}) cannot be paid; `;

type Piece = { name: string; amountIn: bigint; attestor: Address; specHash: string | undefined; specUrl: string | undefined };

type Spec = { spec_hash?: string | undefined; spec_url?: string | undefined };

async function checkedSpec(ctx: AgentContext, plan: Spec, piece: Spec, i: number): Promise<{ specHash: string | undefined; specUrl: string | undefined }> {
  const specHash = piece.spec_hash ?? plan.spec_hash;
  const specUrl = piece.spec_url ?? plan.spec_url;
  if (specUrl === undefined) {
    return { specHash, specUrl };
  }
  const path = piece.spec_url === undefined ? "spec_url" : `pieces.${i}.spec_url`;
  if (specHash === undefined) {
    throw new InvalidInput([{ path, message: "needs spec_hash" }]);
  }
  if (!isMemoUrl(specUrl)) {
    throw new InvalidInput([{ path, message: `must be ${MEMO_URL_RULE}` }]);
  }
  if (await plainHttpOnPublic(ctx.transport, specUrl)) {
    throw new InvalidInput([{ path, message: SPEC_URL_PLAIN }]);
  }
  return { specHash, specUrl };
}

function pieceLimits(planned: readonly Piece[], lists: readonly Claimants[]): string[] {
  const shown = lists.map((workers) => listedLines(workers).join(""));
  if (shown.every((line) => line === shown[0])) {
    return shown[0] === "" || shown[0] === undefined ? [] : [shown[0]];
  }
  return shown.flatMap((line, i) => (line === "" ? [] : [`Piece ${i + 1} (${planned[i]?.name ?? ""}): ${line}`]));
}

function checkedText(specText: string, specHash: string | undefined, path: string): void {
  const problem = specHash === undefined ? "needs spec_hash" : specTextProblem(specText, specHash);
  if (problem !== undefined) {
    throw new InvalidInput([{ path, message: problem }]);
  }
}

const specBytes = (specHash: string | undefined): Uint8Array => (specHash === undefined ? new Uint8Array(32) : Uint8Array.from(Buffer.from(specHash, "hex")));

const pieceText = (plan: { spec_text?: string | undefined }, piece: { spec_hash?: string | undefined; spec_text?: string | undefined }): string | undefined => piece.spec_text ?? (piece.spec_hash === undefined ? plan.spec_text : undefined);

export const walletEscrowPlan = define({
  name: tool("wallet_escrow_plan"),
  title: "Escrow a task's pieces in one plan",
  description: `Pays for a larger task in pieces: one preview and send lock a payment per piece, each like ${tool("wallet_escrow")}; cancel one with ${tool("wallet_cancel")}. spec_hash and spec_url list pieces in ${tool("find_jobs")}; ${ALLOW_WRONG_SPEC}. Workers deliver to the attestor. ${UPLOAD_PUBLIC} ${PREVIEW_APPROVAL}`,
  effect: "submit",
  repeats: true,
  input: object({
    sell: text("SOL, TEST or a mint address: the token to pay with"),
    attestor: account("the wallet that releases every piece that names no attestor of its own"),
    spec_hash: optional(hex32("64 hex: the sha256 of the acceptance spec of every piece that names none; it binds each release to that spec")),
    spec_url: optional(text(`where that spec is published, ${MEMO_URL_RULE}; needs spec_hash; for every piece that names none`)),
    ...uploadInputs,
    pieces: list(
      object({
        name: text("a label for the piece, shown in the plan only"),
        amount: text("whole tokens this piece pays, such as 0.01"),
        attestor: optional(account("this piece's attestor, instead of the plan's")),
        spec_hash: optional(hex32("this piece's spec_hash, instead of the plan's")),
        spec_url: optional(text("this piece's spec_url, instead of the plan's")),
        spec_text: optional(text("this piece's spec_text, instead of the plan's; a piece with its own spec_hash does not take the plan's")),
      }),
      MAX_PIECES,
      "the pieces, in order",
      2,
    ),
    expires_in: optional(integer(MIN_EXPIRES_IN, MAX_EXPIRES_IN, `least seconds each escrow stays open once sent; default ${ESCROW_EXPIRES_IN}`)),
    record_mint: optional(text("a token the escrows record as their output, other than sell; only a label. Default SOL, or TEST when selling SOL on devnet")),
    ...claimInputs,
    ...allowWrongSpec,
    approval: optional(text(APPROVAL_INPUT)),
    send: optional(flag("true signs and sends every piece; leave out to preview")),
  }),
  output: object({
    pieces: list(
      object({
        name: text(),
        amount: text(),
        attestor: account(),
        spec_hash: optional(text()),
        spec_url: optional(text()),
        intent: optional(account()),
        nonce: optional(amount()),
        signature: optional(text()),
        ...uploadOutputs,
      }),
      MAX_PIECES,
    ),
    total: text("whole tokens escrowed across all pieces"),
    summary: list(text(), 64, `the plan, then lines marked ${PIECE_ONE} that describe the first piece alone`),
    warnings: list(text(), 40),
    approval: text(ESCROW_APPROVAL),
    sent: flag(),
    next: optional(text()),
    untrusted_detail: optional(text(UNTRUSTED_DETAIL)),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const wallet = access(ctx);
    const signer = await signerOf(ctx);
    oneAtATime(signer);
    const claims = await claimTerms(input, true, ctx.transport);
    const sold = mintNamed(input.sell, wallet.url, "sell");
    const buy = recordedMint(sold, wallet.url, input.record_mint);
    const [token, now, { config }] = await Promise.all([mintOf(ctx.transport, sold), chainTime(ctx.transport), loadConfig(ctx.transport)]);
    const planned: Piece[] = [];
    for (const [i, piece] of input.pieces.entries()) {
      planned.push({
        name: piece.name,
        amountIn: raw(piece.amount, token.decimals, `pieces.${i}.amount`),
        attestor: piece.attestor ?? input.attestor,
        ...(await checkedSpec(ctx, input, piece, i)),
      });
      const specText = pieceText(input, piece);
      if (specText !== undefined) {
        checkedText(specText, piece.spec_hash ?? input.spec_hash, `pieces.${i}.spec_text`);
      }
    }
    const unproven = planned.findIndex((piece) => piece.specHash === undefined);
    if (claims !== undefined && unproven >= 0) {
      throw new InvalidInput([{ path: `pieces.${unproven}.spec_hash`, message: CLAIMS_NEED_SPEC }]);
    }
    const spec = specReader(ctx);
    const invites = claimantsOf(ctx, signer.address, spec);
    const lists: Claimants[] = [];
    for (const piece of planned) {
      lists.push(claims === undefined || piece.specUrl === undefined ? undefined : await invites(piece.specUrl, piece.attestor));
    }
    const listedOf = (i: number) => (claims === undefined ? undefined : { terms: claims, workers: lists[i] });
    for (const [i, piece] of planned.entries()) {
      const order = { kind: Kind.AttestedResult, amountIn: piece.amountIn, minResult: 1n, maxResult: 1n, attestor: piece.attestor, specHash: specBytes(piece.specHash), judgeFee: 0n } as const;
      const unsettled = neverSettles(order, config, 0, token.decimals);
      if (unsettled !== undefined) {
        throw new AgentRefusal("NeverSettles", `${pieceUnsettled(i + 1, piece.name)}${unsettled}`);
      }
      await escrowJudge(ctx.transport, config, sold, order, token.decimals).catch((error: unknown) => {
        throw error instanceof AgentRefusal ? new AgentRefusal("CommitteeRequired", `${pieceUnsettled(i + 1, piece.name)}${error.message}`) : error;
      });
    }
    const total = planned.reduce((sum, piece) => sum + piece.amountIn, 0n);
    const sales = await salesOf(wallet, now);
    for (const piece of planned) {
      checkSale(wallet.limits, sold, token.decimals, piece.amountIn, now, sales);
    }
    checkHour(wallet.limits, sold, token.decimals, total, now, sales);
    const terms = (piece: Piece, bound?: string) => (_sold: Token, _bought: Token, at: bigint) => ({
      order: {
        kind: "attested" as const,
        amount_in: piece.amountIn,
        min_result: 1n,
        max_result: 1n,
        attestor: piece.attestor,
        ...(piece.specHash === undefined ? {} : { spec_hash: piece.specHash }),
      },
      expires_at: at + BigInt((input.expires_in ?? ESCROW_EXPIRES_IN) + LANDING_SECONDS),
      ...(piece.specUrl === undefined ? {} : { spec_url: piece.specUrl }),
      ...(bound === undefined ? {} : { approval: bound }),
    });
    const name = TOKEN_NAMES[sold] ?? sold;
    const listed = (piece: Piece) => ({
      name: piece.name,
      amount: formatAmount(piece.amountIn, token.decimals),
      attestor: piece.attestor,
      ...(piece.specHash === undefined ? {} : { spec_hash: piece.specHash }),
      ...(piece.specUrl === undefined ? {} : { spec_url: piece.specUrl }),
    });
    const unlisted = planned.flatMap((piece, i) => (piece.specHash === undefined ? [`Piece ${i + 1} (${piece.name}): ${NO_SPEC_HASH}`] : []));
    const checks = await Promise.all(
      planned.map(async (piece) => (piece.specUrl === undefined || piece.specHash === undefined ? undefined : specPreflight(ctx, await spec(piece.specUrl), piece.specHash, piece.attestor))),
    );
    if (input.send === true) {
      for (const [i, piece] of planned.entries()) {
        refuseWrongSpec(checks[i], input.allow_wrong_spec, input.pieces[i]?.spec_url === undefined ? "spec_url" : `pieces.${i}.spec_url`, `Piece ${i + 1} (${piece.name}): `);
      }
    }
    const uploads = await pieceUploadPlans(
      ctx,
      await Promise.all(
        planned.map(async (piece, i) => {
          const source = input.pieces[i];
          return piece.specHash === undefined || source === undefined ? undefined : { specHash: piece.specHash, specText: pieceText(input, source), found: piece.specUrl === undefined ? undefined : await spec(piece.specUrl), publish: input.publish_spec };
        }),
      ),
    );
    const fees = { create_fee: BigInt(config.createFee), crank_bounty: BigInt(config.crankBounty) };
    const approval = termsApproval({
      action: "escrow_plan",
      ...fees,
      owner: signer.address,
      sell: sold,
      buy,
      expires_in: input.expires_in ?? ESCROW_EXPIRES_IN,
      claims: claims === undefined ? null : { stake: claims.stake, max_secs: claims.maxSecs },
      allow_wrong_spec: input.allow_wrong_spec === true,
      pieces: planned.map((piece, i) => ({
        name: piece.name,
        amount: piece.amountIn,
        attestor: piece.attestor,
        spec_hash: piece.specHash ?? null,
        spec_url: piece.specUrl ?? null,
        workers: lists[i] ?? null,
        spec: checks[i] ?? null,
        mirror: uploadBound(uploads[i]),
      })),
    });
    const preflights = input.send === true ? [] : planned.flatMap((piece, i) => [...wrongSpecLines(checks[i], input.allow_wrong_spec), ...readerLines(uploads[i], piece.specUrl !== undefined)].map((line) => `Piece ${i + 1} (${piece.name}): ${line}`));
    const [head, ...rest] = planned as [Piece, ...Piece[]];
    const costs = await escrowCosts(ctx.transport, { owner: signer.address, sell: sold, buy, claims: claims !== undefined, listed: lists.some((workers) => workers !== undefined) });
    let firstFee = 0n;
    let sends = 1;
    const priced = (lamports: bigint, count: number) => {
      firstFee = lamports;
      sends = count;
    };
    const bound = { previewNext: PREVIEW_APPROVAL_NEXT, approval: input.approval, changed: ESCROW_CHANGED };
    const listedRest = lists.some((workers) => workers !== undefined);
    const restFees = listedRest ? await previewFees(ctx, call, { sell: sold, buy }, rest.map((piece, i) => ({ terms: terms(piece), claims: listedOf(i + 1) })), signer) : [];
    const first = await offeredWithClaims(ctx, call, { sell: sold, buy, send: input.send, priced, ...bound }, terms(head, approval), undefined, listedOf(0), signer);
    const network = [{ lamports: firstFee, sends }, ...(listedRest ? restFees : rest.map(() => ({ lamports: firstFee, sends })))];
    const ownKey = head.attestor === signer.address && signer.device === undefined;
    const afterSend = async (done: Record<string, unknown>[], next: string): Promise<{ pieces: Record<string, unknown>[]; next: string }> => {
      const { fields, failed } = await uploadsAfterSend(ctx, uploads.map((plan, i) => (done[i]?.["intent"] === undefined ? undefined : plan)));
      const hint = planned.some((piece) => piece.specUrl === undefined) ? uploadFailed(false) : uploadFailed(true);
      return { pieces: done.map((piece, i) => ({ ...piece, ...fields[i] })), next: failed ? withUploadHint(next, hint) : next };
    };
    const shown = {
      total: formatAmount(total, token.decimals),
      summary: [
        `Plan: ${planned.length} pieces, ${formatAmount(total, token.decimals)} of ${name} in all, each escrowed now and released on its own`,
        ...planned.map(
          (piece, i) =>
            `Piece ${i + 1}: ${piece.name}, ${formatAmount(piece.amountIn, token.decimals)} of ${name}, released by ${piece.attestor}${piece.specHash === undefined ? "" : ` against spec ${piece.specHash}`}`,
        ),
        ...pieceCostLines(costs, network, total),
        ...(input.send === true ? [] : planLines(uploads)),
        ...(claims === undefined ? [] : [claims.line, ...pieceLimits(planned, lists)]),
        ...explainedSetup(first["summary"] as string[], buy).map((line) => `${PIECE_ONE}: ${line}`),
      ],
      warnings: [...(first["warnings"] as string[]).filter((line) => !(ownKey && line.startsWith(WARN_NO_JUDGE_KEY))), ...unlisted, ...preflights],
      approval,
    };
    if (input.send !== true) {
      return { pieces: planned.map(listed), ...shown, sent: false, next: first["next"] };
    }
    const pieces = [{ ...listed(head), intent: first["intent"], nonce: first["nonce"], signature: first["signature"] }];
    for (const [i, piece] of rest.entries()) {
      try {
        const made = await offeredWithClaims(ctx, call, { sell: sold, buy, send: true, fees, changed: ESCROW_CHANGED }, terms(piece), undefined, listedOf(i + 1), signer);
        pieces.push({ ...listed(piece), intent: made["intent"], nonce: made["nonce"], signature: made["signature"] });
      } catch (error) {
        for (const undo of call.undo.splice(0)) {
          undo();
        }
        const problem = problemOf(error);
        const reason = `${problem.code}: ${problem.hint}`;
        return {
          ...shown,
          sent: true,
          ...(await afterSend([...pieces, ...planned.slice(pieces.length).map(listed)], refusedBeforeSending(error) ? piecesPartlySent(pieces.length, planned.length, reason) : piecesMayHaveLanded(pieces.length, planned.length, reason))),
          ...(problem.untrustedDetail === undefined ? {} : { untrusted_detail: problem.untrustedDetail }),
        };
      }
    }
    return {
      ...shown,
      sent: true,
      ...(await afterSend(pieces, `${planned.length} pieces offered, no worker guaranteed: tell the user; ${tool("wallet_check_delivery")} then ${tool("wallet_attest")} each earliest announcer`)),
    };
  },
});
