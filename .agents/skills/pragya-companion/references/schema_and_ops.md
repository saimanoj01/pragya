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
| `L` | `metaJson` | JSON string | `{"updatedAt": ISO, "startedAt"?: ISO, "finishedAt"?: ISO, "coverUrl"?: URL}` |

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
| `R` | `metaJson` | JSON string | `{"title"?, "attachments": [...] (<=3), "links": [...], "isPrediction"?, "socraticQuestions"?: [q1, q2], "ocrBackfilled"?, "exportedAt"?, "lastReviewedAt"?}` |

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
| `E` | `reflection` | string | Optional check-in reflection |

---

## 2. Mode B Write Protocol & Domain Rules

1. **UUID-Resolved Row Updates (Zero Row Drift):**
   - Never cache row numbers across turns.
   - Before updating an existing row, read `<Tab>!A:A`, locate the exact 1-based row index `r` where cell `A{r} === id`, verify stale-write guard (`remote updatedAt <= loaded updatedAt`), and update `<Tab>!A{r}:<LastCol>{r}` with raw/string-safe values (`USER_ENTERED` coercion can convert `YYYY-MM-DD` or `+10%` if not formatted as plain text or raw cells).
   - If the UUID is absent, append a new row after the header row.
2. **Book Progress & Session Coalescing:**
   - Save `Books` **before** `Sessions` so a book conflict aborts cleanly without creating an orphan session.
   - Advancing a `"queued"` or `"paused"` book transitions `status -> "reading"` and sets `meta.startedAt` if unset.
   - Look up any `Sessions` row matching `(bookId, todayDate)` with `-60 <= (now - updatedAt) <= 1800s`; if found, update `endPos` & `updatedAt` in place, else append a new `Sessions` row.
   - **Never** create a synthetic `Sessions` row during `book-add`, or during `capture` when `--pos` is omitted/unchanged.
3. **Behavioral Delta Invariants:**
   - Strip repeating leading `WHEN` / `WHEN:` from `deltaTrigger` and `DO` / `DO:` from `deltaAction` before storing; render at most one `WHEN ` / `DO ` prefix.
   - Count all notes with `deltaStatus === "active"`; refuse activating a 6th delta until one is paused or graduated.
4. **Fiction Spoiler Clamping:**
   - Compute `isNoteSpoiler(note, book)`:
     - `false` if `!book || book.status === "finished"`
     - `note.normalizedPos > book.normalizedPos` when `book.totalPos > 0 || book.posUnit === "percent"`
     - `note.pos > book.currentPos` fallback when `totalPos == 0`
   - Never surface spoiler notes or later plot knowledge from model memory when discussing a non-finished fiction book.
5. **Media & Companion Docs:**
   - Store photos in Drive folder **`Pragya Media/`** (`<= 1600px` WebP preferred; convert mobile HEIC/PNG before upload when possible). Never delete Drive files when editing/removing note attachments.
   - Attachment entries in `Notes!R` (`metaJson.attachments`) are strictly capped at `<= 3` (`image`, `doc`, `link`).
   - Book Companion Docs are titled **`Pragya · <Book Title>`**, recorded in `Books!K` (`docUrl`), and use structured headings (`Heading 1` for title, `Heading 2` with `[note:<uuid>]` marker per atomic note) rather than raw `#` markdown strings.

---

## 3. Degradation Tiers & Offline Paste Card (`PragyaSnapshot` v1)

When neither Mode A (`gsheets` CLI) nor Mode B (live Workspace connector) is available:
1. If a local snapshot JSON file exists, run `pragya_cli.py --state-file <path.json> ...`.
2. Otherwise output a clean **Paste Card** (either a ready-to-import `PragyaSnapshot` v1 JSON block or exact field values for Quick Capture / Shelf update) and explicitly tell the user it has not been synced to Google Sheets yet.
