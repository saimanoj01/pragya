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
- [x] Strictly Pragya-branded across UI, code, storage keys, skill, and docs (zero legacy brand leaks).
- [x] Dark & Light Nebula monochrome theme tokens match `SPEC.md` §3; numeric readouts use `.num`.
- [x] Mobile (`390×844`) `ShelfView` renders all 30 activity dots inside the card width with `scrollWidth <= clientWidth` (zero horizontal overflow) and clean `Add Book` button wrapping (`whitespace-nowrap`).
- [x] `QuickCaptureModal` (`N`) captures Quote + Takeaway + Tags + Spar checkbox + Fiction Prediction checkbox + up to 3 attachments (including `⌘V` image compression `<= 1600px` WebP and Google Doc URL chip auto-detection) and advances book position monotonically (`Math.max`) with 30-min session coalescing.
- [x] `NotesView` filters (`All`, `To Spar`, `Atomic`, `Has Media`, `[[Concepts]]`) and inline Spoiler Shield blur (`note.normalizedPos > book.normalizedPos`) work accurately.
- [x] `GoogleSheetsAdapter` passes mock-fetch/unit verification for: auto-repair of missing tabs/headers, UUID `A:A` resolution before `values.update`, `modifiedTime` `0ms` cache hit on reload, `401` expiry trigger, and `pragya-media-v1` authenticated image cache.

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

### Checkpoint Gate & Status
- `npm run build` (`tsc && vite build`), `npm run lint`, `npm run test:unit`, and M1 `npm run test:e2e` all pass → commit & push M1 checkpoint.
- **M1 Checkpoint Status: PASSED** — `reviewer` (`APPROVE`), `qa` (`PASS`: `npm run build`, `npm run lint`, `10/10` unit tests in `tests/unit/m1Core.test.mjs`, `8/8` Playwright E2E across `tier1_foundation_and_capture.spec.ts` and `tier2_oauth_and_mobile.spec.ts`, including `390×844` mobile overflow checks and regression tests).
- **M1 Baseline Already Landed for M2:**
  - `src/components/views/BridgeViews.tsx` provides temporary M1 preview components (`BookDetailPreview`, `NoteDetailPreview`, `PracticePreview`) wired in `src/App.tsx`.
  - `src/context/PragyaContext.tsx` already implements `advanceBookPosition` (`manualOverride`), `markBookFinished`, `updateNote`, `logDeltaOutcome`, and `replaceWorkspaceFromSnapshot`.
  - Pure utilities already implemented in `src/`: `src/utils/snapshot.ts` (`buildSnapshot`, `validateSnapshotPayload`), `src/utils/wikilinks.ts` (`slugify`, `generateUniqueSlug`, `extractWikilinks`, `extractNoteWikilinks`, `computeBacklinks`), `src/utils/deltaFormat.ts` (`stripDeltaPrefix`, `normalizeDeltaTrigger`, `normalizeDeltaAction`, `formatWhenDoDisplay`), and `src/utils/spoilerMath.ts` (`isNoteSpoiler`, `isSealedPrediction`, `isUnlockedPrediction`).

---

## Milestone 2: Deepening, Spoiler Shield, Wikilinks/Backlinks, Practice & Snapshot Backup

### Scope & Deliverables (Exact Handoff Against M1 Baseline)
1. **Replace Preview Shells & Build Book Drilldown (`src/components/views/BookDetailView.tsx`, `#/book/:id`):**
   - Replace `BookDetailPreview` in `src/components/views/BridgeViews.tsx` (and remove `BridgeViews.tsx` once all three views are updated in `src/App.tsx`).
   - Preserve existing `data-testid`s (`book-detail-view`, `back-to-shelf-btn`, `note-card-{slug}`, `spoiler-shield-{slug}`, `spoiler-reveal-btn-{slug}`) and add: `+10p` advance, `book-detail-advance-input`, `book-detail-advance-btn`, **Manual Bookmark Reset / Override** checkbox (`manual-pos-override-checkbox`) passed as `{ manualOverride: true }` to `PragyaContext.advanceBookPosition`, and **Mark as Finished** (`mark-finished-btn`) calling `PragyaContext.markBookFinished` to unlock sealed fiction predictions and clear spoiler blurs.
   - Ordered book notes list with per-card Spoiler Shield, `J`/`K` selection, `Enter` navigation, and `Space` reveal.
2. **Atomic Note Detail (`src/components/views/NoteDetailView.tsx`, `#/note/:slug`):**
   - Replace `NoteDetailPreview` from `BridgeViews.tsx` while keeping existing `data-testid`s (`note-detail-view`, `back-to-notes-btn`, `socratic-recovery-banner`, `wikilink-chip-{slug}`, `attachment-image-{id}`, `backlinks-section`, `backlink-item-{slug}`).
   - Add header actions: `Edit Note (E)` (`edit-note-btn`) and `Deepen Note (D)` (`deepen-note-btn`), plus a `Continue Deepening →` button inside `socratic-recovery-banner` when `status === 'in-reflection'` and `meta.socraticQuestions` is populated.
   - Render Verbatim Quote, Core Takeaway, clickable `[[wikilinks]]` (via `extractNoteWikilinks`, including a clean missing-target card/action if a `[[slug]]` has no matching note yet), Layer 2 sections (`Context & Mechanism`, Behavioral Delta via `formatWhenDoDisplay` guaranteeing zero `WHEN WHEN` / `DO DO`, `Socratic Critique`), `<DriveImage />` thumbnails opening **`src/components/modals/ImageLightbox.tsx`** (`image-lightbox`, toggled via click/`Space` and closed via `Escape` with `stopPropagation`), and Backlinks via `computeBacklinks` (already excludes self-links).
3. **Deepen & Edit Modals (`src/components/modals/DeepenNoteModal.tsx`, `EditNoteModal.tsx`, `src/components/common/WikilinkAutocomplete.tsx`):**
   - Triggered by `D` / `E` or header buttons.
   - `DeepenNoteModal`: displays persisted `meta.socraticQuestions` above fields when `status === 'in-reflection'`, edits Title/Slug (`generateUniqueSlug(..., excludeSelfSlug)`), Core Takeaway, Context & Mechanism, Behavioral Delta (`deltaTrigger` / `deltaAction` normalized via `normalizeDeltaTrigger` / `normalizeDeltaAction`, `deltaStatus`), Socratic Critique, and upgrades note `status` to `'atomic'`.
   - `EditNoteModal`: edits Layer 1/Layer 2 fields, `slug`, `#tags`, `isPrediction` (for fiction books), and attachments (`<= 3` cap, append-only removal without deleting Drive blobs).
   - `WikilinkAutocomplete`: inline `[[` popover (`wikilink-autocomplete`, `wikilink-option-{slug}`, `data-popover="true"`) inside Takeaway / Context / Critique textareas (excluding current note slug).
   - **Active Delta Cap (`<= 5`):** Enforce `deltaStatus === 'active'` max 5 limit in both `PragyaContext.updateNote` (throwing/surfacing clear error if a 6th distinct note attempts `'active'`) and in `DeepenNoteModal` / `PracticeView` (`deepen-delta-cap-warning`).
4. **Practice & Snapshot Portability (`src/components/views/PracticeView.tsx`, `src/components/modals/ImportConfirmModal.tsx`, `src/utils/takeawayShuffle.ts`, `#/practice`):**
   - Replace `PracticePreview` from `BridgeViews.tsx` while keeping `practice-view`, `active-deltas-section`, `active-deltas-count`, `delta-card-{id}`.
   - **Active Behavioral Deltas (`N/5`):** `delta-apply-btn-{id}` (`1`), `delta-missed-btn-{id}` (`2`, opens inline trigger editor `delta-trigger-edit-input-{id}` + `delta-trigger-save-btn-{id}` normalizing via `normalizeDeltaTrigger`), `delta-notrigger-btn-{id}` (`3`), `delta-graduate-btn-{id}`, `delta-pause-btn-{id}` — logging via `PragyaContext.logDeltaOutcome` and updating note via `PragyaContext.updateNote`.
   - **Paused & Graduated Deltas:** compact archive with `delta-reactivate-btn-{id}` (enforcing `<= 5` active cap).
   - **Takeaway Shuffle (`src/utils/takeawayShuffle.ts`):** deterministic `YYYY-MM-DD` selection of up to 3 eligible notes (`>= 14` days old or `#favorite`/`#favorites`, excluding `isNoteSpoiler`, `isSealedPrediction`, and `meta.lastReviewedAt?.slice(0, 10) === todayDate`), rendered in `takeaway-shuffle-section` (`shuffle-card-{slug}`, `shuffle-review-btn-{slug}` setting `meta.lastReviewedAt` to today).
   - **Unlocked Fiction Predictions:** `unlocked-predictions-section` listing notes matching `isUnlockedPrediction(note, book)` from `src/utils/spoilerMath.ts`.
   - **JSON Snapshot Backup:** Wire `src/utils/snapshot.ts` (`buildSnapshot` → `export-json-btn`; `validateSnapshotPayload` + `import-json-input` → `import-confirm-modal` / `import-confirm-btn` → `PragyaContext.replaceWorkspaceFromSnapshot`). Also wire optional Import JSON alongside Export JSON in `SettingsView.tsx` if desired.
5. **Complete Keyboard Map & Focus Guard (`src/hooks/useKeyboardShortcuts.ts` + `src/App.tsx`):**
   - Extend M1 keyboard handling in `App.tsx` (`⌘K`, `G S/N/P`, `N`, `R`, `Escape`) and `NotesView.tsx` (`J/K/Enter/Space`) into unified shortcut support covering `J/K + Enter` across `BookDetailView` and `PracticeView`, `Space` (`BookDetailView` spoiler reveal + `NoteDetailView` `ImageLightbox`), `O` (open primary Doc/link), `D` (`DeepenNoteModal`), `E` (`EditNoteModal` / `EditBookModal`), `1/2/3` (`PracticeView` check-ins), and strict layered `Escape` (`ImageLightbox` / `[data-popover="true"]` → topmost modal → detail back-navigation) with `isEditableElement` focus guard.

### Acceptance Criteria (Done)
- [x] `BridgeViews.tsx` previews are fully replaced by `BookDetailView.tsx`, `NoteDetailView.tsx`, and `PracticeView.tsx` in `src/App.tsx`.
- [x] `BookDetailView` refuses backward bookmark movement unless `manual-pos-override-checkbox` is checked; `Mark as Finished` unlocks predictions and removes spoilers.
- [x] `NoteDetailView` displays persisted `socraticQuestions` for `in-reflection` notes, renders clean single `WHEN`/`DO` prefixes (zero `WHEN WHEN` or `DO DO`), opens `<DriveImage />` lightbox, resolves clickable `[[wikilinks]]`, and computes Backlinks excluding self-links.
- [x] Typing `[[` in `DeepenNoteModal` / `EditNoteModal` opens `wikilink-autocomplete` and inserts `[[selected-slug]]`.
- [x] `PracticeView` enforces `<= 5` Active Behavioral Deltas cap across activation, deepening, and reactivation (backed by `PragyaContext.updateNote` guard); logs `DeltaLogs` via buttons or keys `1/2/3`; inline-edits `deltaTrigger` on Missed Trigger; renders deterministic Takeaway Shuffle excluding spoilers, sealed predictions, and reviewed-today notes; displays Unlocked Fiction Predictions when a fiction book finishes.
- [x] JSON Snapshot Export → Import validates schema (`validateSnapshotPayload` in `src/utils/snapshot.ts`) and restores full workspace via `ImportConfirmModal`.
- [x] Typing `n`, `d`, `e`, `1`, `2`, `3`, `r`, `g` inside any input/textarea never triggers global shortcuts; `Escape` closes popovers/lightboxes before modals before detail back-navigation.

### Required Automated Tests
- **Unit (`tests/unit/m2PracticeAndLinks.test.mjs`):**
  - Takeaway Shuffle determinism (same date = same selection), exclusion of spoilers, sealed predictions, and `lastReviewedAt === today`.
  - Backlinks resolver (extracts `[[slug]]`, excludes self-references, handles duplicate links in one note).
  - Active Delta `<= 5` cap guard on deepen & reactivate.
  - Snapshot schema validator (`validateSnapshotPayload` validates good snapshot, normalizes `WHEN`/`DO`, rejects malformed JSON / wrong version / missing arrays).
- **Playwright E2E (`tests/specs/tier3_deepen_spoilers_practice.spec.ts`):**
  - `BookDetailView`: attempt backward bookmark without override (blocked / stays monotonic), check override and reset backward, `Mark as Finished` unlocking `Exhalation: Stories` prediction.
  - `NoteDetailView`: verify Socratic Recovery Banner on `in-reflection` note, deepen with `[[` autocomplete → `atomic`, verify Backlink appears on target note and self-link is excluded, verify single `WHEN`/`DO` text (assert no `WHEN WHEN` / `DO DO`), test lightbox `Space` & `Escape`.
  - `PracticeView`: `1/2/3` keyboard & button check-ins, Missed Trigger inline trigger edit, attempt 6th active delta → cap warning enforced, Graduate + Reactivate, Takeaway Shuffle `Mark Reviewed` removes card for today, Export/Import JSON snapshot roundtrip via `ImportConfirmModal`.
  - Keyboard focus guard test: typing `"ndeg123r"` inside Quick Capture / Deepen / Edit inputs must not open modals or navigate.

### Checkpoint Gate & Status
- `npm run build`, `npm run lint`, `npm run test:unit`, and full M1 + M2 `npm run test:e2e` pass → commit & push M2 checkpoint.
- **M2 Checkpoint Status: PASSED** — `reviewer` (`APPROVE`, including audit of `WikilinkAutocomplete.tsx`, `Modal.tsx`, `ImageLightbox.tsx`, `CommandPalette.tsx`, `ImportConfirmModal.tsx`, `NoteDetailView.tsx`, `EditNoteModal.tsx`, `takeawayShuffle.ts`), `qa` (`PASS`: `npm run build` and `VITE_BASE_PATH='/pragya/' npm run build` exit 0, `npm run lint` 0 errors/0 warnings, `npm run test:unit` 14/14 passed, `npm run test:e2e` 12/12 passed across Tier 1/2/3 desktop & mobile `390×844`, 0 legacy brand leaks).
- **Ready Handoff for Milestone 3:** Complete Pragya PWA (`src/utils/snapshot.ts` v1 JSON schema, `Books!A:L` / `Notes!A:R` / `Sessions!A:G` / `DeltaLogs!A:E` codecs, normalized `WHEN`/`DO` delta formatting, `<= 5` active delta cap, and `VITE_BASE_PATH='/pragya/'` build) is verified and ready for `pragya-companion` (`SKILL.md` + `scripts/pragya_cli.py`), `.github/workflows/deploy.yml`, `README.md`, Tier 4 E2E + Python `unittest` suites, and final desktop/mobile screenshot verification.

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
- [x] `python3 -m unittest discover -s tests/unit` passes 100%, verifying all 6 `pragya-companion` CLI commands, idempotency of `export-md`, UUID-safe updates, `Math.max` ceiling, 30-min coalescing, and `ocr-backfill`.
- [x] `npm run build` succeeds with `VITE_BASE_PATH=/pragya/` cleanly.
- [x] `npm run lint`, `npm run test:unit`, and `npm run test:e2e` pass 100% across Chromium desktop and mobile viewports.
- [x] Visual inspection of live screenshots confirms:
  - Clean single `WHEN` / `DO` labels (zero `WHEN WHEN` / `DO DO`).
  - Clean 30-day activity dots on `390×844` mobile with zero clipping or horizontal overflow.
  - Strict Pragya branding in code, UI, skills, and docs (zero legacy brand leaks).
- [x] `.github/workflows/deploy.yml` ready for GitHub Pages deployment on `main`.

### Final Ship Gate
- Clean working tree, all M1–M3 checks green, final commit pushed to `origin/main` (or current branch per orchestrator instructions).
- **M3 Checkpoint & Final Ship Status: PASSED** — `reviewer` (`APPROVE`, including verification of all 4 security/port/AST blockers and 6 hardening nits across `scripts/pragya_cli.py`, `README.md`, `.agents/skills/pragya-companion/`, `.github/workflows/deploy.yml`, `tests/unit/test_pragya_cli.py`, and `tests/specs/tier4_companion_and_regression.spec.ts`), `qa` (`PASS` across all M1–M3 gates: `python3 -m unittest discover -s tests/unit -v` `7/7` passed; `npm run build` & `VITE_BASE_PATH='/pragya/' npm run build` exit `0`; `npm run lint` `0` errors / `0` warnings; `npm run test:unit` `14/14` passed; `npm run test:e2e` `14/14` passed across Tiers 1–4 Desktop & Mobile `390×844` Dark/Light; `~/.gemini/skills/pragya-companion/SKILL.md` installed; `0` legacy brand leaks; live Light/Dark/Mobile/CLI-synced screenshots visually verified).

