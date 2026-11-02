(() => {
  const $ = (id) => document.getElementById(id);
  const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const BAD_ADDRESS = "The address is not a valid base58 Solana address, so copy it again from your wallet.";
  const UNREACHED = "The faucet did not answer. Check your connection and try again in a minute.";
  const WAITING = "Sending. This takes up to a minute.";
  const GIVE_UP_MS = 65000;
  const LAMPORTS = 1000000000n;
  const EXPLORER = "https://explorer.solana.com/address/";

  const form = $("drip");
  const input = $("address");
  const send = $("send");
  const result = $("result");
  const line = $("explorer-line");
  const link = $("explorer");

  function say(text, tone) {
    result.textContent = text;
    result.setAttribute("data-tone", tone);
    result.hidden = false;
  }

  function sol(lamports) {
    if (typeof lamports !== "string" || !/^[0-9]{1,18}$/.test(lamports)) return null;
    const whole = BigInt(lamports) / LAMPORTS;
    const fraction = (BigInt(lamports) % LAMPORTS).toString().padStart(9, "0").replace(/0+$/, "");
    return fraction === "" ? whole.toString() : whole.toString() + "." + fraction;
  }

  function wait(seconds) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "";
    if (seconds < 3600) return " Try again in about " + Math.ceil(seconds / 60) + " min.";
    return " Try again in about " + Math.ceil(seconds / 3600) + " h.";
  }

  function show(address) {
    link.setAttribute("href", EXPLORER + address + "?cluster=devnet");
    line.hidden = false;
  }

  async function drip(address) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GIVE_UP_MS);
    try {
      const response = await fetch("/api/drip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
        cache: "no-store",
        signal: controller.signal,
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (response.ok && body && typeof body === "object" && sol(body.lamports) !== null) {
        say("Sent " + sol(body.lamports) + " SOL to " + address + ".", "ok");
        show(address);
        return;
      }
      const reason = body && typeof body === "object" && typeof body.error === "string" ? body.error : "The faucet answered with status " + response.status + ".";
      say(reason + wait(body && typeof body === "object" ? body.retry_after : undefined), "error");
      show(address);
    } catch {
      say(UNREACHED, "error");
    } finally {
      clearTimeout(timer);
    }
  }

  async function submit(event) {
    event.preventDefault();
    const address = String(input.value).trim();
    line.hidden = true;
    if (!ADDRESS.test(address)) {
      say(BAD_ADDRESS, "error");
      return;
    }
    send.disabled = true;
    say(WAITING, "pending");
    await drip(address);
    send.disabled = false;
  }

  async function copy(button) {
    const target = $(button.getAttribute("data-copy"));
    if (!target) return;
    const label = button.querySelector(".copy-label");
    try {
      await navigator.clipboard.writeText(target.textContent);
      button.setAttribute("data-done", "");
      if (label) label.textContent = "Copied";
    } catch {
      if (label) label.textContent = "Select and copy";
    }
    setTimeout(() => {
      button.removeAttribute("data-done");
      if (label) label.textContent = "Copy";
    }, 2000);
  }

  if (form && input && send && result && line && link) form.addEventListener("submit", submit);
  if (navigator.clipboard) {
    for (const button of document.querySelectorAll("[data-copy]")) {
      button.hidden = false;
      button.addEventListener("click", () => copy(button));
    }
  }
})();
