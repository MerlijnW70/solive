# Job: The live page of the agent economy on devnet

Build the page half of Solive Live, the first thing invited testers see. The bar is world-class, hand-made UI and UX, explicitly no generic AI look. The research behind it is `docs/maintainers/live-page.md` in this commit: read it first. Its sections "Content of the page, in order", "Trust rules", "Design direction" (type, colour tokens, spacing and grid, motion, icons, accessibility of the stream), "No-slop checklist" and "Changes to the draft specs" (the part for `live-site`) are part of this spec.

## Contract

The page reads `/api/feed`, whose shape is item 1 of "Changes to the draft specs" for `live-feed` in that page.

## Headline

The owner chose headline option 1: "Agents hire agents here, and get paid only when a judge passes the work." with the sentence "Every row below is a devnet transaction: an escrow locked for a pinned spec, a delivery, a judge's release that pays."

## Build

1. Static files in a `public/` folder of a new package named live under `services/`: `index.html`, CSS, one small script, the self-hosted subset WOFF2 fonts the design names (with their licence file), and inline SVG icons drawn for this page. No framework, no build step, no external request, no tracker.
2. The ten sections in the order "Content of the page, in order" gives, with the chosen headline and the README's install lines (Claude Code, Codex, and the Windows PowerShell form), each with a copy button.
3. Every rule in "Design direction", every item in items 5 and 6 of "Changes to the draft specs" for `live-site` (quiet and stale states, pause, the stream's accessibility, reduced motion, scripts-off rendering, the content security policy in `vercel.json`, explorer links only to devnet, short addresses).
4. A fixture feed (full, empty, quiet, stale, with house rows) so the page can be checked without devnet.

## Tests

Every test in item 8 of "Changes to the draft specs" for `live-site`, plus: values from the feed are inserted as text, never as HTML, and the try-it lines match the README.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. The page passes every item of the "No-slop checklist" in `docs/maintainers/live-page.md`, judged from screenshots in light, dark and at 360 px, which the report includes as files in the job directory.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Keep files under about 500 lines. The product name comes from `identity.toml`, never hard-coded.
- Devnet only. No key, no signing, nothing sent: the feed only reads. Public devnet rate-limits one IP and other services on this machine share it: keep live reads during development few and spaced out.
- Another worker builds the other half in parallel against the same contract; touch only the files this spec names.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
