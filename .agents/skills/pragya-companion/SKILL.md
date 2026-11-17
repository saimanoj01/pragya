---
name: pragya-companion
description: Agent-side companion skill for Pragya — reading tracker, Socratic reflection sparring partner, spoiler-safe cross-book recall, OCR quote backfill, idempotent Markdown export, and Google Docs Book Companion synchronization.
---

# Pragya Companion (`pragya-companion`)

**Pragya** pairs a calm, zero-AI PWA (`Books!A:L`, `Notes!A:R`, `Sessions!A:G`, `DeltaLogs!A:E` in Google Sheet **`Pragya Commonplace`** + **`Pragya Media/`** on Drive) with this conversational voice/text companion skill.

> [!IMPORTANT]
> - **Hard Stage 2 Blocking Wait (`REFLECT`):** When running `reflect --stage 1`, ALWAYS stop after presenting the two Socratic questions and wait for the user's reply. NEVER auto-answer your own questions or run `--stage commit` in the same turn.
> - **Voice-Fidelity & Anti-Slop Contract:** Keep `takeaway`, `quote`, and `reflection` faithful to the user's actual phrasing and insight. Never rewrite casual spoken thoughts into stiff corporate prose, invent unstated takeaways, or force artificial `WHEN -> DO` deltas onto memoir, history, biography, or fiction.
> - **Spoiler-Safe Fiction Ceiling:** Never inspect, quote, or volunteer plot points/twists (including from your own parametric book knowledge) beyond `book.currentPos` / `book.normalizedPos` unless `book.status == "finished"`.
> - **Active Behavioral Delta Cap (`<= 5`):** Never activate more than 5 concurrent `deltaStatus == "active"` notes across all books.
> - **UUID-Resolved Sheet Writes & Clean `WHEN`/`DO`:** Always resolve row indices via `<Tab>!A:A` at write time; store `deltaTrigger`/`deltaAction` without `WHEN`/`DO` prefixes and render at most one prefix.

---

## Dual-Mode Execution

### Mode A — Standalone Skill CLI (Default)

Run the self-contained Python 3 stdlib CLI bundled inside this skill directory (`scripts/pragya_cli.py`, no external dependencies):

```bash
# Relative to this skill directory (works standalone even outside repo root)
python3 scripts/pragya_cli.py --help
# Or offline against an exported PragyaSnapshot v1 JSON file
python3 scripts/pragya_cli.py --state-file pragya-backup.json book-list
```

- **Live Workspace mode (default):** Discovers or creates **`Pragya Commonplace`** and **`Pragya Media/`** via `gsheets`, `gdrive`, and `gdocs` CLIs (`--spreadsheet-id <ID>` optional).
- **Snapshot JSON mode (`--state-file <path.json>`):** Operates atomically on any `PragyaSnapshot` v1 JSON export.

### Mode B — Native Google Workspace / MCP Fallback (Gemini Spark)

If `gsheets`, `gdrive`, or `gdocs` binaries are missing from `PATH` (`pragya_cli.py` exits cleanly with `CliError` instructing Mode B fallback):
1. Consult [`references/schema_and_ops.md`](references/schema_and_ops.md) for the exact 4-tab column layouts (`Books!A:L`, `Notes!A:R`, `Sessions!A:G`, `DeltaLogs!A:E`), normalized position math, UUID `A:A` lookup, and 30-min session coalescing rules.
2. Read/write directly via your native Google Sheets / Drive / Docs connector.
3. **Offline / Disconnected Degradation Tier:** If neither Mode A CLIs nor Mode B Workspace connectors are reachable (or offline), offer `--state-file` snapshot editing or output a structured **Paste Card** for the PWA — never pretend a remote write succeeded.

---

## 5-Way Conversation Routing

Route natural voice or text turns cleanly to the matching workflow:

### 1. Shelf & Reading Progress (`book-list`, `book-add`, `book-update`, `progress`)

```bash
# List shelf + active delta count (N/5)
python3 scripts/pragya_cli.py book-list --status reading

# Add a new book (percent unit defaults totalPos=100; no synthetic session created)
python3 scripts/pragya_cli.py book-add \
  --title "The Creative Act" --author "Rick Rubin" --kind nonfiction --format kindle --pos-unit percent

# Advance reading progress (+delta, exact --pos, or --finish; coalesces 30-min sessions)
python3 scripts/pragya_cli.py progress --book "Thinking in Systems" --delta 18 --session-note "Feedback delays ch. 2"
python3 scripts/pragya_cli.py progress --book "Exhalation" --finish

# Update metadata or status (returns unlockedPredictionsCount when finishing fiction)
python3 scripts/pragya_cli.py book-update --book "book-exhalation" --status finished
```

### 2. Quick or Conversation-First Deep Capture (`capture`)

- `--pos` is optional (defaults to `book.currentPos` without creating a synthetic session).
- Use `--spar` for `"inbox"` (spar later), default for `"saved"`, or `--atomic` ONLY when the user has already discussed and articulated Layer 2 fields live in conversation.

```bash
# Quick capture with photo & spar flag
python3 scripts/pragya_cli.py capture \
  --book "Thinking in Systems" \
  --pos 156 \
  --quote "A delay in a balancing loop can cause oscillation." \
  --takeaway "Wait out natural lag before changing rules." \
  --tags "#systems, #delays" \
  --image ./page-photo.webp \
  --spar

# Conversation-first atomic capture (all validations & <=5 delta cap run BEFORE image upload)
python3 scripts/pragya_cli.py capture \
  --book "Thinking in Systems" \
  --title "Respecting Feedback Lags" \
  --takeaway "Aggressive tuning during lag creates whiplash." \
  --context "Information lag causes corrective controllers to overshoot." \
  --critique "Fails during runaway exponential failures where delay is fatal." \
  --trigger "metrics dip right after a deploy" \
  --action "wait one full observation cycle before tuning" \
  --delta-status active \
  --atomic
```

### 3. Socratic Reflection Sparring (`reflect --stage 1` -> WAIT -> `--stage commit`)

```bash
# Stage 1: Persist Socratic prompts (optional custom --q1/--q2 overrides) and STOP
python3 scripts/pragya_cli.py reflect \
  --note delays-in-feedback-loops \
  --stage 1 \
  --q1 "Where did you react too fast to noisy metrics recently?" \
  --q2 "When would waiting a full cycle actually make a failure worse?"

# --- WAIT FOR USER REPLY BEFORE RUNNING STAGE COMMIT ---

# Stage 3+4: Commit user's distilled Layer 2 insights -> status = "atomic"
python3 scripts/pragya_cli.py reflect \
  --note delays-in-feedback-loops \
  --stage commit \
  --title "Respecting Feedback Lags" \
  --takeaway "Wait out system lag before tuning parameters." \
  --context "Corrective loops with response lag amplify oscillations." \
  --critique "Unsafe during runaway cascades or safety emergencies." \
  --trigger "alert spikes right after deploy" \
  --action "wait one full cycle before adjusting thresholds" \
  --delta-status active
```

### 4. Spoiler-Safe Recall, Check-In & Takeaway Shuffle (`recall`)

```bash
# Spoiler-safe cross-book Q&A (clamps fiction notes > book.currentPos)
python3 scripts/pragya_cli.py recall --mode qa --query "feedback delays"

# List active Behavioral Deltas (N/5) or log 1/2/3 check-in
python3 scripts/pragya_cli.py recall --mode checkin
python3 scripts/pragya_cli.py recall --mode checkin \
  --note delays-in-feedback-loops --outcome missed \
  --trigger "dashboard latency spikes post-deploy" \
  --reflection "Tweaked TTL within 5 minutes."

# Deterministic daily Takeaway Shuffle + mark reviewed (preserves updatedAt)
python3 scripts/pragya_cli.py recall --mode shuffle --limit 3
python3 scripts/pragya_cli.py recall --mode shuffle --mark-reviewed delays-in-feedback-loops
```

### 5. Media Transcription, Markdown Export & Companion Docs (`ocr-backfill`, `export-md`, `book-doc-sync`)

```bash
python3 scripts/pragya_cli.py ocr-backfill --ocr-cmd "tesseract {path} stdout"
python3 scripts/pragya_cli.py export-md --output-dir ./reading-notes
python3 scripts/pragya_cli.py book-doc-sync --book "Thinking in Systems"
```

---

## Mobile & Safety Hygiene Checklist

- **Unit Mismatch Guard:** Before logging `progress` or `capture --pos`, check `book.posUnit` (`page` vs `percent` vs `loc`). If the user says `"45%"` on a `page`-tracked book, confirm or convert (`0.45 * totalPos`) rather than writing `45` as page 45.
- **Backward Bookmark Guard:** `progress` and `book-update` reject lowering `currentPos` unless `--force-pos` is explicitly confirmed by the user. (`capture --pos` on an earlier page logs the note cleanly at that page without lowering the book bookmark.)
- **Attachment & Image Hygiene:** Enforce `<= 3` attachments per note before uploading. When a user uploads a mobile camera photo (HEIC/JPEG), convert/compress to `<= 1600px` `.webp` when tooling permits, and use multimodal vision OCR to populate `quote` cleanly (or run `ocr-backfill`).
- **Google Docs Formatting:** `book-doc-sync` writes native Google Docs headings (`HEADING_1`/`HEADING_2`) via `gdocs mutate batch` and deduplicates by `[note:<uuid>]` markers so re-runs never duplicate Docs or entries.
