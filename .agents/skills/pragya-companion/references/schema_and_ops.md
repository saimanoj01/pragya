# Pragya Schema & Operations Reference (Mode B / Native Workspace Fallback)

Use this reference whenever **`gsheets` / `gdrive` / `gdocs` CLIs are unavailable** (e.g. Gemini Spark or native MCP/Workspace connectors where `pragya_cli.py` exits with `CliError` on `FileNotFoundError`), or when inspecting exact wire formats.

---

## 1. Google Sheet Schema (`Pragya Commonplace`)

Locate spreadsheet by exact title **`Pragya Commonplace`** (non-trashed). If missing, create it with the 4 tabs below and write exact canonical row-1 headers before appending data.

### Tab 1: `Books!A:L` (12 Columns)

| Col | Header | Type / Enum | Contract |
|---|---|---|---|
| `A` | `id` | UUID v4 string | Immutable primary key |
| `B` | `title` | string | Book title (normalized duplicate check) |
| `C` | `author` | string | Default `"Unknown Author"` |
| `D` | `format` | `"physical" \| "kindle"` | Reading medium |
| `E` | `kind` | `"nonfiction" \| "fiction"` | Drives Socratic lens & Sealed Predictions |
| `F` | `status` | `"reading" \| "queued" \| "finished" \| "paused"` | Shelf bucket |
| `G` | `currentPos` | number | Monotonic `Math.max` unless explicit user override |
| `H` | `totalPos` | number | `100` default if `posUnit == "percent"`, `0` if unknown |
| `I` | `posUnit` | `"page" \| "percent" \| "loc"` | Display unit |
| `J` | `normalizedPos` | number (`0.0–1.0`) | `1.0` if `finished`, `pos/100` if `percent`, `pos/totalPos` if `totalPos > 0`, else `0` |
| `K` | `docUrl` | string | Companion Google Doc URL (`https://docs.google.com/document/d/<docId>/edit`) |
| `L` | `metaJson` | JSON string | `{"updatedAt": ISO, "startedAt"?: ISO, "finishedAt"?: ISO, "coverUrl"?: URL, "currentChapter"?: string, "capstone"?: {arcOrThesis, keyLearnings[], perspectiveShift, completedAt}, …unknown keys preserved}` — see §1.5 |

### Tab 2: `Notes!A:R` (18 Columns)

| Col | Header | Type / Enum | Contract |
|---|---|---|---|
| `A` | `id` | UUID v4 string | Immutable primary key |
| `B` | `slug` | kebab-case string | Unique slug for `[[wikilinks]]` and `<slug>.md` |
| `C` | `bookId` | UUID string | FK -> `Books.id` |
| `D` | `createdAt` | ISO-8601 UTC | Creation timestamp |
| `E` | `updatedAt` | ISO-8601 UTC | Updated on content edits; **preserved** on `Mark Reviewed` |
| `F` | `pos` | number | Clamped to `[0, totalPos]` (or `[0, 100]` for `percent`) |
| `G` | `normalizedPos` | number (`0.0–1.0`) | Computed from `(pos, book.totalPos, book.posUnit)` |
| `H` | `status` | `"saved" \| "inbox" \| "in-reflection" \| "atomic"` | Note lifecycle stage |
| `I` | `source` | `"app" \| "agent"` | Use `"agent"` for skill/assistant writes |
| `J` | `tags` | CSV string | Lowercase `#tag` tokens separated by `", "` |
| `K` | `quote` | string | Verbatim passage or OCR transcription |
| `L` | `takeaway` | string | Core takeaway strictly in the user's voice |
| `M` | `contextMechanism` | string | Layer 2: mechanism / scene & craft |
| `N` | `critique` | string | Layer 2: critique & boundary conditions |
| `O` | `deltaTrigger` | string | Stored **without** leading `WHEN ` |
| `P` | `deltaAction` | string | Stored **without** leading `DO ` |
| `Q` | `deltaStatus` | `"none" \| "active" \| "paused" \| "graduated"` | Strictly `<= 5` concurrent `"active"` notes across all books |
| `R` | `metaJson` | JSON string | `{"title"?, "attachments": [...] (stored verbatim, any count; <= 3 enforced only when adding), "links": [...], "isPrediction"?, "socraticQuestions"?: [q1, q2(, q3)] (canonical; legacy top-level q1/q2/q3 dropped on write), "sparStage"? (verbatim), "chapter"?: string, "ocrBackfilled"?, "exportedAt"?, "lastReviewedAt"?, …unknown keys preserved}` — see §1.5 |

### Tab 3: `Sessions!A:G` (7 Columns)

| Col | Header | Type | Contract |
|---|---|---|---|
| `A` | `id` | UUID v4 string | Immutable primary key |
| `B` | `bookId` | UUID string | FK -> `Books.id` |
| `C` | `date` | `YYYY-MM-DD` | Local calendar date |
| `D` | `startPos` | number | Starting position for this session window |
| `E` | `endPos` | number | Latest position reached (`max` unless override) |
| `F` | `updatedAt` | ISO-8601 UTC | Drives 30-minute (`1800s`) coalescing window |
| `G` | `note` | string | Optional short session summary |

### Tab 4: `DeltaLogs!A:E` (5 Columns)

| Col | Header | Type / Enum | Contract |
|---|---|---|---|
| `A` | `id` | UUID v4 string | Immutable primary key |
| `B` | `noteId` | UUID string | FK -> `Notes.id` |
| `C` | `date` | `YYYY-MM-DD` | Local calendar date |
| `D` | `outcome` | `"applied" \| "missed" \| "no-trigger"` | `1` / `2` / `3` practice outcome |
| `E` | `reflection` | string | Optional check-in reflection. One row per note per local day (CD C2.1): a later same-day check-in updates the row's outcome instead of appending |

### 1.5 `metaJson` Keys, Preservation Rule & Drift Aliases

No schema columns change for new data: everything new lives inside `metaJson` (`Books!L`, `Notes!R`).

| Tab | Key | Shape | Contract |
|---|---|---|---|
| Books | `capstone` | `{arcOrThesis: string, keyLearnings: string[], perspectiveShift: string, completedAt: ISO}` | Whole-Book Picture (written by `book-capstone` or the PWA modal). The **raw object passes through verbatim** — unknown inner keys survive; typed readers just ignore them. `keyLearnings` holds 1–7 items when written by the CLI. `completedAt` is set on first save and preserved on edit; a stored value that isn't an ISO timestamp (e.g. `"soon"`, `123`) is repaired to now on the next save (CLI and PWA). **Completeness differs on purpose:** CLI `book-capstone` (agent-generated) requires arc/thesis, ≥1 learning and the shift; the PWA modal (user-authored, calm/optional) saves once *any* field has text. Both treat any non-empty field as "has capstone" (suppresses `capstonePending`). |
| Books | `currentChapter` | string | Free-form chapter / story label for the bookmark. Empty = cleared (key dropped). |
| Notes | `chapter` | string | Chapter / story label of the note. |
| Notes | `socraticQuestions` | string[] (1–3) | Canonical store for the saved Socratic questions. |
| Notes | `predictionOutcome` | `{text: string, at: ISO}` | PWA "Reflect on Outcome" for an unlocked fiction prediction (CD C4.2). Preserve verbatim; never fill it in yourself. |
| Notes | `sparStage` | any | Agent-owned sparring state; stored **verbatim** (never string-coerced). |
| Books & Notes | `archivedAt` | ISO string | Soft-archive (CD C1.1). Present → excluded from default lists (PWA Shelf/Notes/search/palette/shuffle/practice/backlinks, a book's Captured Notes, the capstone prompt; CLI `book-list`, `recall`, Doc/MD timelines, `notesSummary`, per-note `export-md`) and never counted toward the 5 active-delta slots. Archiving a **book** hides only the book (its notes stay reachable). Companion Doc text already written for a later-archived note is never deleted. Set/cleared by `book-update`/`note-update --archive|--unarchive` or the PWA. Lookups by id/slug still resolve archived items. |
| Notes | `archivedDeltaStatus` | `"active"` | Written only when archiving paused an active delta; unarchive reactivates it if fewer than 5 other deltas are active, then removes the key. |
| Notes | `attachments` | array | Stored **verbatim, any count, any entry shape** (unknown types / invalid entries / a 4th+ entry are kept on round-trip). Filtering (`image`/`doc`/`link`, first 3) happens **only at render**, and `<= 3` is enforced only when *adding* a new attachment. |

- **Unknown-key preservation rule:** any `metaJson` key you don't recognize (e.g. `subgenre`, future keys) MUST survive every read → edit → write and snapshot round-trip. Read the existing `metaJson`, change only the keys you own, and write the whole object back. Known keys are re-validated and dropped only when empty or invalid.
- **Drift aliases (canonicalized on read, legacy key dropped on the next write):**
  - `chapterNote` → `currentChapter` (an existing `currentChapter` wins).
  - top-level `q1` / `q2` / `q3` → `socraticQuestions`.
  - `Books!D` `print` (also `hardcover`/`paperback`/anything unknown) → `physical`; `ebook` → `kindle`.
  - `Notes!I` `companion` (also `assistant`/`cli`/`skill`) → `agent`; anything else → `app`.

---

## 2. Mode B Write Protocol & Domain Rules

1. **UUID-Resolved Row Updates (Zero Row Drift):**
   - Never cache row numbers across turns.
   - Before updating an existing row, read `<Tab>!A:A`, locate the exact 1-based row index `r` where cell `A{r} === id`, verify stale-write guard (`remote updatedAt <= loaded updatedAt`), and update `<Tab>!A{r}:<LastCol>{r}` with **raw values only**.
   - If the UUID is absent, append a new row after the header row. If the UUID vanishes between the `A:A` read and the write, abort with no write — never append a duplicate.
   - **Raw-value writes (never `USER_ENTERED`):** `USER_ENTERED` coercion turns `=SUM(1,2)`, `+10%`, `- bullet` or `YYYY-MM-DD` into formulas, numbers or date serials.
     - The bundled CLI uses `gsheets mutate raw-batch <spreadsheetId> -f <file>` with a Sheets `batchUpdate` body: `updateCells` (range `{sheetId, startRowIndex: r-1, endRowIndex: r, startColumnIndex: 0, endColumnIndex: <col count>}`, `fields: "userEnteredValue"`) / `appendCells`, each cell `{"userEnteredValue": {"stringValue": …}}` or `{"numberValue": …}` (numbers → `numberValue`, everything else → `stringValue`). `sheetId` comes from `list-sheets` `properties.sheetId`. There is no fallback to `gsheets mutate batch` for Sheet data.
     - The PWA and native connectors use `values.update` / `values:append` / `values:batchUpdate` with `valueInputOption=RAW`.
   - **Batched multi-tab writes (Mode B):** when one turn touches several tabs (e.g. a progress update = `Books` row + `Sessions` row), prefer a **single** `values:batchUpdate` call with `valueInputOption=RAW` and one `data[]` entry per range, `Books` listed **before** `Sessions` — after resolving every row index via `A:A` at write time.
   - **Rate limits (`429` / `RESOURCE_EXHAUSTED` / `rateLimitExceeded` / `quotaExceeded`):** retry with backoff (e.g. 1 s, then 2 s). If it still fails, stop and output a **Paste Card** (§3) — say plainly that earlier steps may already be saved and check before re-running. A 429 means that write did not happen.
   - **Never run ad-hoc live migrations** (bulk rewrites, header/legacy-key cleanups, re-encoding rows) against the user's Sheet. Legacy shapes are canonicalized lazily on the next normal write.
2. **Book Progress & Session Coalescing:**
   - Save `Books` **before** `Sessions` so a book conflict aborts cleanly without creating an orphan session.
   - Advancing a `"queued"` or `"paused"` book transitions `status -> "reading"` and sets `meta.startedAt` if unset.
   - Look up any `Sessions` row matching `(bookId, todayDate)` with `-60 <= (now - updatedAt) <= 1800s`; if found, update `endPos` & `updatedAt` in place, else append a new `Sessions` row.
   - **Never** create a synthetic `Sessions` row during `book-add`, or during `capture` when `--pos` is omitted/unchanged, or for a chapter-only change (`meta.currentChapter` + `meta.updatedAt` only).
3. **Behavioral Delta Invariants:**
   - Strip repeating leading `WHEN` / `WHEN:` from `deltaTrigger` and `DO` / `DO:` from `deltaAction` before storing; render at most one `WHEN ` / `DO ` prefix.
   - Count all notes with `deltaStatus === "active"`; refuse activating a 6th delta until one is paused or graduated.
   - Only an **active** delta requires `status === "atomic"`; paused / graduated deltas may stay on a saved note.
4. **Fiction Spoiler Clamping:**
   - Compute `isNoteSpoiler(note, book)`:
     - `false` if `!book || book.status === "finished"`
     - When `book.totalPos > 0 || book.posUnit === "percent"`: recompute the note's effective position from `note.pos` (`pos / totalPos`, or `pos / 100` for percent — don't trust a stale stored `note.normalizedPos`) and treat it as a spoiler only if it is `> book.normalizedPos + 1e-6` (stored positions are rounded to 6 decimals).
     - `note.pos > book.currentPos` fallback when `totalPos == 0`
   - Never surface spoiler notes or later plot knowledge from model memory when discussing a non-finished fiction book.
5. **Media & Companion Docs:**
   - Store photos in Drive folder **`Pragya Media/`** (`<= 1600px` WebP preferred; convert mobile HEIC/PNG before upload when possible). Never delete Drive files when editing/removing note attachments.
   - **Unsaved PWA capture uploads stay in Drive (policy, CD C4.3):** a photo uploaded in Quick Capture is written to `Pragya Media/` immediately; the capture draft keeps only the reference (Drive file id, name, mime, dims — never the image). If the draft is discarded, or never saved, the file remains in `Pragya Media/` (append-only blobs; there is no Drive DELETE). Don't promise cleanup — tell the user they can remove stray files from that folder in Drive themselves.
   - Attachment entries in `Notes!R` (`metaJson.attachments`): add at most `3` (`image`, `doc`, `link`) per note, but never drop existing entries you don't understand — they are stored verbatim and filtered only at render (§1.5).
   - Book Companion Docs are titled **`Pragya · <Book Title>`**, recorded in `Books!K` (`docUrl`), and use structured headings rather than raw `#` markdown strings: `Heading 1` for the book title; `Heading 2` for `Whole-Book Picture [capstone:<bookId>]` (directly under the header) and for each atomic note; `Heading 3` for each saved note. Note headings read `[<Ch. X · p. N>] <Title> [note:<uuid>]`, in reading order.
   - **Editing an existing Doc:** only replace/insert Pragya marker blocks (the marker heading + its Pragya field lines); never rewrite or flatten user prose. Read the Doc (`documents.get`, keep `revisionId`), then send one `gdocs mutate raw-batch` (Docs `batchUpdate`) with `"writeControl": {"requiredRevisionId": "<revisionId>"}`. If it is rejected because the Doc changed, re-read and re-plan **once**; otherwise fall back to append-only (by marker) from a fresh read. Without a `revisionId`, never send index-based edits — append only.
6. **Permanent Delete (PWA only, CD C1.2):** agents/CLI never delete rows. For reference, the PWA:
   - Only deletes an **archived** book/note. It force-refreshes the workspace, re-plans the cascade (book → its notes, their DeltaLogs, its Sessions; note → its DeltaLogs), then sends **one** `values:batchGet` (`<Tab>!A:A` per involved tab; the target's tab read in full so its `metaJson` is re-checked for `archivedAt` from the same read) and **one** `spreadsheets.batchUpdate` with every `deleteDimension` (descending row index per sheet). All-or-nothing: on failure nothing is deleted. Ids already gone are skipped. Drive files are never touched.
   - **Undo** appends only rows whose id is absent from the Sheet (one `values:append` per tab, `RAW`); it never overwrites an existing row. Restored rows are re-written through the canonical codecs and land **at the bottom** of each tab, so the result is entity-equal, not byte-identical: serial `createdAt` becomes ISO, source `cli` becomes `agent`, tags are normalized, `metaJson` gains `attachments: []` / `links: []`, and cells in user-added columns beyond the schema (e.g. column S) are dropped.
   - `localStorage["pragya_last_delete_backup_v1"]` is a **support-only safety net** with no UI: the deleted rows, written just before the delete. It is removed if the delete fails, kept (marked `confirmed`) after success, cleared by the next successful sync after that and on logout or account switch, and expired on app boot after 7 days.

---

## 3. Degradation Tiers & Offline Paste Card (`PragyaSnapshot` v1)

When neither Mode A (`gsheets` CLI) nor Mode B (live Workspace connector) is available:
1. If a local snapshot JSON file exists, run `pragya_cli.py --state-file <path.json> ...`.
2. Otherwise output a clean **Paste Card** (either a ready-to-import `PragyaSnapshot` v1 JSON block or exact field values for Quick Capture / Shelf update) and explicitly tell the user it has not been synced to Google Sheets yet.
