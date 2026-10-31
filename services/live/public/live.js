"use strict";
(() => {
  const FEED_URL = "/api/feed";
  const POLL_MS = 30000;
  const TICK_MS = 5000;
  const ANNOUNCE_MS = 60000;
  const QUIET_MS = 900000;
  const STREAM_MAX = 50;
  const EXPLORER = "https://explorer.solana.com/";
  const SVG = "http://www.w3.org/2000/svg";
  const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
  const HEX64 = /^[0-9a-f]{64}$/;
  const AMOUNT = /^[0-9]{1,30}(\.[0-9]{1,18})?$/;
  const SPEC_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
  const DEMOS = ["fizzbuzz", "palindrome", "reverse-words"];
  const KINDS = {
    escrow: { label: "Escrow", icon: "lock" },
    claim: { label: "Claim", icon: "hand" },
    delivery: { label: "Delivery", icon: "box" },
    release: { label: "Release", icon: "paid" },
    refund: { label: "Refund", icon: "back" },
    swap: { label: "Swap", icon: "swap" },
  };
  const STEPS = [
    { key: "escrow", kind: "escrow", title: "pay locked for the pinned spec", role: "hirer" },
    { key: "delivery", kind: "delivery", title: "work announced to the judge", role: "worker" },
    { key: "release", kind: "release", title: "judge passed it, worker paid", role: "judge" },
  ];
  const SERVICES = ["faucet", "demo_worker", "filler"];
  const SERVICE_WORDS = { up: "Up", down: "Down", unknown: "Unknown" };

  const $ = (id) => document.getElementById(id);
  const state = {
    feed: null,
    paused: false,
    failed: false,
    timer: null,
    ticker: null,
    controller: null,
    seen: new Set(),
    counted: new Set(),
    queued: 0,
    pointer: false,
    focus: false,
    announced: -Infinity,
    pending: 0,
    numbers: {},
    clocks: [],
  };

  const isSignature = (s) => typeof s === "string" && (s.length === 87 || s.length === 88) && BASE58.test(s);
  const isAddress = (s) => typeof s === "string" && s.length >= 32 && s.length <= 44 && BASE58.test(s);
  const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
  const isAmount = (s) => typeof s === "string" && AMOUNT.test(s);
  const timeOf = (s) => (typeof s === "string" ? Date.parse(s) : NaN);
  const short = (s) => s.slice(0, 4) + "…" + s.slice(-4);

  function node(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.setAttribute("class", cls);
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function icon(name, cls) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", cls ? "icon " + cls : "icon");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const use = document.createElementNS(SVG, "use");
    use.setAttribute("href", "#icon-" + name);
    svg.append(use);
    return svg;
  }

  function explorer(path, value, text, cls) {
    const a = node("a", cls, text);
    a.setAttribute("href", EXPLORER + path + "/" + value + "?cluster=devnet");
    a.setAttribute("rel", "noopener noreferrer");
    return a;
  }

  function txLink(signature) {
    if (!isSignature(signature)) return node("span", "sig", "–");
    const a = explorer("tx", signature, short(signature), "sig");
    a.setAttribute("title", "Transaction " + signature + " on the devnet explorer");
    a.append(icon("out", "icon-out"));
    return a;
  }

  function addressLink(address) {
    if (!isAddress(address)) return node("span", "who", "–");
    const a = explorer("address", address, short(address), "who");
    a.setAttribute("title", address);
    return a;
  }

  function amountNode(amount, token, cls) {
    const el = node("span", cls);
    if (!isAmount(amount)) {
      el.textContent = "–";
      return el;
    }
    el.append(amount);
    if (token === "SOL" || token === "TEST") el.append(" ", node("span", "unit", token));
    else if (isAddress(token)) {
      const unit = node("span", "unit", short(token));
      unit.setAttribute("title", "Token mint " + token);
      el.append(" ", unit);
    }
    return el;
  }

  function relative(ms) {
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 5) return "just now";
    if (s < 60) return s + "s ago";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 48) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  function utc(ms) {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  }

  function clock(iso, cls) {
    const ms = timeOf(iso);
    const el = node("time", cls);
    if (!Number.isFinite(ms)) {
      el.textContent = "–";
      return el;
    }
    el.setAttribute("datetime", new Date(ms).toISOString());
    el.setAttribute("title", utc(ms));
    el.textContent = relative(ms);
    state.clocks.push({ el, ms });
    return el;
  }

  function tick() {
    state.clocks = state.clocks.filter((c) => c.el.isConnected);
    for (const c of state.clocks) c.el.textContent = relative(c.ms);
  }

  function setStatus(tone, parts) {
    const status = $("status");
    status.setAttribute("data-tone", tone);
    $("status-text").replaceChildren(...parts);
  }

  function renderStatus() {
    const feed = state.feed;
    if (state.paused) {
      setStatus("paused", ["Paused. No reads until you resume."]);
      return;
    }
    if (!feed) {
      setStatus(state.failed ? "down" : "idle", [state.failed ? "Feed unreachable; trying again every 30 s." : "Reading /api/feed"]);
      return;
    }
    if (state.failed) {
      setStatus("down", ["Feed unreachable; showing the read from ", clock(feed.generated_at)]);
    } else if (feed.stale === true) {
      setStatus("stale", ["Devnet is slow; showing activity as of ", clock(feed.stale_since ?? feed.generated_at)]);
    } else {
      setStatus("live", ["Live, updated ", clock(feed.generated_at)]);
    }
  }

  function renderProof(job) {
    const chain = $("chain");
    const spec = $("proof-spec");
    const hash = $("proof-hash");
    if (!job || typeof job !== "object") {
      chain.replaceChildren(node("li", "chain-empty", "No job in the feed's window was paid yet. Post a demo job from Try it and it lands here."));
      spec.replaceChildren();
      hash.hidden = true;
      return;
    }
    const specParts = [];
    if (typeof job.spec_name === "string" && SPEC_NAME.test(job.spec_name)) {
      specParts.push(node("b", null, job.spec_name), " demo spec");
      if (DEMOS.includes(job.spec_name)) {
        const repo = $("repo").getAttribute("href");
        const a = node("a", null, "read it");
        a.setAttribute("href", repo + "/blob/main/examples/demo/" + job.spec_name + "/SPEC.md");
        specParts.push(", ", a);
      }
    } else {
      specParts.push("custom job");
    }
    if (isAddress(job.intent)) specParts.push(" · job ", addressLink(job.intent));
    spec.replaceChildren(...specParts);
    if (typeof job.spec_hash === "string" && HEX64.test(job.spec_hash)) {
      $("proof-hash-value").textContent = job.spec_hash;
      hash.hidden = false;
    } else {
      hash.hidden = true;
    }
    chain.replaceChildren(...STEPS.map((step) => renderStep(step, job[step.key])));
  }

  function renderStep(step, tx) {
    const li = node("li", "step");
    li.setAttribute("data-kind", step.kind);
    const mark = node("span", "step-mark");
    mark.append(icon(KINDS[step.kind].icon));
    const title = node("p", "step-title");
    title.append(node("span", "kind", KINDS[step.kind].label), " · " + step.title);
    if (!tx || typeof tx !== "object") {
      li.setAttribute("class", "step step-missing");
      li.append(mark, title, node("span", "step-time", "–"), node("p", "step-line", "Not in the feed."));
      return li;
    }
    const line = node("p", "step-line");
    const who = node("span");
    who.append(step.role + " ", addressLink(tx.who));
    line.append(who, amountNode(tx.amount, tx.token, "amt"), txLink(tx.signature));
    li.append(mark, title, clock(tx.at, "step-time"), line);
    return li;
  }

  function setNumber(id, tile, value, parts) {
    const el = $(id);
    const key = JSON.stringify(value);
    const before = state.numbers[id];
    el.replaceChildren(...parts);
    if (before !== undefined && before !== key && !state.paused) {
      const t = $(tile);
      t.classList.remove("is-changed");
      void t.offsetWidth;
      t.classList.add("is-changed");
    }
    state.numbers[id] = key;
  }

  function count(n) {
    return isCount(n) ? String(n) : "–";
  }

  function renderNumbers(stats) {
    const s = stats && typeof stats === "object" ? stats : {};
    setNumber("n-open", "tile-open", s.open_jobs, [count(s.open_jobs)]);
    setNumber("n-paid", "tile-paid", s.paid_jobs_7d, [count(s.paid_jobs_7d)]);
    setNumber("n-workers", "tile-workers", s.workers_7d, [count(s.workers_7d)]);
    const split = $("s-paid");
    if (isCount(s.paid_jobs_7d) && isCount(s.house_paid_jobs_7d) && s.house_paid_jobs_7d <= s.paid_jobs_7d) {
      split.replaceChildren(node("b", null, String(s.paid_jobs_7d - s.house_paid_jobs_7d)), " outside · ", node("b", null, String(s.house_paid_jobs_7d)), " house");
    } else {
      split.replaceChildren("split unknown");
    }
    const paid = Array.isArray(s.paid_7d) ? s.paid_7d.filter((p) => p && isAmount(p.amount) && typeof p.token === "string") : [];
    const lines = paid.length ? paid.map((p) => amountNode(p.amount, p.token)) : ["0"];
    setNumber("n-tokens", "tile-tokens", paid, lines);
  }

  function eventKey(e) {
    return e.signature + ":" + e.kind + ":" + e.who;
  }

  function validEvents(feed) {
    if (!Array.isArray(feed.events)) return [];
    return feed.events.filter((e) => e && typeof e === "object" && Object.hasOwn(KINDS, e.kind)).slice(0, STREAM_MAX);
  }

  function renderRow(e, fresh) {
    const li = node("li", "row" + (e.house === true ? " row-house" : "") + (fresh ? " is-new" : ""));
    li.setAttribute("data-kind", e.kind);
    const kind = node("span", "row-kind");
    kind.append(icon(KINDS[e.kind].icon), KINDS[e.kind].label);
    const detail = node("span", "row-detail", typeof e.detail === "string" ? e.detail : "");
    const meta = node("span", "row-meta");
    const who = node("span", "row-who");
    who.append(addressLink(e.who));
    if (e.house === true) who.append(node("span", "tag", "house"));
    const tx = node("span", "row-tx");
    tx.append(txLink(e.signature));
    meta.append(who, amountNode(e.amount, e.token, "row-amt"), clock(e.at, "row-time"), tx);
    li.append(kind, detail, meta);
    return li;
  }

  function busy() {
    if (state.pointer || state.focus) return true;
    return $("stream").getBoundingClientRect().top < 0;
  }

  function renderStream(feed, initial) {
    const events = validEvents(feed);
    const fresh = events.filter((e) => !state.seen.has(eventKey(e)));
    if (!initial && fresh.length && busy()) {
      state.queued = fresh.length;
      const button = $("queued");
      button.textContent = fresh.length === 1 ? "1 new event" : fresh.length + " new events";
      button.hidden = false;
      return;
    }
    flushStream(events, initial ? new Set() : new Set(fresh.map(eventKey)));
  }

  function countNew(feed, initial) {
    let n = 0;
    for (const e of validEvents(feed)) {
      const key = eventKey(e);
      if (state.counted.has(key)) continue;
      state.counted.add(key);
      n += 1;
    }
    return initial ? 0 : n;
  }

  function flushStream(events, fresh) {
    for (const e of events) state.seen.add(eventKey(e));
    state.queued = 0;
    $("queued").hidden = true;
    $("stream").replaceChildren(...events.map((e) => renderRow(e, fresh.has(eventKey(e)))));
    $("empty").hidden = events.length > 0;
  }

  function renderQuiet(feed) {
    const quiet = $("quiet");
    const last = timeOf(feed.last_event_at);
    if (!Number.isFinite(last)) {
      quiet.hidden = true;
      return;
    }
    const parts = ["Last event ", clock(feed.last_event_at)];
    if (Date.now() - last > QUIET_MS) parts.push(". Quiet on devnet right now: post a demo job from Try it and watch its escrow arrive.");
    quiet.replaceChildren(...parts);
    quiet.hidden = false;
  }

  function workerRow(w) {
    const tr = node("tr");
    const wallet = node("td");
    const earned = node("td", "r");
    wallet.append(addressLink(w.wallet));
    earned.append(amountNode(w.paid_sol, "SOL"));
    tr.append(wallet, node("td", "r", count(w.paid_jobs)), earned);
    return tr;
  }

  function fillWorkers(id, list, none) {
    const empty = node("td", "none", none);
    empty.setAttribute("colspan", "3");
    const tr = node("tr");
    tr.append(empty);
    $(id).replaceChildren(...(list.length ? list.map(workerRow) : [tr]));
  }

  function renderWorkers(top) {
    const list = Array.isArray(top) ? top.filter((w) => w && typeof w === "object") : [];
    fillWorkers("workers-outside-rows", list.filter((w) => w.house !== true), "No outside wallet was paid in the last 7 days.");
    fillWorkers("workers-house-rows", list.filter((w) => w.house === true), "No house wallet was paid in the last 7 days.");
  }

  function renderServices(feed) {
    const services = feed.services && typeof feed.services === "object" ? feed.services : {};
    for (const name of SERVICES) {
      const value = Object.hasOwn(SERVICE_WORDS, services[name]) ? services[name] : "unknown";
      const el = $("svc-" + name);
      el.setAttribute("data-state", value);
      el.textContent = SERVICE_WORDS[value];
      $("svc-" + name + "-seen").replaceChildren("checked ", clock(feed.generated_at));
    }
  }

  function renderProgram(program) {
    if (!isAddress(program)) return;
    const a = $("program");
    a.setAttribute("href", EXPLORER + "address/" + program + "?cluster=devnet");
    a.setAttribute("title", program);
    a.textContent = short(program);
  }

  function announce(n) {
    state.pending += n;
    if (!state.pending || Date.now() - state.announced < ANNOUNCE_MS) return;
    $("announce").textContent = state.pending === 1 ? "1 new event" : state.pending + " new events";
    state.announced = Date.now();
    state.pending = 0;
  }

  function render(initial) {
    const feed = state.feed;
    renderStatus();
    if (!feed) return;
    renderProof(feed.latest_paid_job);
    renderNumbers(feed.stats);
    renderStream(feed, initial);
    announce(countNew(feed, initial));
    renderQuiet(feed);
    renderWorkers(feed.top_workers);
    renderServices(feed);
    renderProgram(feed.program);
  }

  function schedule() {
    clearTimeout(state.timer);
    state.timer = null;
    if (!state.paused) state.timer = setTimeout(poll, POLL_MS);
  }

  async function poll() {
    if (state.paused) return;
    const controller = new AbortController();
    state.controller = controller;
    try {
      const response = await fetch(FEED_URL, { signal: controller.signal, cache: "no-store", credentials: "omit", headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("feed answered " + response.status);
      const feed = await response.json();
      if (!feed || typeof feed !== "object" || Array.isArray(feed)) throw new Error("feed is not an object");
      if (state.paused || controller.signal.aborted) return;
      const initial = state.feed === null;
      state.feed = feed;
      state.failed = false;
      render(initial);
    } catch (error) {
      if (state.paused || controller.signal.aborted) return;
      state.failed = true;
      renderStatus();
      if (!state.feed) $("chain").replaceChildren(node("li", "chain-empty", "The feed did not answer; this card fills in on the next read."));
    } finally {
      if (state.controller === controller) state.controller = null;
      if (!state.paused) schedule();
    }
  }

  function setPaused(paused) {
    state.paused = paused;
    const button = $("pause");
    button.setAttribute("aria-pressed", String(paused));
    $("pause-label").textContent = paused ? "Resume" : "Pause";
    $("pause-glyph").setAttribute("d", paused ? "M5 3.25l7 4.75-7 4.75z" : "M5.5 3.5v9M10.5 3.5v9");
    clearTimeout(state.timer);
    clearInterval(state.ticker);
    state.timer = null;
    state.ticker = paused ? null : setInterval(tick, TICK_MS);
    if (paused && state.controller) state.controller.abort();
    renderStatus();
    if (!paused) poll();
  }

  async function copy(button) {
    const target = $(button.getAttribute("data-copy"));
    if (!target) return;
    const attr = button.getAttribute("data-copy-attr");
    const text = attr ? target.getAttribute(attr) : target.textContent;
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      return;
    }
    const label = button.querySelector(".copy-label");
    button.setAttribute("data-done", "");
    if (label) label.textContent = "Copied";
    setTimeout(() => {
      button.removeAttribute("data-done");
      if (label) label.textContent = "Copy";
    }, 2000);
  }

  function wireStream() {
    const stream = $("stream");
    stream.addEventListener("pointerenter", () => { state.pointer = true; });
    stream.addEventListener("pointerleave", () => { state.pointer = false; });
    stream.addEventListener("focusin", () => { state.focus = true; });
    stream.addEventListener("focusout", () => { state.focus = false; });
    $("queued").addEventListener("click", () => {
      if (!state.feed) return;
      const events = validEvents(state.feed);
      const fresh = new Set(events.filter((e) => !state.seen.has(eventKey(e))).map(eventKey));
      flushStream(events, fresh);
      stream.focus();
    });
  }

  function start() {
    document.documentElement.classList.add("js");
    $("status-text").replaceChildren("Reading /api/feed");
    $("pause").hidden = false;
    $("pause").addEventListener("click", () => setPaused(!state.paused));
    for (const button of document.querySelectorAll("[data-copy]")) {
      button.hidden = false;
      button.addEventListener("click", () => copy(button));
    }
    wireStream();
    state.ticker = setInterval(tick, TICK_MS);
    poll();
  }

  start();
})();
