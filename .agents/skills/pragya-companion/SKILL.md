---
name: pragya-companion
description: Agent-side companion skill for Pragya — reading tracker, curiosity anchors & Reading Questions, Socratic reflection sparring partner, spoiler-safe re-entry recaps & cross-book recall, atomic cross-book note bridges, Sunday Commonplace Salon & proactive Spark task rituals, OCR quote backfill, idempotent Markdown export, and Google Docs Book Companion synchronization.
---

# Pragya Companion (`pragya-companion`)

**Pragya** pairs a calm, zero-AI PWA (`Books!A:L`, `Notes!A:R`, `Sessions!A:G`, `DeltaLogs!A:E` in Google Sheet **`Pragya Commonplace`** + **`Pragya Media/`** on Drive) with this conversational voice/text companion skill.

> [!IMPORTANT]
> - **Hard Stage 2 Blocking Wait (`REFLECT`):** When running `reflect --stage 1`, ALWAYS stop after presenting the two Socratic questions and wait for the user's reply. NEVER auto-answer your own questions or run `--stage commit` in the same turn.
> - **Voice-Fidelity & Anti-Slop Contract:** Keep `takeaway`, `quote`, and `reflection` faithful to the user's actual phrasing and insight. Never rewrite casual spoken thoughts into stiff corporate prose, invent unstated takeaways, or force artificial `WHEN -> DO` deltas onto memoir, history, biography, or fiction.
> - **Spoiler-Safe Fiction Ceiling:** Never inspect, quote, or volunteer plot points/twists (including from your own parametric book knowledge) beyond `book.currentPos` / `book.normalizedPos` unless `book.status == "finished"` or `book.meta.everFinished == true`.
> - **Active Behavioral Delta Cap (`<= 5`):** Never activate more than 5 concurrent `deltaStatus == "active"` notes across all books.
> - **UUID-Resolved Sheet Writes & Clean `WHEN`/`DO`:** Always resolve row indices via `<Tab>!A:A` at write time; store `deltaTrigger`/`deltaAction` without `WHEN`/`DO` prefixes and render at most one prefix.
> - **Calm Companion Voice:** Confirmations are 1–2 plain sentences. No exclamation-heavy praise ("Great insight!"), no streaks, no "you haven't…", no "don't forget", no counts of pending work. Questions are invitations, never homework. Any of *"just save it"*, *"skip"*, *"not now"*, *"later"*, *"no thanks"* ends sparring immediately with no follow-up.

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
- **JSON error envelope (parse it, don't guess):**
  - A refused command (`CliError`: validation, conflict guard, delta cap, rate-limit exhaustion…) prints `{"error": "<message>"}` to **stderr** and exits **1**. Nothing past the failing step was written — relay the message plainly.
  - An argparse usage error (missing/unknown flag, bad choice) prints `{"error": "<message>", "usage": "<usage text>"}` to **stderr** and exits **2**. Fix the flags and retry; `--help` output is unchanged.
- **Raw-value writes:** All Sheet writes go through `gsheets mutate raw-batch` (`updateCells`/`appendCells` with `stringValue`/`numberValue`), so `=SUM(…)`, `+10%`, `- bullet` and `YYYY-MM-DD` are stored verbatim. There is no legacy `gsheets mutate batch` fallback for Sheet data. Google `429`/`RESOURCE_EXHAUSTED` responses are retried with backoff (1 s, 2 s; 3 attempts), then the command fails with a calm message that names the **Paste Card** fallback — earlier steps may already be saved, so check with `recall` / `book-list` before re-running (re-running `capture` would duplicate the note).

### Mode B — Native Google Workspace / MCP Fallback (Gemini Spark)

If `gsheets`, `gdrive`, or `gdocs` binaries are missing from `PATH` (`pragya_cli.py` exits cleanly with `CliError` instructing Mode B fallback):
1. Consult [`references/schema_and_ops.md`](references/schema_and_ops.md) for the exact 4-tab column layouts (`Books!A:L`, `Notes!A:R`, `Sessions!A:G`, `DeltaLogs!A:E`), normalized position math, UUID `A:A` lookup, and 30-min session coalescing rules.
2. Read/write directly via your native Google Sheets / Drive / Docs connector. **Mode B Safety Boundary:** Mode B supports Sheets reads/writes (`recap`, `note-link`, `book-question`, book context fields, and read-only `salon`), and MUST **never** attempt silent in-place Google Doc marker replacement without `pragya_cli.py` (leave silent Doc sync to Mode A `salon --apply-maintenance`).
3. **Offline / Disconnected Degradation Tier:** If neither Mode A CLIs nor Mode B Workspace connectors are reachable (or offline), offer `--state-file` snapshot editing or output a structured **Paste Card** for the PWA — never pretend a remote write succeeded.

---

## Socratic Triage Rubric — When to Spar vs. Log Quietly

Default to the lightest path that honors what the user said. Sparring is offered only when an idea is genuinely unfinished — never a toll for saving a note.

| Path | The user is… | Do | Say (shape, not script) |
|---|---|---|---|
| **A · Progress / context** | reporting where they are, or asking a factual question about their reading | `progress` (+ `--chapter` if mentioned); answer directly | "Logged — you're at p. 142, Ch. 7." Zero questions, zero note. |
| **B · Bookmark / quote / light observation** | sharing a line they liked or a quick reaction | `capture` (`saved`) in their own words; `--chapter` if known | "Saved to *Thinking in Systems* at p. 88." Zero questions. |
| **C · Already-articulated insight** | explaining a mechanism *and* its limits in their own words | `capture --atomic` with only the fields they actually said | "Saved as an atomic note, including the boundary you mentioned." No redundant sparring. |
| **D · Live tension** | voicing a clash between instinct and value, an unfinished hunch, or a prescription they haven't tested | `capture --spar` → `reflect --stage 1` → ask **2** Socratic questions → **stop and wait** | "Saved. Two questions, if you'd like to sit with it — or say *just save it* and I'll leave it there." |

**Escape hatch (Path D):** if the user says *just save it* / *skip* / *not now*, run `note-update --note <id|slug> --status saved` and confirm in one sentence. Don't re-raise the questions later unless the user brings the note back up. (This changes only `status` + `updatedAt`; saved questions, `sparStage`, attachments and paused/graduated deltas are kept.) One exception: a note whose delta is still **active** is refused (an active delta needs an atomic note) — tell the user plainly and offer to pause the delta first (`--delta-status paused`) or keep it as is.

**When unsure between B and D, choose B.** A missed sparring opportunity costs nothing; an unwanted interrogation erodes the habit.

---

## 5-Way Conversation Routing

Route natural voice or text turns cleanly to the matching workflow:

### 1. Shelf, Curiosity Anchors & Reading Progress (`book-list`, `book-add`, `book-update`, `book-question`, `progress`)

```bash
# List shelf + active delta count (N/5)
python3 scripts/pragya_cli.py book-list --status reading

# Add a new book (percent unit defaults totalPos=100; optional curiosity spark / stopping point)
python3 scripts/pragya_cli.py book-add \
  --title "The Creative Act" --author "Rick Rubin" --kind nonfiction --format kindle --pos-unit percent \
  --status queued --why-queued "Recommended after our conversation on creative craft"

# Advance reading progress (+delta, exact --pos, or --finish; coalesces 30-min sessions)
python3 scripts/pragya_cli.py progress --book "Thinking in Systems" --delta 18 --session-note "Feedback delays ch. 2"
python3 scripts/pragya_cli.py progress --book "Thinking in Systems" --pos 142 --chapter "Ch. 3: Run"
python3 scripts/pragya_cli.py progress --book "Exhalation" --finish

# Chapter only: saves meta.currentChapter without moving the bookmark or creating a session
python3 scripts/pragya_cli.py progress --book "Thinking in Systems" --chapter "Ch. 4"

# Update metadata, context anchors (--why-queued, --pause-note, --next-stop), or status
python3 scripts/pragya_cli.py book-update --book "book-exhalation" --status finished
python3 scripts/pragya_cli.py book-update --book "Thinking in Systems" --next-stop "Finish Part II · p. 180"
python3 scripts/pragya_cli.py book-update --book "Thinking in Systems" --chapter ""   # empty string clears

# Manage per-book Reading Questions (<= 5 open cap; unknown entries preserved verbatim)
python3 scripts/pragya_cli.py book-question --book "Thinking in Systems" --list
python3 scripts/pragya_cli.py book-question --book "Thinking in Systems" --add "Why do well-meaning fixes cause oscillation?"
python3 scripts/pragya_cli.py book-question --book "Thinking in Systems" --answer q_1a2b --text "Delays cause overshoot." --note delays-in-feedback-loops
python3 scripts/pragya_cli.py book-question --book "Thinking in Systems" --reopen q_1a2b
python3 scripts/pragya_cli.py book-question --book "Thinking in Systems" --remove q_1a2b
```

- **Chapter / story anchors (`--chapter`):** accepted by `progress`, `book-update` (book `meta.currentChapter`), `capture`, `reflect --stage commit` and `note-update` (note `meta.chapter`). An empty string (`--chapter ""`) clears; omitting the flag leaves the value untouched. `progress --chapter` alone is valid (re-sending the same value is a no-op, `chapterChanged: false`).
- **Curiosity & anti-slump anchors:** `book-add` and `book-update` accept `--why-queued` (`<= 240` chars), `--pause-note` (`<= 240` chars), and `--next-stop` (`<= 120` chars). Empty string clears; omitting leaves untouched. `book-question` manages `Books.metaJson.readingQuestions` (`<= 5` open cap; `--note` refuses cross-book, archived, spoiler-shielded, or sealed-prediction notes).
- **Chapter label rule:** a purely ASCII-numeric value (`3`) renders as `Ch. 3`; anything else is shown verbatim (`Ch. 3: Run`, `The Lifecycle of Software Objects`). The badge is `[Ch. 3 · p. 42]` (`[Run · 10%]` for percent books; `[p. 42]` with no chapter).
- `progress` always returns `unlockedPredictionsCount` (0 unless this call finished a fiction book); `book-update` returns it too. When finishing a book with answered Reading Questions and `capstonePending: true`, the finish payload also carries `answeredQuestions` (spoiler-safe).

#### Finishing a Book (`progress --finish` / `book-update --status finished`)

Both commands return the same finish payload on a transition into `finished`: `unlockedPredictionsCount` and `capstonePending` (bool) are **always** present; when `capstonePending` is `true` the result also carries `notesSummary` + `notesSummaryOmittedCount`.

1. Mark the book finished. Acknowledge it once, plainly: "Marked *Born a Crime* as finished."
2. If the CLI returns `unlockedPredictionsCount > 0`, state it as a fact, not a task: "Your 3 sealed predictions are unlocked whenever you'd like to revisit them."
3. If `capstonePending` is `true` and `notesSummary` has notes, offer a **candidate Whole-Book Picture** drafted strictly from those notes — the user's phrasing, no outside facts or plot detail:
   - **Arc** (fiction) / **Thesis** (non-fiction): 2–3 sentences
   - **Key Learnings:** 3–5 one-line bullets
   - **How My Thinking Shifted:** 1–2 sentences
   Then one line: "I can save this as your Whole-Book Picture as-is, or adjust anything."
4. **At most one optional closing question**, only if the notes leave an obvious gap (e.g. nothing about how their view changed). Place it after the draft, marked optional: "(Optional: what will you do differently because of this book?)"
5. On approval → `book-capstone …` then `book-doc-sync`. Confirm in one sentence: "Saved, and added to the top of your Pragya doc."
6. If the user declines, ignores the offer, or changes topic → write nothing and **never bring it up again** unprompted. The PWA keeps a quiet, optional entry point on the book page.
7. If `notesSummary` is empty, skip the draft. Offer once: "If you ever want to capture the shape of this book, I can help." — then drop it.

```bash
# Save the approved Whole-Book Picture (--thesis is an alias of --arc; --learning of --learnings)
python3 scripts/pragya_cli.py book-capstone \
  --book "Thinking in Systems" \
  --thesis "Systems behave according to their structure, not the intentions of the people inside them." \
  --learnings "Delays in balancing loops cause oscillation." \
  --learnings "Stocks buffer change; flows are where leverage lives." \
  --learnings "Look for the loop before blaming the person." \
  --shift "I now look for the loop before blaming the person."
# Optional: --completed-at 2026-11-12T18:00:00Z (ISO-8601; default keeps the existing value, else now)
# Optional: --allow-unfinished (otherwise a non-finished book is refused and nothing is written)

python3 scripts/pragya_cli.py book-doc-sync --book "Thinking in Systems"
```

- `book-capstone` needs `--arc`/`--thesis`, 1–7 `--learnings` (blank entries dropped) and `--shift`. It stores `metaJson.capstone = {arcOrThesis, keyLearnings[], perspectiveShift, completedAt}`, starting from the stored capstone object so unknown inner keys survive.
- **`notesSummary` contract** (locked by tests):
  - Entry keys are exactly `{id, slug, status, pos, posDisplay, label, chapter, title, quote, takeaway, delta}`. `label` is the unbracketed chapter·pos form (`Ch. 3 · p. 42`).
  - Only the book's `saved` + `atomic` notes, in reading order. `quote` / `takeaway` are truncated to 280 chars ending in `…` (stored notes are untouched).
  - Capped at **60** entries: all atomic notes are kept first, then the most recent saved notes, then re-sorted to reading order. `notesSummaryOmittedCount` reports what was trimmed.
  - `delta` is an **object** `{trigger, action}` (WHEN/DO prefixes stripped) or `null`. Contrast: the PWA "Copy Capstone Prompt" renders a `Delta: WHEN … → DO …` **string** line — don't confuse the two shapes.

### 2. Quick or Conversation-First Deep Capture (`capture`)

- `--pos` is optional (defaults to `book.currentPos` without creating a synthetic session).
- Use `--spar` for `"inbox"` (spar later), default for `"saved"`, or `--atomic` ONLY when the user has already discussed and articulated Layer 2 fields live in conversation (see Triage Rubric Path C).
- `--chapter` sets the note's `meta.chapter` (`--chapter ""` = no chapter). When omitted, the note inherits the book's `meta.currentChapter` **only** if `--pos` is omitted or equals the book's `currentPos`; a note at an earlier or later position never inherits.

```bash
# Quick capture with photo & spar flag
python3 scripts/pragya_cli.py capture \
  --book "Thinking in Systems" \
  --pos 156 \
  --chapter "Ch. 3: Run" \
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

### 3. Socratic Reflection Sparring (Path D only) (`reflect --stage 1` -> WAIT -> `--stage commit`)

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
  --delta-status active \
  --chapter "Ch. 3: Run"
```

**Targeted edits & "just save it" (`note-update`):** edit one note without the reflect state machine. Only passed flags change; `metaJson` is carried over untouched (`socraticQuestions`, `sparStage`, attachments, unknown keys). It **never re-slugs**.

```bash
# Escape hatch: leave an inbox / in-reflection note as a plain saved note
python3 scripts/pragya_cli.py note-update --note delays-in-feedback-loops --status saved

# Targeted field edits (empty --title / --chapter / --tags clears)
python3 scripts/pragya_cli.py note-update --note delays-in-feedback-loops \
  --chapter "Ch. 3: Run" --tags "#systems, #delays"
```

- Flags: `--status saved|inbox|in-reflection|atomic`, `--title`, `--quote`, `--takeaway`, `--context`, `--critique`, `--trigger`, `--action`, `--delta-status none|active|paused|graduated`, `--chapter`, `--tags` (replaces the list). At least one is required.
- Delta rules: only a note whose resulting delta is **active** must be `atomic` (pass `--status atomic`, or pause with `--delta-status paused`). WHEN/DO are required only when `--delta-status` / `--trigger` / `--action` is passed, so unrelated edits on legacy rows aren't blocked. The `<= 5` active cap is enforced when `--delta-status` is passed. WHEN/DO prefixes are normalized.
- The note must keep a takeaway, quote or renderable attachment. Conflict guard applies (`--force` to bypass after confirming with the user).

**Soft-archive (`--archive` / `--unarchive`, books and notes):** archiving only sets `metaJson.archivedAt` (no columns change, nothing is deleted). Archived items still resolve by id/slug/title so they can be restored.
- **Archived book:** drops out of `book-list` (use `--include-archived`) and refuses `capture` (offer `book-update --book <id> --unarchive` first). It hides **only the book** — its notes stay reachable in recall, the Companion Doc / Markdown timelines and `notesSummary`.
- **Archived note:** drops out of `note-list`, `delta-status`, `recall qa|checkin|shuffle`, `notesSummary`, per-note `export-md` and the Markdown book index (pass `--include-archived` on `note-list` / `delta-status` to inspect), is no longer *added* to the Companion Doc, and never holds one of the 5 active-delta slots.
- **Permanent delete is PWA-only and deliberate:** the user can "Delete Forever…" an archived book (with its notes, check-ins and sessions) or note in the app, with a short Undo. The CLI has no delete command; if asked, point the user to the archive in the app.
- **Companion Doc text is never deleted:** an entry already written for a note that is archived later stays in the Doc; the user can remove it by hand. Don't tell the user it is "gone from the doc".

```bash
python3 scripts/pragya_cli.py note-update --note delays-in-feedback-loops --archive    # an active delta is paused (deltaPaused: true)
python3 scripts/pragya_cli.py note-update --note delays-in-feedback-loops --unarchive  # reactivated if under the 5 cap, else deltaCapped: true
python3 scripts/pragya_cli.py book-update --book "Thinking in Systems" --archive
python3 scripts/pragya_cli.py book-list --include-archived
```

Never archive on the user's behalf without asking; confirm in one sentence afterwards ("Archived it. It's hidden from your lists and can be restored anytime.").

### 4. Inspecting Notes, Cross-Book Bridges, Deltas, Recall, Recap & Salon (`note-list`, `note-get`, `note-link`, `delta-status`, `recall`, `recap`, `salon`)

```bash
# List notes (shields spoilers & archived notes by default)
python3 scripts/pragya_cli.py note-list --book "Thinking in Systems" --status atomic --tag "#systems"
python3 scripts/pragya_cli.py note-list --delta-status active --include-archived

# Inspect one note by UUID, slug, or old slug alias (spoiler-shielded unless --include-spoilers / --reveal)
python3 scripts/pragya_cli.py note-get --note delays-in-feedback-loops
python3 scripts/pragya_cli.py note-get --note future-plot-note --reveal

# Atomically link/unlink two notes via meta.relatedSlugs + bridgeNotes (never edits takeaway prose)
python3 scripts/pragya_cli.py note-link --note delays-in-feedback-loops --to ecological-lag --why "Both show long feedback lags punishing impatience."
python3 scripts/pragya_cli.py note-link --note delays-in-feedback-loops --to ecological-lag --unlink
python3 scripts/pragya_cli.py note-link --note delays-in-feedback-loops --to ecological-lag --one-way

# View active/paused/graduated Behavioral Deltas (5-cap excludes archived) or transition one note
python3 scripts/pragya_cli.py delta-status
python3 scripts/pragya_cli.py delta-status --note delays-in-feedback-loops --status paused
python3 scripts/pragya_cli.py delta-status --note delays-in-feedback-loops --status active

# Spoiler-safe cross-book Q&A (clamps fiction notes > book.currentPos)
python3 scripts/pragya_cli.py recall --mode qa --query "feedback delays"

# List active Behavioral Deltas (N/5) or log 1/2/3 check-in
python3 scripts/pragya_cli.py recall --mode checkin
python3 scripts/pragya_cli.py recall --mode checkin \
  --note delays-in-feedback-loops --outcome missed \
  --trigger "dashboard latency spikes post-deploy" \
  --reflection "Tweaked TTL within 5 minutes."
# Renamed notes keep answering to their old slug (`meta.aliases`): `--note old-slug` still
# resolves, and `reflect --slug` adds the previous slug to the aliases automatically.
# One check-in per note per local day: a second same-day check-in UPDATES that row's
# outcome (and reflection, if you pass one) — `"checkin": "append" | "update" | "unchanged"`.

# Deterministic daily Takeaway Shuffle + mark reviewed (preserves updatedAt)
python3 scripts/pragya_cli.py recall --mode shuffle --limit 3
python3 scripts/pragya_cli.py recall --mode shuffle --mark-reviewed delays-in-feedback-loops

# Spoiler-safe Re-Entry Brief (for interactive catch-ups & Evening Whisper tasks)
python3 scripts/pragya_cli.py recap
python3 scripts/pragya_cli.py recap --book "Thinking in Systems" --today 2026-11-20

# Sunday Commonplace Salon digest + optional silent Companion Doc maintenance (existing Docs only)
python3 scripts/pragya_cli.py salon --days 7
python3 scripts/pragya_cli.py salon --days 7 --apply-maintenance --max-doc-syncs 3

# Contextual Vocabulary (Lexicon): capture, inspect grouped by lemma, or backfill definitions
python3 scripts/pragya_cli.py word-add --book "Thinking in Systems" --pos 55 --word "oscillation" --quote "A delay in a balancing loop can cause oscillation." --definition "Back-and-forth variation around an equilibrium point." --etymology "Latin oscillare, to swing." --example "Hiring freezes triggered a two-year oscillation."
python3 scripts/pragya_cli.py word-list --book "Thinking in Systems"
python3 scripts/pragya_cli.py word-update --note oscillation --pronunciation "/ˌɒs.ɪˈleɪ.ʃən/" --part-of-speech noun --definition "Back-and-forth variation around a balance point."
```

- **`note-list` / `note-get` spoiler shield:** notes ahead of an unfinished book's bookmark (and sealed fiction predictions) are excluded from `note-list` (`shieldedCount`) and returned as redacted stubs (`shielded: true`, zero title/slug/quote/takeaway/delta text) from `note-get` unless `--include-spoilers` / `--reveal` is passed.
- **`word-add` / `word-list` / `word-update` (Lexicon):** stores contextual vocabulary rows inside `Notes!A:R` (`meta.entryKind = "word"`, `meta.lexicon = {word, lemma, pronunciation?, partOfSpeech?, definition?, etymology?, transferExample?}`, `#vocabulary` tag, `status: "saved"`, `slug` from word so `[[word]]` resolves). Word notes are valid with `--word` alone (without takeaway/quote/attachment), never require Socratic sparring, and are automatically excluded from Takeaway Shuffle, Collision Card, Cross-Book Echoes, bridge candidates, and capstone `notesSummary`. `word-list` groups encounters by `lemma` and redacts spoiler-shielded encounters unless `--include-spoilers` / `--reveal` is passed. `word-update` enriches missing definitions, etymology, pronunciation, part of speech, or transfer examples while preserving all other metadata.
- **`note-link`:** atomically updates both notes via `save_notes_batch` with pre-write `updatedAt` conflict guard on both rows, canonicalizes stale aliases to the target's live slug, keeps `takeaway`/`quote` prose 100% untouched, caps `relatedSlugs` at `<= 20`, and refuses self, archived-note, archived-book, or spoiler-shielded/sealed-prediction links (unless `--include-spoilers` / `--reveal` is passed). Always ask the user before linking two notes on their behalf.
- **`delta-status`:** with no `--note`/`--status`, returns grouped `active`, `paused`, `graduated` lists plus `activeCount` / `cap` / `remainingSlots` (5, ignoring archived notes; pass `--include-archived` to include archived items; shielded deltas are redacted unless `--include-spoilers` / `--reveal`). Passing `--note <id|slug|alias> --status active|paused|graduated|none` (optionally with `--trigger` / `--action`) transitions the note (enforcing non-archived, `atomic`, WHEN/DO, and the 5-cap on `active`, plus the row conflict guard, and redacting shielded notes in the response unless `--include-spoilers` / `--reveal`).
- **`recap`:** returns a single spoiler-safe JSON payload (`readToday`, `allActiveBooksCount`, `selectedBook`, `currentChapter`, `nextStop`, `sittingPace`, `lastNotes`, strictly redacted `openPredictions: {count, items: [{id, pos, posDisplay}]}`, `openQuestions`, `crossBookEchoes`, `queuedContrast`). Refuses archived `--book`.
- **`salon`:** returns `weeklyCaptures`, `pendingOcrNoteIds` (excluding archived and spoiler-shielded notes), `pendingWordNoteIds` (non-archived, unshielded word notes missing a definition, ready for gentle enrichment via `word-update`), `unsyncedDocBooks` (non-archived books with an existing `docUrl`), `bridgeCandidates` (top 1–3 unlinked cross-book pairs sharing specific `#tags`), and `collisionPair` (exact FNV-1a parity with PWA `CollisionCard`). Passing `--apply-maintenance` loads the workspace **once**, syncs at most `--max-doc-syncs` (default 3) books that already have a `docUrl` (never auto-creating new Docs), and records any per-book `CliError` (e.g. `429`) in `maintenance.failedDocs` instead of aborting.

### 5. Media Transcription, Markdown Export & Companion Docs (`ocr-backfill`, `export-md`, `book-doc-sync`)

```bash
python3 scripts/pragya_cli.py ocr-backfill --ocr-cmd "tesseract {path} stdout"
python3 scripts/pragya_cli.py ocr-backfill --note future-plot-note --ocr-text "Passage" --include-spoilers
python3 scripts/pragya_cli.py export-md --output-dir ./reading-notes
python3 scripts/pragya_cli.py book-doc-sync --book "Thinking in Systems"
# Opt-ins (both commands): also include inbox/in-reflection drafts, or notes ahead of the bookmark
python3 scripts/pragya_cli.py book-doc-sync --book "Thinking in Systems" --include-drafts
python3 scripts/pragya_cli.py export-md --output-dir ./reading-notes --include-spoilers
```

- **`ocr-backfill`:** skips archived notes, notes in archived books, and spoiler-shielded / sealed-prediction notes by default (reporting `shieldedCount` without leaking shielded slugs into `skippedSlugs`). Pass `--include-spoilers` / `--reveal` only for explicit interactive backfill on an ahead-of-bookmark photo.
- **`book-doc-sync` — Companion Doc `Pragya · <Book Title>`:**
  - **Two-tier timeline** in reading order `(normalizedPos, pos, createdAt)`:
    - **Atomic** → `HEADING_2` `[<badge>] <Title> [note:<uuid>]`, then only the non-empty lines among `Quote:`, `Takeaway:`, `Mechanism:`, `WHEN …`, `DO …`, `Critique:` (in that order).
    - **Saved** → `HEADING_3` with only `Quote:` / `Takeaway:` (never Layer 2). Untitled saved title = the takeaway's first 8 words (`…` appended only when cut); `Quick Note` when the takeaway is empty. A derived title drops one trailing `.`, and the `Takeaway:` line is omitted when the heading already carries the whole takeaway.
    - `--include-drafts` adds inbox / in-reflection notes as saved-tier (`HEADING_3`) entries.
  - **Capstone block:** `## Whole-Book Picture [capstone:<bookId>]` sits directly under the header (`Thesis:` / `Arc:`, `Key Learnings:` + `• ` lines, `How My Thinking Shifted:`, `Written YYYY-MM-DD`); absent without a capstone.
  - **Spoiler shield (default):** for an unfinished book, notes ahead of the bookmark and sealed predictions are left out and counted in `shieldedCount`; `--include-spoilers` opts in. A block already in the Doc is never deleted because it became shielded.
  - **True in-place sync:** only Pragya marker blocks (`[note:<uuid>]` / `[capstone:<bookId>]` heading + its Pragya field lines) are replaced or inserted, via one `gdocs mutate raw-batch` guarded by `writeControl.requiredRevisionId`. If the revision was rejected (the user edited concurrently), it re-reads and re-plans once; otherwise it falls back to append-only from a fresh read, with a warning. Everything outside markers is byte-preserved; new notes are backfilled in reading order.
  - **Result keys:** `mode` (`DOC_SYNC_MODES`: `created`, `in-place`, `append`, `append-fallback`, `unchanged`), `capstone` (`CAPSTONE_SYNC_STATES`: `absent`, `unchanged`, `added`, `updated`, `removed`, `skipped`), `addedNoteIds`, `updatedNoteIds`, `syncedNoteIds`, `syncedNoteCount` (= added + updated), `shieldedCount`, `warnings`. Relay any `warnings` plainly.
  - **Advise the user:** when writing their own notes under a Pragya entry in the Companion Doc, leave a **blank line** first so the text is never mistaken for a Pragya field line. Text they type after a `[note:…]` marker in a heading is kept on re-sync.
- **`export-md`:** writes per-note `<slug>.md` files for **atomic notes only** (incremental via `exportedAt`), including spoiler/archive-safe `relatedSlugs` frontmatter and `bridgeNotes` under `## Related Concepts`, plus a per-book index `books/<book-slug>.md` (front-matter incl. `currentChapter`, Whole-Book Picture, spoiler-safe answered `## Reading Questions`, `##` atomic entries linking `[[slug]]`, `###` saved entries inline). Same `--include-drafts` / `--include-spoilers` opt-ins and `shieldedCount`.

---

## Proactive Scheduled Task Recipes (Gemini Spark / Tasks)

Use these 3 calm, zero-guilt, opt-in recipes when the user sets up recurring Gemini Spark / scheduled Tasks. Every recipe obeys the **Calm Companion Voice** (no streaks, no "you haven't…", no pending-work counts, strict silence when nothing genuinely applies).

### Recipe 1: Morning Calendar-Matched Delta Priming + Quiet Reading Pocket (~8:30 AM)

1. Run `delta-status` (Mode A) or read active `Notes` (`deltaStatus == "active"`, non-archived, unshielded) in Mode B. Also run `recap` (to check `readToday` and `selectedBook` / `nextStop`).
2. Check today's Google Calendar via `gcalendar` (if `gcalendar` is not connected, skip calendar matching gracefully and do **not** nag the user to connect it).
3. **Genuine delta matches only:** compare today's calendar events against each active delta's `WHEN` trigger. Surface **only** genuine situational matches (0–2 lines, neutral phrasing like *"Before your 2:00 PM Architecture Review — from Thinking in Systems: WHEN …, DO …"*). Never force a weak match.
4. **Quiet Reading Pocket (at most 1):** if `readToday === false` and `allActiveBooksCount > 0`, spot at most one open `>= 30 min` daylight gap on today's calendar and mention it once calmly alongside `selectedBook.title` + `nextStop` (if set).
5. **Silence rule:** if there are **zero** genuine delta matches AND no suitable reading pocket (or `readToday === true`), stay completely silent / send no message.

### Recipe 2: Evening Re-Entry Whisper (~8:30 PM)

1. Run `recap` (Mode A) or compute the same spoiler-safe brief from `Books`/`Notes`/`Sessions` (Mode B).
2. **Silence rule:** if `readToday === true` OR `allActiveBooksCount === 0`, stop immediately and send **nothing**.
3. Otherwise send **at most 3 short lines** for `selectedBook` only:
   - **Line 1 (Anchor):** `selectedBook.title`, where they left off (`currentChapter` + `selectedBook.posDisplay`), and `nextStop` or `sittingPace.label` (if present).
   - **Line 2 (Memory thread):** 1 concise line from their most recent safe note (`lastNotes`) or an open Reading Question (`openQuestions`) — strictly grounded in `<= currentPos` with zero outside plot/chapter info.
   - **Line 3 (Optional sealed count or echo):** Only if `openPredictions.count > 0` (mention count + page/percent only — **never** prediction text) OR a single `crossBookEchoes[0]` hook.

### Recipe 3: Sunday Commonplace Salon + Silent Maintenance (Sunday Evening)

1. **Mode A:** run `salon --days 7 --apply-maintenance --max-doc-syncs 3`.
   - **Mode B safety boundary:** run **read-only** `salon` logic over Sheets only — **never** attempt silent in-place Google Doc marker replacement without `pragya_cli.py`.
2. **Silent maintenance line (only if changed):** if `maintenance.updatedDocCount > 0` or `maintenance.failedDocs` is non-empty, include a single calm 1-line summary (e.g. *"Synced 2 Companion Docs."* or note any failed doc plainly). If nothing changed, say nothing about maintenance. If `pendingOcrNoteIds` is non-empty (already filtered to non-archived, non-shielded images), offer once to transcribe them on reply.
3. **Cross-Book Collision (1 pair):** present `collisionPair` (2 unlinked notes from 2 different books) with a single open question (*"Do these two ideas push against each other or reinforce each other?"*).
4. **Bridge Proposals (1–2 pairs) & Word Enrichment (optional):** if `bridgeCandidates` is non-empty, propose 1–2 concrete cross-book links (citing shared `#tags` and a suggested 1-line `--why`), explicitly asking for the user's approval before running `note-link`. **Never** link automatically without approval and **never** rewrite `takeaway` or `quote` prose. If `pendingWordNoteIds` is non-empty, offer once to enrich definitions/etymology/examples via `word-update` (never forced).

---

## Mobile & Safety Hygiene Checklist

- **Unit Mismatch Guard:** Before logging `progress` or `capture --pos`, check `book.posUnit` (`page` vs `percent` vs `loc`). If the user says `"45%"` on a `page`-tracked book, confirm or convert (`0.45 * totalPos`) rather than writing `45` as page 45.
- **Backward Bookmark Guard:** `progress` and `book-update` reject lowering `currentPos` unless `--force-pos` is explicitly confirmed by the user. (`capture --pos` on an earlier page logs the note cleanly at that page without lowering the book bookmark.)
- **Attachment & Image Hygiene:** Enforce `<= 3` attachments per note before uploading. When a user uploads a mobile camera photo (HEIC/JPEG), convert/compress to `<= 1600px` `.webp` when tooling permits, and use multimodal vision OCR to populate `quote` cleanly (or run `ocr-backfill`, which excludes archived and spoiler-shielded notes by default).
- **Google Docs Formatting:** `book-doc-sync` writes `HEADING_1` (book), `HEADING_2` (Whole-Book Picture + atomic notes), `HEADING_3` (saved notes); replaces `[note:<uuid>]` / `[capstone:<bookId>]` blocks in place, in reading order, so re-runs never duplicate Docs or entries.

