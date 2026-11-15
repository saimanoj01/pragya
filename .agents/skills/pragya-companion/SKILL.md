---
name: pragya-companion
description: Agent-side companion skill for Pragya — reading tracker, Socratic reflection sparring partner, spoiler-safe cross-book recall, OCR quote backfill, idempotent Markdown export, and Google Docs Book Companion synchronization.
---

# Pragya Companion (`pragya-companion`)

**Pragya** separates calm standalone reading & capture (the Zero-AI PWA) from deep agent-assisted thinking (this skill). All state lives in the user's own Google Sheet (**`Pragya Commonplace`**) and Google Drive folder (**`Pragya Media`**), or in an offline **`PragyaSnapshot` v1 JSON** file (`--state-file`).

> [!IMPORTANT]
> - **Hard Stage 2 Blocking Wait (`REFLECT`):** When running `reflect --stage 1`, ALWAYS stop immediately after printing the two Socratic questions and wait for the user's reply. NEVER auto-answer your own questions or run `--stage commit` in the same turn.
> - **Spoiler-Safe Fiction Clamping:** Never inspect, quote, or surface any fiction note whose `normalizedPos > book.normalizedPos` (or `pos > book.currentPos` when `totalPos` is unknown) unless the book is `finished`.
> - **Active Behavioral Delta Cap (`<= 5`):** Never activate more than 5 concurrent `deltaStatus == "active"` notes.
> - **UUID-Resolved Sheet Writes:** Always resolve row indices via `<Tab>!A:A` at write time and use `gsheets mutate batch` with `"data": [[...]]` (never `"values"`).
> - **Clean `WHEN` / `DO` Formatting:** Store normalized trigger/action bodies without `WHEN`/`DO` prefixes, and render at most one `WHEN` / `DO` prefix.

---

## CLI Entrypoint

Both paths work identically from any working directory:

```bash
python3 scripts/pragya_cli.py --help
python3 .agents/skills/pragya-companion/scripts/pragya_cli.py --help
```

- **Live Google Workspace mode (default):** Discovers or creates **`Pragya Commonplace`** (`Books!A:L`, `Notes!A:R`, `Sessions!A:G`, `DeltaLogs!A:E`) and **`Pragya Media`** via `gsheets`, `gdrive`, and `gdocs` CLIs. Optionally pass `--spreadsheet-id <ID>`.
- **Snapshot JSON mode (`--state-file <path.json>`):** Operates atomically on any exported `PragyaSnapshot` v1 JSON file (`Settings -> Export JSON Snapshot` or `Practice -> Export JSON`).

---

## Companion Workflows

### 1. `CAPTURE` — Voice-to-Sheet Note Capture & Bookmark Advance

Capture a quote, personal takeaway, tags, prediction flag, Google Doc/link URL, or photo attachment (`<= 3` attachments max). Sets `source = "agent"`, advances the book's monotonic `Math.max` bookmark (unless `--force-pos`), and coalesces `Sessions` within 30 minutes for the same book and local date.

```bash
# Live Google Workspace capture with photo & spar flag
python3 scripts/pragya_cli.py capture \
  --book "Thinking in Systems" \
  --pos 156 \
  --quote "A delay in a balancing loop can cause oscillation." \
  --takeaway "Wait one feedback cycle before changing alerts." \
  --tags "#systems, #delays" \
  --image ./page-photo.webp \
  --spar

# Offline snapshot capture
python3 scripts/pragya_cli.py --state-file pragya-backup.json capture \
  --book "book-exhalation" \
  --pos 180 \
  --takeaway "Prediction: the narrator discovers the inscription is reversible." \
  --prediction
```

### 2. `REFLECT` — 4-Stage Socratic Sparring (`--stage 1` -> WAIT -> `--stage commit`)

Never generate all 4 stages in one shot:

1. **Stage 1 (`--stage 1`):** Reads the note and its book's `kind` (`nonfiction` vs `fiction`, strictly clamped to `<= book.normalizedPos`), writes `status = "in-reflection"` and `meta.socraticQuestions = [q1, q2]`, and prints the 2 questions.
2. **Stage 2 (HARD BLOCKING WAIT):** Present `q1` and `q2` to the user and **end your turn**. Wait for the user's written or voice-dictated reply.
3. **Stage 3 & 4 (`--stage commit`):** Distill the user's reply into Layer 2 fields (`--title`, `--slug`, `--takeaway`, `--context`, `--critique`, `--trigger`, `--action`, `--delta-status`), enforce the `<= 5` active delta cap, normalize `WHEN`/`DO`, and upgrade the note to `status = "atomic"`.

```bash
# Stage 1: Persist Socratic prompts and pause for user reply
python3 scripts/pragya_cli.py reflect --note memory-prism-digital-remembrance --stage 1

# --- WAIT FOR USER REPLY BEFORE RUNNING STAGE COMMIT ---

# Stage 3+4: Commit atomic note (aborts if >= 5 active deltas already exist)
python3 scripts/pragya_cli.py reflect \
  --note memory-prism-digital-remembrance \
  --stage commit \
  --title "Reconstructive Memory vs Archival Fidelity" \
  --slug "reconstructive-memory-fidelity" \
  --takeaway "Human forgiveness relies on selective reconstruction rather than verbatim replay." \
  --context "Chiang contrasts lived narrative integration against literal digital playback." \
  --critique "Fails in forensic, audit, or medical domains where exact logs are mandatory." \
  --trigger "revisiting an old disagreement with strong certainty" \
  --action "ask whether I am defending literal recall or narrative fairness" \
  --delta-status active
```

### 3. `RECALL` — Spoiler-Safe Q&A, Delta Check-In & Takeaway Shuffle

Three modes under `recall`:

```bash
# Spoiler-safe cross-book Q&A (automatically excludes fiction notes > book.normalizedPos)
python3 scripts/pragya_cli.py recall --mode qa --query "feedback delays"

# List active Behavioral Deltas (N/5)
python3 scripts/pragya_cli.py recall --mode checkin

# Log a Behavioral Delta outcome (and optionally refine WHEN trigger on missed)
python3 scripts/pragya_cli.py recall --mode checkin \
  --note delays-in-feedback-loops \
  --outcome missed \
  --trigger "deploy dashboard shows a transient spike" \
  --reflection "Reacted within 10 minutes instead of waiting."

# Deterministic daily Takeaway Shuffle (or mark a candidate reviewed today)
python3 scripts/pragya_cli.py recall --mode shuffle --limit 3
python3 scripts/pragya_cli.py recall --mode shuffle --mark-reviewed playing-with-boundaries
```

### 4. `ocr-backfill` — Lazy OCR Backfill for Image Notes

Scans notes that have at least one `image` attachment, an empty `quote`, and `meta.ocrBackfilled != true`. Fetches the image (from Drive via `gdrive readonly download` or local state path), applies text from `--ocr-map-json`, `--ocr-text`, or `--ocr-cmd`, populates `quote`, and sets `meta.ocrBackfilled = true`.

```bash
python3 scripts/pragya_cli.py ocr-backfill --ocr-map-json ./ocr_results.json
python3 scripts/pragya_cli.py ocr-backfill --note visual-diagram --ocr-text "Extracted quote..."
python3 scripts/pragya_cli.py ocr-backfill --ocr-cmd "tesseract {path} stdout"
```

### 5. `export-md` — Idempotent 1-Way Markdown Export

Exports ONLY `status == "atomic"` notes where `!meta.exportedAt || updatedAt > exportedAt` to `<output_dir>/<slug>.md` with YAML frontmatter, single `WHEN`/`DO` delta formatting, attachments, and `[[wikilinks]]`. Stamps `meta.exportedAt` **without bumping `updatedAt`** only after the disk write succeeds, so running `export-md` twice in a row exports 0 files on the second run.

```bash
python3 scripts/pragya_cli.py export-md --output-dir ./reading-notes
```

### 6. `book-doc-sync` — Idempotent Book Companion Google Doc Sync

Creates ONE `"Pragya · <Book Title>"` Google Doc (recording `docUrl` in `Books!K`) if `book.docUrl` is empty, or reuses the existing Doc ID and appends only unsynced `atomic` notes ordered by `pos` (checking `[note:<id>]` markers so re-running never creates duplicate Docs or duplicate note entries).

```bash
python3 scripts/pragya_cli.py book-doc-sync --book "Thinking in Systems"
python3 scripts/pragya_cli.py --state-file state.json book-doc-sync --book book-systems --doc-out ./systems-companion.md
```
