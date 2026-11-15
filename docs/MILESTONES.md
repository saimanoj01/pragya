# Pragya — Execution Milestones & Acceptance Gates

All milestones enforce the contracts in [`SPEC.md`](./SPEC.md), zero AI/voice code in the PWA, strict Pragya branding (zero legacy name leaks), and clean green gates (`npm run build`, `npm run lint`, unit tests, Playwright E2E) before each checkpoint commit & push.

---

## Milestone 1: Foundation, Auth, Storage Spine & Core Capture

### Scope & Deliverables
1. **Scaffold & Nebula Theme:**
   - `package.json` (`react`, `react-dom` 18.3, `lucide-react`, `framer-motion`, `sonner`, `vite` 5, `tailwindcss` 3.4, `typescript` 5, `@playwright/test`), `tsconfig.json`, `vite.config.ts` (`base: process.env.VITE_BASE_PATH || './'`, port `3000`), `postcss.config.js`, `tailwind.config.js`, `index.html`, `src/index.css` (exact dark/light HSL monochrome tokens + `.num` tabular numerals + `14px` `--radius`), `.env.example`, `playwright.config.ts`.
2. **Domain Types, Seed Data & Pure Utilities:**
   - `src/types/pragya.ts` (`Book`, `Note`, `ReadingSession`, `DeltaLog`, `Attachment`, `PragyaSnapshot`, metadata interfaces).
   - `src/utils/spoilerMath.ts` (`computeNormalizedPos`, `isNoteSpoiler`, `isSealedPrediction`).
   - `src/utils/deltaFormat.ts` (`stripDeltaPrefix`, `normalizeDeltaTrigger`, `normalizeDeltaAction`, `formatWhenDoDisplay` preventing duplicate `WHEN WHEN` / `DO DO`).
   - `src/utils/sessionCoalesce.ts` (`upsertCoalescedSession` enforcing 30-min same-book same-date coalescing).
   - `src/utils/sheetCodecs.ts` (strict row serializers/parsers for `Books!A:L`, `Notes!A:R`, `Sessions!A:G`, `DeltaLogs!A:E`).
   - `src/utils/wikilinks.ts` (`extractWikilinks`, slugification, unique slug generation).
   - `src/utils/imageCompress.ts` (offscreen canvas resize `<= 1600px` + WebP encoding).
   - `src/utils/navigation.ts` (hash router `#/shelf`, `#/book/:id`, `#/notes`, `#/note/:slug`, `#/practice`, `#/settings`, ignoring `access_token=` / `error=` OAuth callbacks).
   - `src/data/demoSeed.ts` (rich realistic demo books, notes across `saved`/`inbox`/`in-reflection`/`atomic`, sealed fiction prediction, future spoiler note, sessions, delta logs).
3. **Storage & Media Layer:**
   - `src/services/storage.ts` (unified `StorageAdapter` contract).
   - `src/services/demoMediaDb.ts` (`IndexedDB` database `pragya-demo-media`, store `blobs`).
   - `src/services/demoAdapter.ts` (`localStorage('pragya_demo_state_v1')` + `IndexedDB` blobs).
   - `src/services/googleSheetsAdapter.ts`:
     - Drive search/create `"Pragya Commonplace"` spreadsheet & `"Pragya Media"` folder.
     - 4-tab schema verification & non-destructive header auto-repair (`Books!A:L`, `Notes!A:R`, `Sessions!A:G`, `DeltaLogs!A:E`).
     - UUID `A:A` row resolution before every `values.update`, with `values.append` fallback.
     - Drive `modifiedTime` fast-reload cache (`pragya_sheets_cache_v1`).
     - Private Drive `<DriveImage />` component using `Authorization: Bearer` + Cache API (`pragya-media-v1`), append-only media semantics.
4. **Auth, App State & Core Shell:**
   - `src/context/AuthContext.tsx` (Client ID cascade `VITE_GOOGLE_CLIENT_ID` → `window.VITE_GOOGLE_CLIENT_ID` → `localStorage('pragya_google_client_id')`, CSRF state, SPA hash token extraction, scopes `drive.readonly`, `drive.file`, `spreadsheets`, `email`, `profile`, Playwright hook, Demo Mode fallback, `401` Session Expired modal trigger).
   - `src/context/ThemeContext.tsx` & `src/context/PragyaContext.tsx`.
   - `src/components/layout/AppLayout.tsx`, `Sidebar.tsx` (`244px`/`64px` collapsible), `BottomNav.tsx` (5-slot `Shelf`, `Notes`, `+` Capture, `Practice`, `More` drawer), `CommandPalette.tsx` (`⌘K`), `SessionExpiredModal.tsx`.
5. **Core Views & Modals:**
   - `LoginView.tsx`, `ShelfView.tsx` (Now Reading + Re-Entry Context + `+10p` + exact advance + responsive 30-day activity dots + `Queued`/`Finished`/`Paused`), `AddBookModal.tsx`, `EditBookModal.tsx`, `QuickCaptureModal.tsx` (`N`, quote, takeaway, tags, `Spar w/ AI later`, `Fiction Prediction` for fiction books, Photo/Doc/Link up to 3 attachments + `⌘V` paste), `NotesView.tsx` (instant search + `All`/`To Spar`/`Atomic`/`Has Media`/`[[Concepts]]` filters + inline Spoiler Shield preview), `SettingsView.tsx`.

### Acceptance Criteria (Done)
- [ ] Strictly Pragya-branded across UI, code, storage keys, skill, and docs (zero legacy brand leaks).
- [ ] Dark & Light Nebula monochrome theme tokens match `SPEC.md` §3; numeric readouts use `.num`.
- [ ] Mobile (`390×844`) `ShelfView` renders all 30 activity dots inside the card width with `scrollWidth <= clientWidth` (zero horizontal overflow) and clean `Add Book` button wrapping (`whitespace-nowrap`).
- [ ] `QuickCaptureModal` (`N`) captures Quote + Takeaway + Tags + Spar checkbox + Fiction Prediction checkbox + up to 3 attachments (including `⌘V` image compression `<= 1600px` WebP and Google Doc URL chip auto-detection) and advances book position monotonically (`Math.max`) with 30-min session coalescing.
- [ ] `NotesView` filters (`All`, `To Spar`, `Atomic`, `Has Media`, `[[Concepts]]`) and inline Spoiler Shield blur (`note.normalizedPos > book.normalizedPos`) work accurately.
- [ ] `GoogleSheetsAdapter` passes mock-fetch/unit verification for: auto-repair of missing tabs/headers, UUID `A:A` resolution before `values.update`, `modifiedTime` `0ms` cache hit on reload, `401` expiry trigger, and `pragya-media-v1` authenticated image cache.

### Required Automated Tests
- **Unit (`tests/unit/m1Core.test.mjs` via `node --test`):**
  - Sheet row encode/decode roundtrips (`Books!A:L`, `Notes!A:R`, `Sessions!A:G`, `DeltaLogs!A:E`).
  - `computeNormalizedPos` & `isNoteSpoiler` across `page`, `percent`, `loc`, unknown `totalPos`, and `finished` books.
  - Monotonic `Math.max` bookmark enforcement + explicit override flag.
  - 30-min session coalescing (within 30m updates existing row; >30m or different date/book appends new row).
  - `stripDeltaPrefix` (`"WHEN foo"` / `"WHEN WHEN foo"` → `"WHEN foo"`, `"DO DO bar"` → `"DO bar"`).
  - `GoogleSheetsAdapter` mocked `fetch` tests: schema repair, UUID `A:A` row lookup, `modifiedTime` cache hit skipping sheet reads, `401` callback.
- **Playwright E2E (`tests/specs/tier1_foundation_and_capture.spec.ts` & `tier2_oauth_and_mobile.spec.ts`):**
  - Demo login, theme toggle, sidebar collapse persistence.
  - Shelf `+10p` & exact position advance coalescing into a single session for the day.
  - `QuickCaptureModal` (`N`): save note with tags + `Spar w/ AI later` + image upload/paste + Doc URL paste (max 3 cap enforced).
  - `NotesView`: search & filter pills (`To Spar`, `Atomic`, `Has Media`, `[[Concepts]]`) + inline Spoiler Shield preview & reveal.
  - `CommandPalette` (`⌘K`) navigation & search.
  - Simulated Google OAuth hash callback (`access_token=` + CSRF `state`), `modifiedTime` fast reload (asserting sheet range GETs are skipped when `modifiedTime` unchanged), and `401` triggering `session-expired-modal`.
  - Mobile (`390×844`) 5-slot `BottomNav`, `More` drawer, and assertion that `document.documentElement.scrollWidth <= window.innerWidth` and `[data-testid="activity-dots"]` has zero horizontal overflow.

### Checkpoint Gate
- `npm run build` (`tsc && vite build`), `npm run lint`, `npm run test:unit`, and M1 `npm run test:e2e` all pass → commit & push M1 checkpoint.

---

## Milestone 2: Deepening, Spoiler Shield, Wikilinks/Backlinks, Practice & Snapshot Backup

### Scope & Deliverables
1. **Book Drilldown (`src/components/views/BookDetailView.tsx`, `#/book/:id`):**
   - Per-book progress header, `+10p` & exact position input, **Manual Bookmark Reset / Override** checkbox (`manual-pos-override-checkbox`) enabling explicit backward position reset, **Mark as Finished** (`mark-finished-btn`) unlocking sealed fiction predictions and clearing spoiler blurs.
   - Ordered book notes list with per-card Spoiler Shield + `Space` reveal.
2. **Atomic Note Detail (`src/components/views/NoteDetailView.tsx`, `#/note/:slug`):**
   - **Socratic Recovery Banner** (`socratic-recovery-banner`) shown when `status === 'in-reflection'` and `meta.socraticQuestions` is populated, rendering both persisted questions above `Continue Deepening →`.
   - Verbatim Quote, Core Takeaway, clickable `[[wikilinks]]`, Layer 2 sections (`Context & Mechanism`, clean single `WHEN`/`DO` Behavioral Delta card, `Socratic Critique`), `<DriveImage />` attachment thumbnails + **`ImageLightbox.tsx`** (`Space` / click / `Escape`), and in-memory **Referenced By (Backlinks)** (`backlinks-section`) excluding self-links (`n.slug !== current.slug`).
3. **Deepen & Edit Modals (`DeepenNoteModal.tsx`, `EditNoteModal.tsx`, `WikilinkAutocomplete.tsx`):**
   - Triggered by `D` / `E` or header buttons.
   - Displays Socratic Recovery questions inside `DeepenNoteModal` when `status === 'in-reflection'`.
   - Inline `[[` autocomplete popover (`wikilink-autocomplete`, `data-popover="true"`) triggered inside Takeaway / Context / Critique textareas with keyboard/click selection.
   - Enforces `<= 5` Active Behavioral Deltas cap (`deltaStatus === 'active'`), surfacing `deepen-delta-cap-warning` if 5 other notes are already active.
4. **Practice & Snapshot Portability (`src/components/views/PracticeView.tsx`, `ImportConfirmModal.tsx`, `#/practice`):**
   - **Active Behavioral Deltas (`N/5`):** `1` Applied, `2` Missed Trigger (opens inline trigger editor to update `deltaTrigger` on the spot), `3` Didn't Come Up, `Graduate`, `Pause` — appending `DeltaLogs` rows and updating `Notes`.
   - **Paused & Graduated Deltas:** compact archive with `Reactivate` (enforcing `<= 5` active cap).
   - **Takeaway Shuffle:** deterministic daily (`YYYY-MM-DD`) resurfacing of up to 3 cards (`>= 14` days old or `#favorite`/`#favorites`, excluding spoilers, sealed predictions, and `lastReviewedAt === today`), with `Mark Reviewed`.
   - **Unlocked Fiction Predictions:** dedicated section showing unlocked predictions from `finished` fiction books.
   - **JSON Snapshot Backup:** `Export JSON` (`PragyaSnapshot` v1 download) and `Import JSON` (schema validation + `ImportConfirmModal` preview before replacing state).
5. **Complete Keyboard Map & Focus Guard (`src/hooks/useKeyboardShortcuts.ts`):**
   - Full implementation of `⌘K`, `N`, `G S/N/P`, `J/K + Enter`, `Space`, `O`, `D`, `E`, `1/2/3`, `R`, layered `Escape`, strictly guarded when focus is inside `<input>`, `<textarea>`, `<select>`, or `[contenteditable="true"]`.

### Acceptance Criteria (Done)
- [ ] `BookDetailView` refuses backward bookmark movement unless `manual-pos-override-checkbox` is checked; `Mark as Finished` unlocks predictions and removes spoilers.
- [ ] `NoteDetailView` displays persisted `socraticQuestions` for `in-reflection` notes, renders clean single `WHEN`/`DO` prefixes (zero `WHEN WHEN` or `DO DO`), opens `<DriveImage />` lightbox, resolves clickable `[[wikilinks]]`, and computes Backlinks excluding self-links.
- [ ] Typing `[[` in `DeepenNoteModal` / `EditNoteModal` opens `wikilink-autocomplete` and inserts `[[selected-slug]]`.
- [ ] `PracticeView` enforces `<= 5` Active Behavioral Deltas cap across activation, deepening, and reactivation; logs `DeltaLogs` via buttons or keys `1/2/3`; inline-edits `deltaTrigger` on Missed Trigger; renders deterministic Takeaway Shuffle excluding spoilers, sealed predictions, and reviewed-today notes; displays Unlocked Fiction Predictions when a fiction book finishes.
- [ ] JSON Snapshot Export → Import validates schema (`version: 1`, required arrays/fields) and restores full workspace via confirmation modal.
- [ ] Typing `n`, `d`, `e`, `1`, `2`, `3`, `r`, `g` inside any input/textarea never triggers global shortcuts; `Escape` closes popovers/lightboxes before modals before detail back-navigation.

### Required Automated Tests
- **Unit (`tests/unit/m2PracticeAndLinks.test.mjs`):**
  - Takeaway Shuffle determinism (same date = same selection), exclusion of spoilers, sealed predictions, and `lastReviewedAt === today`.
  - Backlinks resolver (extracts `[[slug]]`, excludes self-references, handles duplicate links in one note).
  - Active Delta `<= 5` cap guard on deepen & reactivate.
  - Snapshot schema validator (validates good snapshot, rejects malformed JSON / wrong version / missing arrays).
- **Playwright E2E (`tests/specs/tier3_deepen_spoilers_practice.spec.ts`):**
  - `BookDetailView`: attempt backward bookmark without override (blocked / stays monotonic), check override and reset backward, `Mark as Finished` unlocking `Exhalation: Stories` prediction.
  - `NoteDetailView`: verify Socratic Recovery Banner on `in-reflection` note, deepen with `[[` autocomplete → `atomic`, verify Backlink appears on target note and self-link is excluded, verify single `WHEN`/`DO` text (assert no `WHEN WHEN` / `DO DO`), test lightbox `Space` & `Escape`.
  - `PracticeView`: `1/2/3` keyboard & button check-ins, Missed Trigger inline trigger edit, attempt 6th active delta → cap warning enforced, Graduate + Reactivate, Takeaway Shuffle `Mark Reviewed` removes card for today, Export/Import JSON snapshot roundtrip.
  - Keyboard focus guard test: typing `"ndeg123r"` inside Quick Capture / Edit inputs must not open modals or navigate.

### Checkpoint Gate
- `npm run build`, `npm run lint`, `npm run test:unit`, and full M1 + M2 `npm run test:e2e` pass → commit & push M2 checkpoint.

---

## Milestone 3: `pragya-companion` Skill, CLI Scripts, Docs Export, Full E2E & GitHub Pages CI

### Scope & Deliverables
1. **`pragya-companion` Skill & Python CLI:**
   - `.agents/skills/pragya-companion/SKILL.md`: authoritative skill instructions covering `CAPTURE`, 4-stage `REFLECT` (with hard Stage 2 blocking wait), `RECALL`, lazy `ocr-backfill`, `book-doc-sync`, and idempotent `export-md`. Strictly Pragya-branded.
   - `scripts/pragya_cli.py` (with clean helper module(s) if needed under `scripts/`):
     - Dual backend: `--state-file <json>` (offline/deterministic E2E & unit testing) AND live Google Workspace CLIs (`gsheets`, `gdrive`, `gdocs`) resolving UUID row indices from `A:A` before every update.
     - Subcommands: `capture`, `reflect` (`--stage 1` and `--stage commit`), `recall` (`--mode qa|checkin|shuffle`), `ocr-backfill`, `export-md`, `book-doc-sync`.
     - `export-md`: exports `status == 'atomic'` notes where `!exportedAt || updatedAt > exportedAt` to `<output_dir>/<slug>.md`, prevents duplicate `WHEN`/`DO`, and stamps `metaJson.exportedAt` only after disk write succeeds.
2. **CI/CD & Documentation:**
   - `.github/workflows/deploy.yml` (matching `/tmp/expense-ref/.github/workflows/deploy.yml` with `VITE_BASE_PATH: '/pragya/'`).
   - `README.md` (overview, local setup, Google OAuth & Cloud Console scopes setup, keyboard shortcuts, `pragya-companion` CLI examples, testing instructions).
3. **Full Verification & Visual Audit:**
   - `tests/unit/test_pragya_cli.py` (Python `unittest` covering `capture` monotonic `Math.max` + 30-min session coalescing, 4-stage `reflect` + `<=5` delta cap + fiction spoiler clamping, `recall`, `ocr-backfill`, idempotent `export-md` stamping `exportedAt`, and `book-doc-sync`).
   - `tests/specs/tier4_companion_and_regression.spec.ts` (Playwright verifying UI interoperability with CLI-exported JSON/state, zero duplicate `WHEN`/`DO` in DOM, zero horizontal overflow on `390×844` across all views, dark & light mode parity, strict Pragya branding in rendered DOM/title/storage keys).
   - Live Playwright visual screenshots across Desktop (`1440×900` dark & light) and Mobile (`390×844`), inspected visually to confirm defect fixes.

### Acceptance Criteria (Done)
- [ ] `python3 -m unittest discover -s tests/unit` passes 100%, verifying all 6 `pragya-companion` CLI commands, idempotency of `export-md`, UUID-safe updates, `Math.max` ceiling, 30-min coalescing, and `ocr-backfill`.
- [ ] `npm run build` succeeds with `VITE_BASE_PATH=/pragya/` cleanly.
- [ ] `npm run lint`, `npm run test:unit`, and `npm run test:e2e` pass 100% across Chromium desktop and mobile viewports.
- [ ] Visual inspection of live screenshots confirms:
  - Clean single `WHEN` / `DO` labels (zero `WHEN WHEN` / `DO DO`).
  - Clean 30-day activity dots on `390×844` mobile with zero clipping or horizontal overflow.
  - Strict Pragya branding in code, UI, skills, and docs (zero legacy brand leaks).
- [ ] `.github/workflows/deploy.yml` ready for GitHub Pages deployment on `main`.

### Final Ship Gate
- Clean working tree, all M1–M3 checks green, final commit pushed to `origin/main` (or current branch per orchestrator instructions).
