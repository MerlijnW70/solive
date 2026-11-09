import type { Cli, Demo, Found, Settings } from "./demo-worker-module.js";

export const WORKER = "Worker1111111111111111111111111111111111111";
export const NOW = 1_800_000_000;
export const START_BALANCE = 1_930_000_000n;
export const DEMO: Demo = { name: "fizzbuzz", specHash: "638375b5fb917437e51237bfcbcf690bdb583eeac4ee2d07bd8e39e9d921ae70", solution: "/x/solution.mjs", workUrl: "https://x/solution.mjs" };
export const SETTINGS: Settings = { keypair: "k.json", wallet: WORKER, maxStake: 50_000_000n, maxAtRisk: 150_000_000n, maxPerOwner: 50_000_000n, claimSecs: 900, maxReviewSecs: 86_400, maxOpenDeliveries: 30, breaker: { strikes: 3, ownerStrikes: 1, windowSecs: 86_400 } };

export type Terms = { owner?: string; stake?: bigint; reviewSecs?: number; killFee?: bigint; maxSecs?: number; expiresIn?: number };

type Board = { intent: string; owner: string; nonce: string; stake: bigint; killFee: bigint; reviewSecs: number; maxSecs: number; expiresAt: number; worker: string | null; until: number; reviewUntil: number | null };

export class ScriptedChain {
  now = NOW;
  calls: string[][] = [];
  balances = new Map<string, bigint>([[WORKER, START_BALANCE]]);
  failNext = new Map<string, number>();
  unprotected = new Set<string>();
  unsealable = new Set<string>();
  failYes = new Set<string>();
  closable = new Set<string>();
  private boards = new Map<string, Board>();
  announced = new Set<string>();
  private nonce = 0;

  escrow(intent: string, terms: Terms = {}): Found {
    const nonce = String((this.nonce += 1));
    const board: Board = {
      intent,
      owner: terms.owner ?? `owner-of-${intent}`,
      nonce,
      stake: terms.stake ?? 10_000_000n,
      killFee: terms.killFee ?? 0n,
      reviewSecs: terms.reviewSecs ?? 3_600,
      maxSecs: terms.maxSecs ?? 7_200,
      expiresAt: this.now + (terms.expiresIn ?? 86_400),
      worker: null,
      until: 0,
      reviewUntil: null,
    };
    this.boards.set(`${board.owner}:${nonce}`, board);
    return { demo: DEMO, job: { intent, owner: board.owner, nonce, specHash: DEMO.specHash, takesClaims: true, claimedBy: null, waiting: 0, expiresAt: board.expiresAt } };
  }

  balance(wallet: string = WORKER): bigint {
    return this.balances.get(wallet) ?? 0n;
  }

  count(verb: string): number {
    return this.calls.filter((args) => `${args[0]} ${args[1]}`.startsWith(verb)).length;
  }

  ownerTakesLapsed(): void {
    for (const board of this.boards.values()) {
      if (board.worker !== null && board.reviewUntil === null && this.now >= board.until) {
        this.move(board.owner, board.stake);
        board.worker = null;
      }
    }
  }

  release(intent: string): void {
    const board = this.byIntent(intent);
    if (board.worker !== null) {
      this.move(board.worker, board.stake);
      board.worker = null;
      board.reviewUntil = null;
    }
  }

  cli: Cli = async (args) => {
    this.calls.push([...args]);
    const at = (flag: string) => String(args[args.indexOf(flag) + 1]);
    const verb = args[0] === "claims" ? `claims ${args[1]}` : String(args[0]);
    const failing = this.failNext.get(verb) ?? 0;
    if (failing > 0) {
      this.failNext.set(verb, failing - 1);
      throw new Error(`${verb} failed: HTTP error (503): the node is busy`);
    }
    if (verb === "deliver") {
      const intent = at("--intent");
      if (this.unsealable.has(intent)) {
        throw new Error(`deliver --keypair failed: 4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM has no encryption key`);
      }
      if (this.failYes.has(intent) && args.includes("--yes")) {
        throw new Error("deliver --keypair failed: the program refused the announcement");
      }
      return this.deliver(intent, args.includes("--yes"));
    }
    if (verb === "reclaim") {
      const closed = [...this.announced].filter((intent) => this.closable.has(intent));
      closed.forEach((intent) => this.announced.delete(intent));
      return { closed: closed.map((intent) => `ann-${intent}`), kept: [...this.announced].map((intent) => `ann-${intent}`), sent: closed.length > 0 };
    }
    const board = this.boards.get(`${at("--owner")}:${at("--nonce")}`);
    if (board === undefined) {
      throw new Error(`${verb} failed: escrow takes no claims; its owner opens them with claims open`);
    }
    switch (verb) {
      case "claims show":
        return this.shown(board);
      case "claims take":
        return this.take(board, Number(at("--secs")));
      case "claims collect":
        return this.collect(board);
      case "claims drop":
        return this.drop(board);
      default:
        throw new Error(`unexpected command ${args.join(" ")}`);
    }
  };

  private byIntent(intent: string): Board {
    const board = [...this.boards.values()].find((each) => each.intent === intent);
    if (board === undefined) {
      throw new Error(`no escrow ${intent}`);
    }
    return board;
  }

  private move(to: string, lamports: bigint): void {
    this.balances.set(to, this.balance(to) + lamports);
  }

  private state(board: Board): "free" | "held" | "lapsed" {
    return board.worker === null ? "free" : board.reviewUntil !== null || this.now < board.until ? "held" : "lapsed";
  }

  private shown(board: Board): object {
    const review = board.reviewUntil === null || board.worker === null ? null : { announcement: "Ann", until: String(board.reviewUntil), secondsLeft: String(Math.max(board.reviewUntil - this.now, 0)), lapsed: this.now >= board.reviewUntil };
    const state = this.state(board);
    return { state, worker: state === "free" ? null : board.worker, until: String(board.until), stake: String(board.stake), max_secs: board.maxSecs, review_secs: board.reviewSecs, kill_fee: String(board.killFee), review, line: { head: 0, tail: 0, waiting: 0 } };
  }

  private take(board: Board, secs: number): object {
    if (this.state(board) === "held" || secs > board.maxSecs || this.now + secs + board.reviewSecs > board.expiresAt) {
      throw new Error("claims take failed: the program refused the claim");
    }
    this.move(WORKER, -board.stake);
    board.worker = WORKER;
    board.until = this.now + secs;
    return { sent: true, signature: `take-${board.intent}` };
  }

  private protects(board: Board | undefined): boolean {
    return board !== undefined && !this.unprotected.has(board.intent) && board.reviewSecs > 0 && board.worker === WORKER && this.now < board.until && board.reviewUntil === null && this.now <= board.expiresAt - board.reviewSecs;
  }

  private deliver(intent: string, yes: boolean): object {
    const board = [...this.boards.values()].find((each) => each.intent === intent);
    if (this.announced.has(intent)) {
      return { sent: false, seq: "0", state: "open", protected: false, next: "this work is already announced to this escrow with this url; nothing was sent" };
    }
    const armed = this.protects(board);
    const summary = armed ? ["Protected: this announcement arms a review"] : ["Unprotected: the escrow's claims open no review window, so no announcement arms a review"];
    if (!yes) {
      return { sent: false, protected: armed, summary };
    }
    this.announced.add(intent);
    if (armed && board !== undefined) {
      board.reviewUntil = this.now + board.reviewSecs;
    }
    return { sent: true, signature: `announce-${intent}`, protected: armed, ...(armed && board !== undefined ? { review_until: String(board.reviewUntil) } : {}), summary };
  }

  private collect(board: Board): object {
    if (board.worker !== WORKER || board.reviewUntil === null) {
      throw new Error("claims collect failed: the escrow has no armed review, so there is no kill fee to collect; nothing was sent");
    }
    if (this.now < board.reviewUntil) {
      throw new Error(`claims collect failed: the escrow has its review running until ${board.reviewUntil}; nothing was sent`);
    }
    this.move(WORKER, board.stake + board.killFee);
    this.move(board.owner, -board.killFee);
    board.worker = null;
    board.reviewUntil = null;
    return { sent: true, signature: `collect-${board.intent}` };
  }

  private drop(board: Board): object {
    if (board.worker !== WORKER || this.state(board) !== "held") {
      throw new Error("claims drop failed: this worker holds no claim; nothing was sent");
    }
    this.move(WORKER, board.stake);
    board.worker = null;
    return { sent: true, signature: `drop-${board.intent}` };
  }
}
