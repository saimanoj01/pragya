# Pragya

**Pragya** is a calm, monochrome commonplace book, reading tracker, and deliberate-practice companion built on a **Two-Brain Architecture**:

1. **Standalone Zero-AI PWA (`src/`)** — Fast, offline-tolerant React web app backed directly by your own Google Sheet (`Pragya Commonplace`) and Google Drive folder (`Pragya Media/`), or a full local **Demo Mode** (`localStorage` + `IndexedDB`). Zero LLM API calls, zero server backend, and zero custom voice recording UI.
2. **Optional `pragya-companion` Skill (`.agents/skills/pragya-companion/` + `scripts/pragya_cli.py`)** — Agent-assisted Socratic reflection, spoiler-safe cross-book Q&A, OCR quote backfill, idempotent Markdown export, and Book Companion Google Doc sync via Google Workspace CLIs (`gsheets`, `gdrive`, `gdocs`) or `--state-file` JSON snapshots.

---

## Core Features

- **Shelf & Reading Sessions (`#/shelf`, `#/book/:id`)**
  - Reading, Queued, Paused, and Finished books across `physical` / `kindle` and `nonfiction` / `fiction`.
  - Monotonic `Math.max` bookmark advancement (`+10p` or exact input) with explicit Manual Override checkbox for backward resets.
  - 30-minute Reading Session coalescing for same book and local date, visualized in a 30-day activity strip.
- **Instant Capture & Private Media (`QuickCaptureModal`)**
  - Capture quotes, takeaways, `#tags`, `Spar later` (`inbox`) flags, and Fiction Predictions (`sealed` until book is finished).
  - Attach up to 3 items per note: client-side WebP-compressed photos (`<= 1600px`, stored in `Pragya Media/` on Drive or `IndexedDB` in Demo Mode, cached via Cache API `pragya-media-v1`), Google Docs (with auto-resolved titles), or external links.
- **Spoiler Shield & `[[Wikilink]]` Knowledge Graph (`#/notes`, `#/note/:slug`)**
  - Normalized spoiler clamping (`0.0–1.0`) masks notes ahead of your current reading position until clicked or revealed with `Space`.
  - Bidirectional `[[wikilink]]` autocomplete, clickable concept chips, and automatic self-excluding backlinks.
  - Socratic Recovery Banner for `in-reflection` notes with saved prompts and one-click `Deepen (D)`.
- **Behavioral Deltas & Takeaway Shuffle (`#/practice`)**
  - Strictly capped **Active Behavioral Deltas (`<= 5/5`)** with `WHEN` / `DO` normalization, `1` Applied / `2` Missed Trigger (inline trigger editor) / `3` Didn't Come Up check-ins, and Graduate / Pause / Reactivate lifecycle.
  - Deterministic daily **Takeaway Shuffle** (notes aged `>= 14` days or `#favorite`, excluding spoilers, sealed predictions, and notes reviewed today).
  - Portable **JSON Snapshot Export & Import** (`version: 1`) with schema validation and preview modal.

---

## Tech Stack & Local Development

- **Frontend:** React 18, TypeScript, Vite 5, Tailwind CSS, Lucide Icons, Framer Motion
- **Storage:** Google Sheets API v4 (`Books!A:L`, `Notes!A:R`, `Sessions!A:G`, `DeltaLogs!A:E`), Google Drive API v3 (`Pragya Media/`), Demo Mode (`localStorage` + `IndexedDB`)
- **Companion CLI:** Python 3.11+ standard library only (`scripts/pragya_cli.py`)

```bash
# Install dependencies
npm ci

# Start local dev server
npm run dev

# Production build (GitHub Pages base path)
VITE_BASE_PATH='/pragya/' npm run build
```

---

## Google OAuth 2.0 & Workspace Setup

1. Create a Google Cloud Project and enable the **Google Sheets API** and **Google Drive API**.
2. Configure an OAuth 2.0 Web Client ID with your origins (e.g. `http://localhost:3000`, `https://<username>.github.io`) and redirect URIs (`http://localhost:3000`, `https://<username>.github.io/pragya/`).
3. Requested scopes:
   - `https://www.googleapis.com/auth/drive.readonly`
   - `https://www.googleapis.com/auth/drive.file`
   - `https://www.googleapis.com/auth/spreadsheets`
   - `email`
   - `profile`
4. Set `VITE_GOOGLE_CLIENT_ID` in `.env.local` (or enter it in the Settings / Login screen runtime override persisted to `pragya_google_client_id`).

---

## Keyboard Shortcuts

| Shortcut | Scope | Action |
| :--- | :--- | :--- |
| `Cmd/Ctrl + K` | Global | Toggle Command Palette |
| `N` | Global | Open Quick Capture modal |
| `G` then `S` / `N` / `P` | Global | Navigate to Shelf / Notes / Practice |
| `R` | Global | Sync workspace now |
| `J` / `K` | Notes, Book Detail, Practice | Move card selection down / up |
| `Space` | Notes, Book Detail, Note Detail | Reveal Spoiler Shield or toggle Image Lightbox |
| `Enter` | Notes, Book Detail, Practice | Open selected item |
| `D` / `E` / `O` | Notes, Note Detail, Book Detail | Deepen (`D`), Edit (`E`), Open external Doc/link (`O`) |
| `1` / `2` / `3` | Practice (focused delta) | Log Applied (`1`), Missed Trigger (`2`), Didn't Come Up (`3`) |
| `Escape` | Layered | Close top popover → lightbox → modal → return from detail view |

---

## `pragya-companion` CLI Examples

Works standalone via either `scripts/pragya_cli.py` or `.agents/skills/pragya-companion/scripts/pragya_cli.py` against live Google Workspace (`gsheets`/`gdrive`/`gdocs`) or offline via `--state-file <snapshot.json>` (with Mode B schema fallback in `.agents/skills/pragya-companion/references/schema_and_ops.md`):

```bash
# 0. Shelf & reading progress primitives
python3 scripts/pragya_cli.py --state-file pragya.json book-list --status reading
python3 scripts/pragya_cli.py --state-file pragya.json book-add \
  --title "The Creative Act" --author "Rick Rubin" --format kindle --pos-unit percent
python3 scripts/pragya_cli.py --state-file pragya.json book-update --book "book-exhalation" --status finished
python3 scripts/pragya_cli.py --state-file pragya.json progress --book "book-systems" --delta 15 --session-note "Ch. 3"

# 1. Capture note (quick inbox, or direct conversation-first --atomic capture)
python3 scripts/pragya_cli.py --state-file pragya.json capture \
  --book "book-systems" --pos 155 --takeaway "Wait out feedback delays." --tags "#systems" --spar
python3 scripts/pragya_cli.py --state-file pragya.json capture \
  --book "book-systems" --title "Respecting Lag" --takeaway "Wait one cycle before tuning." \
  --context "Delayed loops overshoot." --critique "Unsafe for runaway failures." \
  --trigger "alert fires right after deploy" --action "wait one cycle" --delta-status active --atomic

# 2. 4-stage Socratic reflection (Stage 1 with optional --q1/--q2 -> wait for reply -> Stage commit)
python3 scripts/pragya_cli.py --state-file pragya.json reflect --note delays-in-feedback-loops --stage 1
python3 scripts/pragya_cli.py --state-file pragya.json reflect --note delays-in-feedback-loops --stage commit \
  --context "Delay amplification" --critique "Fails in runaway crises" \
  --trigger "deploy metrics dip" --action "wait 24h before tuning" --delta-status active

# 3. Spoiler-safe recall, check-in, and daily shuffle
python3 scripts/pragya_cli.py --state-file pragya.json recall --mode qa --query "feedback"
python3 scripts/pragya_cli.py --state-file pragya.json recall --mode checkin --note delays-in-feedback-loops --outcome applied
python3 scripts/pragya_cli.py --state-file pragya.json recall --mode shuffle --limit 3

# 4. Lazy OCR quote backfill
python3 scripts/pragya_cli.py --state-file pragya.json ocr-backfill --ocr-map-json ocr_map.json

# 5. Idempotent Markdown export
python3 scripts/pragya_cli.py --state-file pragya.json export-md --output-dir ./reading-notes

# 6. Book Companion Google Doc sync
python3 scripts/pragya_cli.py --state-file pragya.json book-doc-sync --book book-systems
```

> **Companion Doc tip:** `book-doc-sync` updates only Pragya's own marker blocks (`[note:…]` / `[capstone:…]`) in place and leaves everything else untouched. When you add your own notes under a Pragya entry in the Doc, leave a **blank line** first so they are never mistaken for a Pragya field line. Text you type after a `[note:…]` marker in a heading is kept.

---

## Release gates

The CLI's write transports — `gsheets mutate raw-batch` (Sheets) and `gdocs mutate raw-batch` (in-place Docs edits) — can't be verified offline. **Before real CLI use (or merging to `main`), run the opt-in live probes** on a machine with authenticated `gsheets` / `gdrive` / `gdocs`:

```bash
PRAGYA_RUN_LIVE_INTEGRATION=1 python3 -m unittest tests/integration/test_live_workspace.py -v
```

- **Sheets:** `test_live_raw_batch_probe_round_trips_exact_values` checks a `gsheets mutate raw-batch` round-trip: formula-, percent-, bullet- and date-like strings come back verbatim, and the header row stays exact.
- **Docs:** `test_live_gdocs_raw_batch_in_place_probe` checks an in-place `gdocs mutate raw-batch` edit (upgrade + backfill, with prose preserved). `test_live_gdocs_write_control_rejects_stale_revision` is **mandatory**: a request with a stale `writeControl.requiredRevisionId` must be rejected and leave the Doc unchanged.
- Every probe creates its own **scratch** spreadsheet / Doc / Drive files and **trashes them automatically** in `finally`. Nothing touches your real `Pragya Commonplace` Sheet or Companion Docs.
- Without `PRAGYA_RUN_LIVE_INTEGRATION=1` the suite is skipped. If a probe fails, don't use the CLI against real data. There's no legacy `gsheets mutate batch` fallback for Sheet writes: it would reintroduce `USER_ENTERED` coercion.

---

## Testing & Verification

```bash
# TypeScript + ESLint strict check
npm run build
npm run lint

# TypeScript domain unit tests
npm run test:unit

# Python companion CLI unit tests
python3 -m unittest discover -s tests/unit

# Playwright end-to-end tests
npm run test:e2e
```

---

## GitHub Pages Deployment

Push to `main` to trigger `.github/workflows/deploy.yml`, which builds with `VITE_BASE_PATH='/pragya/'` and `VITE_GOOGLE_CLIENT_ID` from repository secrets (`Settings -> Secrets and variables -> Actions`) and deploys `./dist` to GitHub Pages.
