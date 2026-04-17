# Prospect · Product Hunt Daily

This repo powers a daily Product Hunt digest. Raw data collection is a
GitHub Actions job; the analysis and write-up happen inside a Claude Code
routine (see `prompts/daily-digest.md`).

## Layout

- `scraper.js` — GraphQL scraper (run by `.github/workflows/daily-scrape.yml`).
  Writes `data/YYYY/YYYY-MM-DD.json` (PT day). **Do not invoke from the
  routine**; CI owns this step.
- `scripts/process_daily.js` — pure local transform. Reads the raw data file
  for a PT date, runs layered dedup (see below), writes `state/today.json`,
  and appends to `state/seen.jsonl` + `state/runs.jsonl`.
- `data/YYYY/` — raw daily snapshots. Append-only in practice. Never hand-edit.
- `state/`
  - `today.json` — latest processed snapshot, rewritten each run
    (**gitignored**; derived from `data/` + `seen.jsonl`)
  - `seen.jsonl` — append-only log of per-post sightings; commit after each run
  - `runs.jsonl` — append-only log of process runs; commit after each run
- `reports/YYYY-MM-DD.md` — the curated daily digest, written by the routine.
- `prompts/daily-digest.md` — the canonical routine prompt (paste into the
  routine form as-is).

## Dedup semantics (what `process_daily.js` classifies)

- `new_launches` — post.id and slug both never seen before. Main analysis target.
- `relaunches` — post.id is new, but the slug matches a historical sighting
  (PH allows the same product to relaunch with a fresh id). Each entry carries
  a `_relaunch_of` object with `firstSeen` date and `priorLaunches` metadata.
- `skipped` — post.id already recorded in `state/seen.jsonl`. Happens when
  processing the same date twice or a neighboring scrape caught a post that
  ours re-fetched.
- `intraDayDupes` — pagination artifacts (PH orders by votes; vote shifts
  mid-scrape can repeat records across pages). Collapsed to one record each
  (the higher-voted snapshot wins).

Layer 3 (semantic / "effectively duplicate products" across different slugs)
is intentionally **not** implemented. Revisit once we have a few weeks of
real data and can judge whether the noise justifies embedding lookups.

## Commands the routine may run

- `npm run process` — process yesterday (PT). Safe to rerun: if the date is
  already in `runs.jsonl`, it prints `already ran` and exits 0 without
  touching state.
- `npm run process -- --date YYYY-MM-DD` — target a specific PT date.
- `npm run process -- --force` — reprocess a date (rewrites `state/today.json`
  and appends a rerun record; does **not** duplicate `seen.jsonl` lines).

Exit codes:
- `0` — processed (or `already ran`)
- `1` — unexpected runtime error
- `2` — raw data file for that PT date is missing (CI hasn't landed yet)

## Analysis focus (defaults; override in the routine prompt if needed)

Priority topics:
- AI agents, assistants, multi-agent orchestration
- Developer tools, CLIs, terminals, IDEs
- Local-first / on-device inference / privacy-preserving tooling
- Novel I/O modalities (voice, spatial, keyboard-first, hardware)

Actively filter out:
- Thin "ChatGPT for X" / "AI-powered X" wrappers with no engineering signal
- Crypto / NFT / web3 speculation, gambling
- Pure marketing / SEO / generic SaaS with no product differentiation

## Execution principles for the routine

- **Do not re-implement scraping or dedup.** Use `scraper.js` (via CI) and
  `scripts/process_daily.js`. If something looks broken, fix the script —
  don't inline replacement logic in the prompt.
- **`state/seen.jsonl` and `state/runs.jsonl` are append-only.** Never rewrite
  them; the script handles appends correctly.
- **Analysis is judgement, not restatement.** If you can't say what a product
  is actually new at, it doesn't belong in Top N.
- **Fail loudly.** If `state/today.json` is missing or stale, or the raw data
  file for the target PT date isn't in `data/`, stop and report the error
  rather than fabricating a digest.
- **Don't re-run the scraper from the routine.** CI owns fetching. If today's
  raw file is missing, that's a CI problem, not a routine problem.
