# Pragya — Engineering Specification Sheet (M4–M6 Roadmap)

> **Prepared by:** Product Management (`pm`) & UX Product Management (`ux_pm`)  
> **Target Baseline:** `saimanoj01/pragya` on `main` (`7e417ab`) · Companion to [SPEC.md](file:///home/antigravity/saimanoj01/pragya/docs/SPEC.md) & [MILESTONES.md](file:///home/antigravity/saimanoj01/pragya/docs/MILESTONES.md)  
> **Scope Boundary:** Implementation handoff for engineering. **Zero source edits have been made in this repository.**

---

## 1. Executive Priority Matrix

| Tier | Theme | Core Outcomes | Ship Blocker? |
|---|---|---|---|
| **M4 · P0** | **Release, A11y, Offline Safety & Trust** | WCAG AA contrast tokens (`--faint` + `.light` semantic colors), form/modal a11y, calm `toast` classification, OAuth setup guide & route recovery, offline read-only cache fallback, `PROD`-only PWA app shell, silent debounced draft autosave (preserving `Escape`), write-first snapshot import + backup, `preserveUpdatedAt` on `Mark Reviewed`, pre-write row conflict guard, PWA↔CLI parity fixes, Node 24/Python CI gates. | **Yes** (blocks public multi-device rollout) |
| **M5 · P1** | **Daily Flow & Mobile Ergonomics** | Mobile bottom-sheet `QuickCaptureModal` + Kindle paste parser + empty-shelf CTA, `ShelfView` `>=44px` hit targets + select-on-focus, `DeepenNoteModal` quote context + Save Draft, `PracticeView` honest empty shuffle copy + non-blocking "Checked in today" badge, compensating `ToastAction` Undo (bookmark advances, `Mark Finished`, `Graduate`/`Pause`, `Mark Reviewed`), grouped `CommandPalette` + mobile entry, PR `e2e.yml` workflow. | No (next sprint after M4) |
| **M6 · P2** | **Knowledge Graph, Keyboard Polish & CLI Write Gate** | Pre-filled missing `[[slug]]` capture, clickable `#tag` cross-filter routing (`#/notes?tag=...`), mobile-safe `WikilinkAutocomplete` tap fix, fiction-collapsed Behavioral Delta + `Save & Next in Inbox`, `J`/`K` `scrollIntoView`, `?` Shortcuts Help modal, live `gsheets mutate batch` audit before any `raw-batch` migration. | No |
| **P3** | **Deferred Backlog** | IndexedDB offline write outbox + visual conflict merge modal, optional Google Picker `drive.file`-only migration, soft-archive / undoable entity delete, interactive `[[wikilink]]` graph canvas, optional book cover art / WASM OCR / Demo merge. | Trigger-gated only |
| **Cut** | **Permanent Anti-Features** | In-app LLM calls / API keys, browser mic/audio UI, timers/stopwatches/streaks/overdue SRS queues, push/email nags, Google Calendar sync, bidirectional Markdown sync, browser Drive `DELETE`. | **Never build** |

---

## 2. PM vs. UX PM Adjudication & Convergence Log (D1–D7)

| ID | Topic | Trade-off Evaluated | Final Converged Decision |
|---|---|---|---|
| **D1** | **`drive.readonly` Scope & OAuth Onboarding** | Narrowing OAuth now via Google Picker vs. keeping `drive.readonly` + upgrading onboarding transparency. Migrating immediately breaks automatic discovery of sheets/media/Doc titles created externally by [pragya_cli.py](file:///home/antigravity/saimanoj01/pragya/scripts/pragya_cli.py) without complex Picker UX and heavy Drive API rewrites. | **Keep all 5 scopes** in [AuthContext.tsx](file:///home/antigravity/saimanoj01/pragya/src/context/AuthContext.tsx#L22-L28). Fix the missing-Client-ID error toast trap and embed a copyable **Google OAuth Setup Guide** (origin, redirect URI, enabled APIs, `drive.readonly` explanation) inside [LoginView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/LoginView.tsx) and [SettingsView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/SettingsView.tsx). Defer Picker to **P3**. |
| **D2** | **OAuth Route Recovery, Offline Mode, Draft Autosave & PWA Shell** | (a) Blocking `Escape` with confirm-discard vs. instant `Escape` + silent draft autosave (`tier3` requires `Escape` to dismiss immediately). (b) Deferring PWA `manifest.webmanifest` + Service Worker vs. shipping an installable offline shell in M4. | (a) **Adjudicated into M4 P0:** Restore pre-login hash route on OAuth return; return `pragya_sheets_cache_v1` in read-only mode on network errors; add **silent debounced `localStorage` draft autosave** with `"Draft restored · Discard"` pill while keeping `Escape` instant. (b) Ship static app-shell `manifest.webmanifest` + `import.meta.env.PROD`-only `sw.js` in **M4 P0** so "Offline Read-Only" works on installed mobile PWAs. Defer IndexedDB write outbox to **P3**. |
| **D3** | **Contrast, A11y, Toast Classification, Import Safety & Undo Scope** | Delaying mutations behind toast countdowns vs. immediate writes + compensating `Undo` actions; adding Undo to `1/2/3` delta check-ins vs. keeping fast 1-tap logging. | **M4 P0:** Fix `--faint` (dark/light) & `.light` semantic contrast, bind `aria-labelledby` & `htmlFor`/`id`, make 3-col book forms responsive (`grid-cols-1 sm:grid-cols-3`), fix false-positive error regex & neutral `'info'` styling in [toast.tsx](file:///home/antigravity/saimanoj01/pragya/src/utils/toast.tsx#L21-L37), reorder `batchUpdate` before trailing `batchClear`, auto-save pre-import backup, align position clamp & `queued -> reading` parity. **M5 P1:** Immediate-commit + `ToastAction` Undo for bookmark advances, `Mark Finished`, `Graduate`/`Pause`, and `Mark Reviewed`. **Explicitly exclude `1/2/3` Delta check-ins** from Undo. |
| **D4** | **`preserveUpdatedAt`, Conflict Guard & CLI Value Handling** | Heavyweight Drive Etags/merge UI vs. lightweight pre-write row timestamp guard; rewriting `_batch_write` blindly vs. verifying live CLI `USER_ENTERED` coercion first. | **M4 P0:** Preserve `updatedAt` on `Mark Reviewed` in both PWA ([PragyaContext.tsx](file:///home/antigravity/saimanoj01/pragya/src/context/PragyaContext.tsx#L442-L492), [PracticeView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/PracticeView.tsx#L206-L219)) and CLI ([pragya_cli.py](file:///home/antigravity/saimanoj01/pragya/scripts/pragya_cli.py#L1665-L1677)) so `export-md` isn't tricked; enforce lightweight row `updatedAt` stale-write check before row overwrites; add `UNFORMATTED_VALUE` on Sheets & CLI reads. **M6 P2:** Audit live `gsheets mutate batch` formula/date coercion before touching tested `batch` contracts in [test_pragya_cli.py](file:///home/antigravity/saimanoj01/pragya/tests/unit/test_pragya_cli.py#L1023-L1110). |
| **D5** | **CI/CD & Live Pages** | Running slow Playwright E2E on every deploy push vs. splitting fast Node/Python verification on deploy from PR/manual E2E. | **M4 P0:** Upgrade [deploy.yml](file:///home/antigravity/saimanoj01/pragya/.github/workflows/deploy.yml) to Node 24 + Python 3.12 with `npm run lint`, `npm run test:unit`, and `python3 -m unittest discover -s tests/unit -v` before build. **M5 P1:** Add `.github/workflows/e2e.yml` on `pull_request` + `workflow_dispatch`. |
| **D6–D7** | **Scope Discipline** | Bundling graph canvas, deletions, and write outbox early vs. keeping Pragya fast, quiet, and single-maintainer reliable. | Partition strictly into **M4 (P0)**, **M5 (P1)**, **M6 (P2)**; gate **P3** items behind measurable usage triggers; lock anti-feature cuts permanently. |

---

## 3. Non-Negotiable Invariants & Preserved Contracts

> [!IMPORTANT]
> Every change in M4–M6 MUST uphold the locked contracts in [SPEC.md](file:///home/antigravity/saimanoj01/pragya/docs/SPEC.md#L7-L19) and pass existing suites without weakening test assertions:
> 1. **Zero In-App AI & Zero Voice Recording UI:** No LLM calls, API key prompts, or custom mic buttons inside the PWA.
> 2. **Locked Google Sheet Schema:** `Books!A:L`, `Notes!A:R`, `Sessions!A:G`, `DeltaLogs!A:E`, [`PragyaSnapshot`](file:///home/antigravity/saimanoj01/pragya/docs/SPEC.md#L280-L287) `version: 1`, and canonical **Pragya** naming.
> 3. **Monotonic Spoiler Math & `<= 5` Active Delta Cap:** Preserved identically across PWA and [pragya_cli.py](file:///home/antigravity/saimanoj01/pragya/scripts/pragya_cli.py).
> 4. **Zero `WHEN WHEN` / `DO DO` Render/Write Leaks** and **Zero Drive `DELETE` Calls** (`Notes.meta.attachments` remains append-only in Drive).

### Automated Test Contracts Engineering Must Preserve

| Suite | Critical Existing Behavior / Assertion to Protect |
|---|---|
| [tier1_foundation_and_capture.spec.ts](file:///home/antigravity/saimanoj01/pragya/tests/specs/tier1_foundation_and_capture.spec.ts#L114-L165) | Concurrent same-tick `advance-10p-btn-{id}` + `advance-exact-btn-{id}` clicks coalesce cleanly without duplicate sessions. `QuickCaptureModal` (`capture-book-select` non-prose paste target) handles global URL/image paste; any autofocus change in M5 MUST NOT steal paste flow or hide `capture-book-select`. |
| [tier2_oauth_and_mobile.spec.ts](file:///home/antigravity/saimanoj01/pragya/tests/specs/tier2_oauth_and_mobile.spec.ts#L252-L450) | `pragya_oauth_csrf_state` validation, default `#/shelf` landing when invoked from `LoginView`, `pragya-media-v1` Cache API synthetic keys (`https://pragya.local/drive-media/{id}`), 401 `session-expired-modal` switching cleanly to Demo Mode, zero horizontal overflow on `390x844` across all views and `activity-dots`. |
| [tier3_deepen_spoilers_practice.spec.ts](file:///home/antigravity/saimanoj01/pragya/tests/specs/tier3_deepen_spoilers_practice.spec.ts#L101-L269) | Instant `Escape` dismissal on `QuickCaptureModal` (`L213-L214`), `EditNoteModal` (`L124-L125`), and `DeepenNoteModal` (`L160-L163` closes popover before modal); single `'atomic'` submit behavior on `deepen-submit-btn` (`L179-L182`); immediate `deltaLogs` creation on `1`/`2`/`3` check-ins (`L216-L269`). |
| [m1Core.test.mjs](file:///home/antigravity/saimanoj01/pragya/tests/unit/m1Core.test.mjs#L704-L966) | `GoogleSheetsAdapter` mocked `fetch` tests expect `values:batchGet` query strings to contain `Books!A%3AL` (`L733`, `L887`, `L963`) and `A1%3AL1` (`L874`); query additions must append after `ranges=...`. |
| [test_pragya_cli.py](file:///home/antigravity/saimanoj01/pragya/tests/unit/test_pragya_cli.py#L996-L1110) | Live backend runner asserts `cmd[:3] == ["gsheets", "readonly", "read"]` with `cmd[4] == range_a1` (`L997`). In M4–M5 `_batch_write` retained `gsheets mutate batch` with `"op"` + `"data"` (`L1074-L1110`). **Superseded (M6 Track B, B1.1):** `_batch_write` is removed; every Sheet write goes through `GoogleWorkspaceBackend._write_cells` → `gsheets mutate raw-batch` (`updateCells`/`appendCells`, `userEnteredValue.stringValue\|numberValue`), and the mocked runners decode the raw-batch request back to `{op, range, data}` so the original assertions still hold. |

---

## 4. Milestone M4 (P0) — Release Readiness, Accessibility, Offline Safety & Trust

### M4.1 — WCAG AA Contrast Tokens & Typography Spec Sync
- **Files:** [src/index.css](file:///home/antigravity/saimanoj01/pragya/src/index.css#L6-L70), [SPEC.md](file:///home/antigravity/saimanoj01/pragya/docs/SPEC.md#L68-L86)
- **Changes:** Update HSL tokens in [src/index.css](file:///home/antigravity/saimanoj01/pragya/src/index.css#L20-L68) and mirror exact values in [SPEC.md](file:///home/antigravity/saimanoj01/pragya/docs/SPEC.md#L78-L84):

| CSS Token | Theme Scope | Current Value | New WCAG AA Value | Target Ratio |
|---|---|---|---|---|
| `--faint` | `:root, .dark` (`L20`) | `222 6% 44%` | `222 7% 55%` | `>= 4.94:1` on `--surface-2` |
| `--faint` | `.light` (`L53`) | `222 5% 56%` | `222 6% 43%` | `>= 4.87:1` on `--surface-2` |
| `--c-nonmonthly` (`warning`) | `.light` (`L66`) | `36 84% 43%` | `36 90% 28%` | `>= 4.5:1` on `--card` & tint pills |
| `--c-saved` (`positive`) | `.light` (`L67`) | `156 80% 36%` | `156 84% 24%` | `>= 4.5:1` on `--card` & tint pills |
| `--destructive` & `--c-negative` | `.light` (`L61, L68`) | `357 70% 54%` | `357 72% 41%` | `>= 4.5:1` on `--card` & tint pills |

- **Acceptance Criteria:** Automated contrast check (Playwright/Axe or computed luminance check) confirms `>= 4.5:1` for normal text on `--card` and `--surface-2` in both `.dark` and `.light` across `NotesView`, `BookDetailView`, and `PracticeView` badges/buttons.

### M4.2 — Modal, Form & Mobile Grid Accessibility
- **Files:** [Modal.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/common/Modal.tsx#L139-L155), [AddBookModal.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/modals/AddBookModal.tsx#L83-L217), [EditBookModal.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/modals/EditBookModal.tsx#L83-L207), [QuickCaptureModal.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/modals/QuickCaptureModal.tsx#L308-L407), [DeepenNoteModal.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/modals/DeepenNoteModal.tsx#L190-L399), [EditNoteModal.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/modals/EditNoteModal.tsx#L353-L470), [ShelfView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/ShelfView.tsx#L177-L190)
- **Changes:**
  1. In [`Modal`](file:///home/antigravity/saimanoj01/pragya/src/components/common/Modal.tsx#L17-L28), accept optional `headingId?: string` (or provide a `useId()` heading id via context/render convention) and attach `aria-labelledby={headingId}` when rendered, keeping `ariaLabel || title || 'Dialog'` fallback when no visible heading element exists.
  2. Add unique `useId()`-based `htmlFor` + `id` bindings on every `<label>` + `<input>`/`<select>`/`<textarea>` pair across all 5 form modals.
  3. Change `grid-cols-3 gap-3` -> `grid-cols-1 sm:grid-cols-3 gap-3` in [AddBookModal.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/modals/AddBookModal.tsx#L121) (`L121`, `L164`) and [EditBookModal.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/modals/EditBookModal.tsx#L119) (`L119`, `L159`) so `390x844` mobile viewports never cramp Format/Kind/Status or Pos/Total/Unit controls.
  4. Add explicit `aria-label={`${day.date}: ${day.count} session${day.count === 1 ? '' : 's'}`}` and `role="img"` (or `aria-hidden="true"` inside an `aria-label` summary container if preferred; per-dot `aria-label` preserves screen-reader day inspection) to `activity-dot-${idx}` in [ShelfView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/ShelfView.tsx#L177-L190).
- **Acceptance Criteria:** Zero unlabeled form controls in all 5 modals; `390px` viewport renders stacked `AddBookModal`/`EditBookModal` controls cleanly; screen-reader accessible labels present on activity dots.

### M4.3 — Semantic Toast Classification
- **File:** [toast.tsx](file:///home/antigravity/saimanoj01/pragya/src/utils/toast.tsx#L16-L58)
- **Changes:**
  1. Remove regex override `/fail|error|denied|offline|exceeded|cannot|invalid/i.test(message)` (`L23`) so `showToast` trusts the explicit `type: ToastType` (`'success' | 'error' | 'info'`) passed by callers.
  2. Render distinct calm `'info'` styling (e.g., `notification-info bg-popover/95 border-border text-foreground` with neutral indicator dot and border-styled `ToastAction` button) instead of sharing green emerald `notification-success` styling (`L29-L33`).
  3. Keep `.notification-error` for `type === 'error'` and `.notification-success` for `type === 'success'`, preserving `data-testid="notification-toast"` and `data-testid={options.action.testId || 'toast-action-btn'}`.
- **Acceptance Criteria:** `showToast('Captured "Failure Mode"', 'success')` renders `.notification-success`; `showToast('Marked paused', 'info')` renders neutral `.notification-info`; `type === 'error'` renders `.notification-error`.

### M4.4 — OAuth Pre-Login Route Recovery & Guided Setup
- **Files:** [AuthContext.tsx](file:///home/antigravity/saimanoj01/pragya/src/context/AuthContext.tsx#L202-L374), [LoginView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/LoginView.tsx#L53-L120), [SettingsView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/SettingsView.tsx#L172-L196)
- **Changes:**
  1. **Route Recovery (`AuthContext`):** Export `OAUTH_RETURN_ROUTE_KEY = 'pragya_oauth_return_route'`. In [`login`](file:///home/antigravity/saimanoj01/pragya/src/context/AuthContext.tsx#L323-L374), before redirecting, if `window.location.hash` is a non-empty valid app route (`!isOAuthCallbackHash(hash)` and `hash !== '#'` and `hash !== '#/'`), save it to `sessionStorage`. In [`handleHashAuth`](file:///home/antigravity/saimanoj01/pragya/src/context/AuthContext.tsx#L287-L291), read & remove `OAUTH_RETURN_ROUTE_KEY` and set `window.location.hash` to the validated `#/...` route, falling back to `'#/shelf'` (preserving [`tier2_oauth_and_mobile.spec.ts#L268`](file:///home/antigravity/saimanoj01/pragya/tests/specs/tier2_oauth_and_mobile.spec.ts#L268) and `#L430` `SettingsView` re-auth behavior).
  2. **Suppress Missing-Client-ID Error Toast (`AuthContext` & `LoginView`):** When `login()` is called without a resolved Client ID ([`AuthContext.tsx#L324-L328`](file:///home/antigravity/saimanoj01/pragya/src/context/AuthContext.tsx#L324-L328)), throw or return a structured status without firing `'error'` toast; in [LoginView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/LoginView.tsx#L58-L63), open `showClientConfig`, scroll/focus `client-id-input`, and show a calm inline prompt (`"Paste your Google OAuth Client ID below or explore offline in Demo Mode."`). Keep `data-testid="client-id-input"`, `client-id-save-btn`, and `settings-client-id-input`.
  3. **Inline OAuth Setup Guide (`LoginView` & `SettingsView`):** Inside the Client ID collapsible/card, display copy-to-clipboard values computed dynamically from runtime URL:
     - **Authorized JavaScript Origin:** `window.location.origin`
     - **Authorized Redirect URI:** `window.location.origin + window.location.pathname`
     - **Required GCP APIs:** `Google Sheets API`, `Google Drive API` (+ `Google Docs API` if using `pragya-companion` CLI)
     - **Testing Mode Reminder:** Add your Google email under OAuth Consent Screen -> Test Users.
     - **Plain-English Scope Note (`drive.readonly`):** Explain clearly that `drive.readonly` is required so the PWA can read `Pragya Commonplace` Sheet `modifiedTime`, load images uploaded by `pragya-companion` in `Pragya Media/`, and resolve Google Doc titles.
- **Acceptance Criteria:** Initiating Google login from `#/practice` or after 401 on `#/settings` returns to `#/practice` / `#/settings` post-auth; logging in from fresh `LoginView` lands on `#/shelf`; clicking Sign in without Client ID opens guided setup without red error toast.

### M4.5 — Offline Cached Read-Only Fallback & Foreground Sync
- **Files:** [storage.ts](file:///home/antigravity/saimanoj01/pragya/src/services/storage.ts#L47-L55), `src/types/pragya.ts`, [googleSheetsAdapter.ts](file:///home/antigravity/saimanoj01/pragya/src/services/googleSheetsAdapter.ts#L371-L407), [PragyaContext.tsx](file:///home/antigravity/saimanoj01/pragya/src/context/PragyaContext.tsx#L145-L200), [AuthContext.tsx](file:///home/antigravity/saimanoj01/pragya/src/context/AuthContext.tsx#L300-L306), [Sidebar.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/layout/Sidebar.tsx), [BottomNav.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/layout/BottomNav.tsx), [SettingsView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/SettingsView.tsx)
- **Changes:**
  1. Add `isOfflineReadOnly?: boolean` to [`WorkspaceState`](file:///home/antigravity/saimanoj01/pragya/src/services/storage.ts#L47) (`src/types/pragya.ts`) and expose `isOfflineReadOnly` on [`PragyaContextValue`](file:///home/antigravity/saimanoj01/pragya/src/context/PragyaContext.tsx#L64-L95).
  2. In [`GoogleSheetsAdapter.loadWorkspace`](file:///home/antigravity/saimanoj01/pragya/src/services/googleSheetsAdapter.ts#L371-L407):
     - On network failure during Drive `modifiedTime` check OR `discoverOrCreateSpreadsheet()` / `batchGet` (strictly excluding `401`, `403`, `404`, and `meta.trashed`), if `knownId && cached && cached.spreadsheetId === knownId && cached.state` exists in `pragya_sheets_cache_v1`, return `{ ...cached.state, spreadsheetId: knownId, modifiedTime: cached.modifiedTime, mediaFolderId: cached.mediaFolderId, isOfflineReadOnly: true }`.
     - If `!options.forceRefresh` threw no cache match, surface the real error. If `options.forceRefresh` fails due to network while cached state is already loaded, keep state loaded with `isOfflineReadOnly = true` and toast `'Still offline — showing cached data'` (`'info'`).
  3. **Read-Only Guard (Cloud Mode Only):** When `!isMockMode && isOfflineReadOnly`, show a calm ambient indicator (`data-testid="offline-readonly-badge"`, `"Offline · Cached Read-Only"`) in `Sidebar`, `BottomNav`/header banner, and `SettingsView`, and guard Cloud write mutations (`addBook`, `updateBook`, `advanceBookPositionInternal`, `startReadingBook`, `markBookFinished`, `captureNote`, `updateNote`, `logDeltaOutcome`, `replaceWorkspaceFromSnapshot`) with a clear error before mutation: `"Cloud sync is read-only while offline. Reconnect to save changes or try Demo Mode."` **Demo Mode (`isMockMode === true`) remains 100% writable offline.**
  4. **Calm Offline Listener & Visibility Sync:**
     - Replace automatic `'error'` toast in [`AuthContext.tsx#L300-L306`](file:///home/antigravity/saimanoj01/pragya/src/context/AuthContext.tsx#L300-L306) on `window` `'offline'` event: suppress in Demo Mode (`isMockMode`) and show calm `'info'` toast (`"Offline — viewing cached reading data"`) in Cloud Mode; trigger `syncNow(false)` on `window` `'online'` & `document` `'visibilitychange'` (`!document.hidden`) when `isAuthenticated && !isMockMode && navigator.onLine`.
- **Acceptance Criteria:** Going offline in Cloud Mode with populated `pragya_sheets_cache_v1` loads Shelf/Notes/Practice read-only (`isOfflineReadOnly === true`), renders existing `<DriveImage />` from `pragya-media-v1`, blocks cloud mutations cleanly without clearing cache, and refreshes automatically upon returning online; `401`/`403`/`404`/trashed-sheet paths remain unchanged and still pass [m1Core.test.mjs](file:///home/antigravity/saimanoj01/pragya/tests/unit/m1Core.test.mjs#L819-L970).
- **M6 update (A5.3):** cache entries now carry `codecVersion: 2` (key name `pragya_sheets_cache_v1` unchanged). The `modifiedTime` fast-reload hit requires v2; a legacy cache forces a `values:batchGet` re-decode and is rewritten as v2. The offline read-only fallback above still accepts a legacy cache.

### M4.6 — Installable PWA App Shell (Production-Scoped)
- **Files:** `public/manifest.webmanifest` (new), `public/sw.js` (new), `public/icon-192.png` + `public/icon-512.png` + `public/apple-touch-icon.png` (new PNG icons exported from `public/lotus.svg`), [index.html](file:///home/antigravity/saimanoj01/pragya/index.html#L4-L12), `src/main.tsx`
- **Changes:**
  1. Add `public/manifest.webmanifest` using relative sub-path URLs so `./` local and `/pragya/` GitHub Pages both resolve cleanly:
     - `name: "Pragya"`, `short_name: "Pragya"`, `start_url: "./"`, `scope: "./"`, `display: "standalone"`, `background_color: "#0B0C0F"`, `theme_color: "#0B0C0F"`, PNG `192x192`, `512x512` (`any` + `maskable`), and `lotus.svg`.
  2. Link `<link rel="manifest" href="./manifest.webmanifest" />`, `<meta name="theme-color" content="#0B0C0F" />`, and Apple Web App meta tags in [index.html](file:///home/antigravity/saimanoj01/pragya/index.html#L5-L8).
  3. Add minimal app-shell Service Worker (`public/sw.js`), registered in `src/main.tsx` **strictly guarded by `if (import.meta.env.PROD && 'serviceWorker' in navigator)`** using `${import.meta.env.BASE_URL}sw.js`:
     - App-shell static assets & navigation fallback to cached `./index.html`.
     - **Hard Bypass Rules:** Never intercept cross-origin Google APIs (`googleapis.com`, `accounts.google.com`, `oauth2.googleapis.com`), and never interfere with the [`DriveImage`](file:///home/antigravity/saimanoj01/pragya/docs/SPEC.md#L336) `pragya-media-v1` Cache API (`https://pragya.local/drive-media/*`).
- **Acceptance Criteria:** Production bundle (`VITE_BASE_PATH='/pragya/' npm run build`) serves valid manifest, icons, and `sw.js` scoped to `/pragya/`; installed standalone PWA boots app shell offline; dev-mode Playwright E2E (`vite --port 3000`) never registers `sw.js` so route mocks stay 100% deterministic.

### M4.7 — Silent Debounced Draft Autosave (Preserving Instant `Escape`)
- **Files:** [QuickCaptureModal.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/modals/QuickCaptureModal.tsx), [DeepenNoteModal.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/modals/DeepenNoteModal.tsx), [EditNoteModal.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/modals/EditNoteModal.tsx), `src/utils/draftStorage.ts` (new helper)
- **Contract Rule:** Do **NOT** block `Escape` or backdrop click dismissal in [Modal.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/common/Modal.tsx#L85-L99) (preserves [`tier3#L207-L214`](file:///home/antigravity/saimanoj01/pragya/tests/specs/tier3_deepen_spoilers_practice.spec.ts#L207-L214)).
- **Changes:**
  1. Debounce (`250ms`) dirty form text fields to `localStorage`:
     - `QuickCaptureModal`: key `pragya_draft_capture_v1` (stores `bookId`, `pos`, `quote`, `takeaway`, `tagsRaw`, `sparLater`, `isPrediction`; never raw image blobs).
     - `DeepenNoteModal`: key `pragya_draft_deepen_${note.id}` (stores `baseUpdatedAt`, `title`, `slug`, `takeaway`, `contextMechanism`, `deltaTrigger`, `deltaAction`, `deltaStatus`, `critique`). Clear stale draft automatically if `note.updatedAt > draft.baseUpdatedAt`.
     - `EditNoteModal`: key `pragya_draft_edit_${note.id}` (stores `baseUpdatedAt` + editable text fields).
  2. On reopen when a valid draft exists (and note wasn't modified remotely since draft save), auto-populate draft fields and display a compact `"Draft restored · Discard"` banner at the top of the modal (`Discard` clears the draft key and resets to canonical state).
  3. Clear the draft key on successful submit.
  4. Attach a `beforeunload` warning only when a modal is currently open with unpersisted dirty input (guards accidental tab close).
- **Acceptance Criteria:** Closing `QuickCaptureModal` via `Escape` keeps `quick-capture-modal` hidden immediately (`tier3` stays green); reopening within the same or reloaded browser session restores typed takeaway/quote with `Discard` button; submitting clears draft cleanly.

### M4.8 — Write-Before-Clear Snapshot Import & Pre-Import Safety
- **Files:** [googleSheetsAdapter.ts](file:///home/antigravity/saimanoj01/pragya/src/services/googleSheetsAdapter.ts#L622-L664), [PragyaContext.tsx](file:///home/antigravity/saimanoj01/pragya/src/context/PragyaContext.tsx#L513-L528), [ImportConfirmModal.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/modals/ImportConfirmModal.tsx#L13-L114), [SettingsView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/SettingsView.tsx#L198-L258)
- **Changes:**
  1. **Write-Before-Clear in [`GoogleSheetsAdapter.replaceWorkspace`](file:///home/antigravity/saimanoj01/pragya/src/services/googleSheetsAdapter.ts#L622-L664):**
     - Before mutating, fetch current row counts across `Books!A:A`, `Notes!A:A`, `Sessions!A:A`, `DeltaLogs!A:A` via `values:batchGet` (`majorDimension=ROWS`).
     - Execute `POST .../values:batchUpdate` (`valueInputOption=RAW`) writing headers + all new rows from `A1` **first**.
     - Only if any tab previously had `oldRowCount > newTotalRowCount` (header + data rows), execute `values:batchClear` strictly on trailing stale rows (`${tab}!A${newTotalRowCount + 1}:${lastCol}${oldRowCount}`). Never wipe `A2:...` before writing new rows.
  2. **Automatic Pre-Import Snapshot Backup:** Inside [`replaceWorkspaceFromSnapshot`](file:///home/antigravity/saimanoj01/pragya/src/context/PragyaContext.tsx#L513-L528), serialize `buildSnapshot({ books: booksRef.current, notes: notesRef.current, sessions: sessionsRef.current, deltaLogs: deltaLogsRef.current })` to `localStorage('pragya_pre_import_backup_v1')` **before** invoking `adapter.replaceWorkspace`.
  3. In [ImportConfirmModal.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/modals/ImportConfirmModal.tsx#L56-L91), show an optional **"Download current workspace backup first"** secondary button/checkbox. In [SettingsView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/SettingsView.tsx#L212-L236), surface **"Restore Last Pre-Import Backup"** when `pragya_pre_import_backup_v1` exists.
- **Acceptance Criteria:** Simulated failure during `values:batchUpdate` leaves existing Google Sheet rows intact (zero blank-sheet wipe); shrinking a workspace from 10 notes to 3 clears only `Notes!A5:R11`; pre-import local backup allows 1-click rollback.

### M4.9 — Data Fidelity: `preserveUpdatedAt`, Conflict Guard & PWA↔CLI Parity
- **Files:** [PragyaContext.tsx](file:///home/antigravity/saimanoj01/pragya/src/context/PragyaContext.tsx#L383-L492), [PracticeView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/PracticeView.tsx#L206-L219), [EditNoteModal.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/modals/EditNoteModal.tsx#L278-L282), [sessionCoalesce.ts](file:///home/antigravity/saimanoj01/pragya/src/utils/sessionCoalesce.ts#L83-L92), [googleSheetsAdapter.ts](file:///home/antigravity/saimanoj01/pragya/src/services/googleSheetsAdapter.ts#L409-L539), [pragya_cli.py](file:///home/antigravity/saimanoj01/pragya/scripts/pragya_cli.py#L972-L1051)
- **Changes:**
  1. **`preserveUpdatedAt` on `Mark Reviewed`:**
     - Add options param to [`PragyaContext.updateNote`](file:///home/antigravity/saimanoj01/pragya/src/context/PragyaContext.tsx#L442-L492): `(note: Note, options?: { preserveUpdatedAt?: boolean; expectedBaseUpdatedAt?: string }) => Promise<Note>`. When `options?.preserveUpdatedAt` is true, preserve `note.updatedAt` instead of overwriting with `nowIso`.
     - Pass `{ preserveUpdatedAt: true }` in [`PracticeView.handleMarkReviewed`](file:///home/antigravity/saimanoj01/pragya/src/components/views/PracticeView.tsx#L206-L219).
     - Remove `updated["updatedAt"] = now_iso_utc()` in [`pragya_cli.py` `cmd_recall`](file:///home/antigravity/saimanoj01/pragya/scripts/pragya_cli.py#L1667-L1673) (`--mode shuffle --mark-reviewed` updates only `metaJson.lastReviewedAt`). (`cmd_ocr_backfill` keeps bumping `updatedAt` intentionally so OCR-backfilled quotes trigger `.md` re-export.)
  2. **Pre-Write Row-Level Conflict Guard (Cloud PWA + Live CLI):**
     - Pass `expectedBaseUpdatedAt` (from the loaded `note.updatedAt` / `book.meta.updatedAt`) down through `GoogleSheetsAdapter.saveNote` / `saveBook` and `GoogleWorkspaceBackend.save_note` / `save_book` (when `--force` is not set).
     - During UUID lookup on update (when row exists at `sheetRowNumber`), inspect the remote timestamp column (`Notes!E` for `updatedAt`; `Books!L` `metaJson.updatedAt`) using targeted range read `A:E` / `A:L` (or `batchGet([A:A, E:E])`). If remote `updatedAt > expectedBaseUpdatedAt`: **abort overwrite** cleanly and surface an actionable error (`"Updated on another device — run Sync Now before saving"` in PWA, keeping draft intact; non-zero exit in CLI unless `--force`). If unchanged, proceed even if another row mutated the file's Drive `modifiedTime`.
  3. **Domain Clamping & Status Parity:**
     - Clamp `note.pos` to `[0, 100]` when `book.posUnit === 'percent'` and `[0, book.totalPos]` when `book.totalPos > 0` across [`captureNote`](file:///home/antigravity/saimanoj01/pragya/src/context/PragyaContext.tsx#L384), [`EditNoteModal.handleSubmit`](file:///home/antigravity/saimanoj01/pragya/src/components/modals/EditNoteModal.tsx#L278), and [`cmd_capture`](file:///home/antigravity/saimanoj01/pragya/scripts/pragya_cli.py#L1321).
     - Align [`applyBookmarkAdvance`](file:///home/antigravity/saimanoj01/pragya/src/utils/sessionCoalesce.ts#L83-L92) with [`pragya_cli.py` `L674-L676`](file:///home/antigravity/saimanoj01/pragya/scripts/pragya_cli.py#L674-L676): advancing a `'queued'` book transitions `status: 'reading'` and sets `meta.startedAt`.
  4. **`UNFORMATTED_VALUE` Sheet Reads:**
     - Append `&valueRenderOption=UNFORMATTED_VALUE` to the data `batchGet` URL in [`GoogleSheetsAdapter.loadWorkspace`](file:///home/antigravity/saimanoj01/pragya/src/services/googleSheetsAdapter.ts#L416-L419) (keep after `dataRangesQuery` so `u.includes('Books!A%3AL')` in [m1Core.test.mjs](file:///home/antigravity/saimanoj01/pragya/tests/unit/m1Core.test.mjs#L733) passes).
     - Append `--value-render-option`, `UNFORMATTED_VALUE` **after** `range_a1` in [`_read_range`](file:///home/antigravity/saimanoj01/pragya/scripts/pragya_cli.py#L973) (preserving `cmd[4] == range_a1` in [test_pragya_cli.py](file:///home/antigravity/saimanoj01/pragya/tests/unit/test_pragya_cli.py#L997)).

### M4.10 — CI/CD Deployment Pipeline Hardening
- **File:** [.github/workflows/deploy.yml](file:///home/antigravity/saimanoj01/pragya/.github/workflows/deploy.yml#L18-L43)
- **Changes:**
  - Upgrade Node `20` -> `24` (`node-version: 24`).
  - Add `actions/setup-python@v5` (`python-version: '3.12'`).
  - Add pre-build quality gates before `npm run build`:
    1. `npm run lint`
    2. `npm run test:unit`
    3. `python3 -m unittest discover -s tests/unit -v`
  - Sync [MILESTONES.md](file:///home/antigravity/saimanoj01/pragya/docs/MILESTONES.md) with Milestone 4 completion gate and append any new `data-testid`s to [SPEC.md](file:///home/antigravity/saimanoj01/pragya/docs/SPEC.md#L467-L488).

---

## 5. Milestone M5 (P1) — Daily Flow & Mobile Ergonomics

### M5.1 — `QuickCaptureModal` Frictionless Flow
- **Files:** [QuickCaptureModal.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/modals/QuickCaptureModal.tsx#L283-L368), [Modal.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/common/Modal.tsx#L140-L160)
- **Changes:**
  1. Render `QuickCaptureModal` as bottom-docked full-width mobile sheet (`variant="sheet"` on `<640px` or responsive modal class) with sticky Save/Cancel footer above soft keyboards.
  2. **Context-Aware Initial Focus:** When `initialBookId` is set (user tapped `+ Capture` on a specific book card/detail), focus `capture-takeaway-input` on open; when `initialBookId` is null (opened globally via `N`), keep default form order (`capture-book-select` first, protecting [`tier1#L158`](file:///home/antigravity/saimanoj01/pragya/tests/specs/tier1_foundation_and_capture.spec.ts#L158)).
  3. **Empty-Shelf Inline Recovery:** When `books.length === 0`, render a clean `"Add Your First Book"` CTA directly inside `QuickCaptureModal` instead of a disabled empty `<select>` that errors on submit.
  4. **Kindle Paste Smart Pos Extraction:** On paste/blur helper or inline subtle chip when pasting Kindle highlights (e.g., matching `/Location\s+(\d+)/i`, `/Page\s+(\d+)/i`, or `/(\d+)%/`), offer 1-tap auto-fill of `pos` (only when `pos` matches book's default or user clicks apply chip).

### M5.2 — `ShelfView` Mobile Touch Targets & Unit Clarity
- **File:** [ShelfView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/ShelfView.tsx#L200-L335)
- **Changes:**
  1. Ensure mobile (`<640px`) touch targets for `advance-10p-btn-{id}`, `advance-exact-input-{id}`, `advance-exact-btn-{id}`, edit icon, and `book-capture-btn-{id}` meet `>= 44px` height (`h-11 sm:h-8`).
  2. Select existing numeric value on focus (`onFocus={e => e.currentTarget.select()}`) inside `advance-exact-input-{id}` & `book-detail-advance-input` so overwriting `"142"` never appends `"142200"`.
  3. Unit-aware step button label keeping `data-testid="advance-10p-btn-{id}"`: `+10p` for `page`, `+5%` (`step = 5`) for `percent`, `+50 loc` (`step = 50`) for `loc`.
  4. Turn the empty `Now Reading` card ([`ShelfView.tsx#L201-L203`](file:///home/antigravity/saimanoj01/pragya/src/components/views/ShelfView.tsx#L201-L203)) into an actionable CTA (`+ Add Book` + quick pick from `Queued`).

### M5.3 — `DeepenNoteModal` Source Context & Draft Saves
- **File:** [DeepenNoteModal.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/modals/DeepenNoteModal.tsx#L175-L418)
- **Changes:**
  1. Display a compact collapsible read-only reference of `note.quote` (plus clickable attachment thumbnails) at the top of `DeepenNoteModal` so users never have to close the modal to re-read the passage they are synthesizing.
  2. Add a secondary **`Save Draft`** button (`data-testid="deepen-save-draft-btn"`) alongside `Save Atomic Note` (`deepen-submit-btn`) that persists edits while preserving `note.status` (`inbox` or `in-reflection`) instead of prematurely forcing `'atomic'`. (`deepen-submit-btn` remains `'atomic'` for [`tier3#L179`](file:///home/antigravity/saimanoj01/pragya/tests/specs/tier3_deepen_spoilers_practice.spec.ts#L179).)

### M5.4 — `PracticeView` Honest Empty Shuffle & Today Check-in Awareness
- **File:** [PracticeView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/PracticeView.tsx#L335-L598)
- **Changes:**
  1. Distinguish why `shuffleCandidates.length === 0`:
     - If notes matching eligibility (`>= 14` days old or `#favorite`/`#favorites`, non-spoiler) exist and all have `lastReviewedAt === todayDate`: `"All eligible takeaways reviewed for today!"`
     - Else: `"No eligible notes yet — notes qualify once 14 days old or tagged #favorite (and unlocked from spoilers)."`
  2. Show an informational, non-blocking **`"Checked in today"`** pill (`deltaLogs` entry matching `noteId === note.id && date === todayDate`) in the card meta header while keeping `Applied (1)`, `Missed Trigger (2)`, and `Didn't Come Up (3)` clickable cleanly (protects [`tier3#L216-L269`](file:///home/antigravity/saimanoj01/pragya/tests/specs/tier3_deepen_spoilers_practice.spec.ts#L216-L269)).

### M5.5 — Compensating `ToastAction` Undo Architecture
- **Files:** [PragyaContext.tsx](file:///home/antigravity/saimanoj01/pragya/src/context/PragyaContext.tsx), [demoAdapter.ts](file:///home/antigravity/saimanoj01/pragya/src/services/demoAdapter.ts), [googleSheetsAdapter.ts](file:///home/antigravity/saimanoj01/pragya/src/services/googleSheetsAdapter.ts), [ShelfView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/ShelfView.tsx#L82-L127), [BookDetailView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/BookDetailView.tsx#L147-L200), [PracticeView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/PracticeView.tsx#L181-L219)
- **Changes:**
  1. Mutations commit immediately (zero optimistic queue delay) and emit a `showToast(..., 'success'|'info', { action: { label: 'Undo', testId: 'toast-undo-btn', onClick } })` for 4 reversible actions:
     - **Bookmark Advance (`+10p` / exact advance):** Captures `{ prevBook, sessionAction: { mode: 'created', sessionId } | { mode: 'updated', prevSession } }` inside `advanceBookPositionInternal`. On Undo, enqueue mutation restoring `prevBook` directly via adapter (bypassing monotonic guard cleanly) and either reverting `prevSession` or removing newly created `sessionId` (`DemoStorageAdapter.deleteSession` + `GoogleSheetsAdapter.deleteRowById` via Drive/Sheets `batchUpdate` `deleteDimension` keyed by UUID in `A:A`, falling back gracefully if row already modified). Reverts `activity-count` accurately!
     - **`Mark as Finished` (`BookDetailView`):** Restores prior `book` (`status`, `currentPos`, `normalizedPos`, `meta.finishedAt`).
     - **`Graduate` / `Pause` Behavioral Delta (`PracticeView`):** Restores prior `deltaStatus` (with `<= 5` active cap check).
     - **`Mark Reviewed` Shuffle (`PracticeView`):** Restores prior `meta.lastReviewedAt` (using `preserveUpdatedAt: true`).
  2. **Explicit Exclusion:** Do **NOT** add Undo to `1/2/3` Behavioral Delta check-ins (`PracticeView`) to preserve rapid keyboard repetition and `tier3` E2E behavior.

### M5.6 — `CommandPalette` Grouping, Mobile Entry & PR E2E Workflow
- **Files:** [CommandPalette.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/layout/CommandPalette.tsx#L195-L340), [BottomNav.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/layout/BottomNav.tsx#L172-L220), `.github/workflows/e2e.yml` (new)
- **Changes:**
  1. Add a mobile **"Search (`⌘K`)"** button inside `BottomNav` `mobile-more-drawer` (and/or view top-bar search icon trigger) so mobile users can open `CommandPalette` without a physical keyboard.
  2. Group `CommandPalette` results by `Actions`, `Views`, `Books`, and `Notes` section headers (increasing empty-query cap sensibly per group rather than flat `items.slice(0, 20)` truncation).
  3. Add `.github/workflows/e2e.yml` triggered on `pull_request` (targeting `main`) and `workflow_dispatch`: Node 24, `npm ci`, `npx playwright install --with-deps chromium`, `npm run test:e2e`, uploading `playwright-report` on failure.

### M5.7 — Conversation-First CLI Primitives & Live Workspace Probe (`scripts/pragya_cli.py`, `tests/integration/test_live_workspace.py`)
- **Files:** [pragya_cli.py](file:///home/antigravity/saimanoj01/pragya/scripts/pragya_cli.py), [test_live_workspace.py](file:///home/antigravity/saimanoj01/pragya/tests/integration/test_live_workspace.py)
- **Changes:**
  1. Add `book-list` (`--status`, `--kind`, `--query` -> `{ count, activeDeltaCount, books }`), `book-add` (duplicate normalized title guard unless `--allow-duplicate`, `percent` defaults `totalPos=100`, URL safety, no synthetic `Sessions`), `book-update` (`--force-pos` backward guard, `finished` unlocks fiction predictions + returns `unlockedPredictionsCount`, row `updatedAt` conflict guard), and `progress` (`--pos` | `--delta` | `--finish`, saves `Book` before coalesced `Session`, rejects negative/backward positions cleanly).
  2. Extend `capture` with optional `--pos` (defaults to `book.currentPos` without synthetic session), `--slug`, `--context`, `--critique`, `--trigger`, `--action`, `--delta-status`, and `--atomic`, running all domain/attachment/delta-cap validations **before** `upload_image`.
  3. Extend `reflect --stage 1` with optional `--q1`/`--q2` overrides and softened non-fiction defaults; wrap missing-CLI `FileNotFoundError` in `default_cmd_runner` into actionable `CliError`; add `_extract_id` (`rawText` ID parsing) and structured `gdocs mutate batch` formatting in `append_doc_text`.
  4. Add opt-in (`PRAGYA_RUN_LIVE_INTEGRATION=1`) live Google Workspace smoke suite confirming `gsheets mutate batch` executes `USER_ENTERED` coercion (`["=SUM(1,2)", "+10%", "-5", "@tag", "2026-11-16"]` -> `[3, 0.1, -5, "@tag", 46342]` in `UNFORMATTED_VALUE`), guiding M6.4.

### M5.8 — Self-Contained Skill Bundle & Gemini Spark Docs (`.agents/skills/pragya-companion/`)
- **Files:** [.agents/skills/pragya-companion/SKILL.md](file:///home/antigravity/saimanoj01/pragya/.agents/skills/pragya-companion/SKILL.md), [.agents/skills/pragya-companion/scripts/pragya_cli.py](file:///home/antigravity/saimanoj01/pragya/.agents/skills/pragya-companion/scripts/pragya_cli.py), [.agents/skills/pragya-companion/references/schema_and_ops.md](file:///home/antigravity/saimanoj01/pragya/.agents/skills/pragya-companion/references/schema_and_ops.md)
- **Changes:**
  1. Replace the thin repo-lookup wrapper with a byte-identical standalone copy of [pragya_cli.py](file:///home/antigravity/saimanoj01/pragya/scripts/pragya_cli.py) so the skill executes independently outside repo checkout.
  2. Document Dual-Mode execution (Mode A Skill CLI vs Mode B native Google Workspace/MCP connector fallback via `references/schema_and_ops.md`), Voice-Fidelity & Anti-Slop contract, 5-way conversation routing, and mobile/media/spoiler hygiene.

---

## 6. Milestone M6 (P2) — Knowledge Graph, Keyboard Polish & CLI Write Verification

### M6.1 — Bidirectional Linking, Clickable `#Tags` & Mobile Autocomplete
- **Files:** [NoteDetailView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/NoteDetailView.tsx#L126-L158), [App.tsx](file:///home/antigravity/saimanoj01/pragya/src/App.tsx#L78-L88), [navigation.ts](file:///home/antigravity/saimanoj01/pragya/src/utils/navigation.ts#L40-L89), [NotesView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/NotesView.tsx#L33-L105), [WikilinkAutocomplete.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/common/WikilinkAutocomplete.tsx#L140-L165)
- **Changes:**
  1. Pass `initialTitle` / derived title from missing `[[slug]]` page ([`NoteDetailView.tsx#L148-L155`](file:///home/antigravity/saimanoj01/pragya/src/components/views/NoteDetailView.tsx#L148-L155)) into `QuickCaptureModal` (de-slugifying `my-missing-concept` -> `My Missing Concept` or seeding title so saved note immediately resolves the link).
  2. Support `#/notes?tag=%23systems` query param in [`parseHash`](file:///home/antigravity/saimanoj01/pragya/src/utils/navigation.ts#L52) and sync `NotesView` state so clicking any `#tag` pill in `NotesView` or `NoteDetailView` filters `NotesView` cleanly.
  3. Fix mobile touch selection race in [`WikilinkAutocomplete`](file:///home/antigravity/saimanoj01/pragya/src/components/common/WikilinkAutocomplete.tsx#L144-L160) using `onPointerDown` (`e.preventDefault()`) + microtask blur guard in `DeepenNoteModal`/`EditNoteModal` so touch taps don't dismiss the popover before `onClick` fires.

### M6.2 — Genre-Aware Deepening & Inbox Triage
- **Files:** [DeepenNoteModal.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/modals/DeepenNoteModal.tsx#L290-L418), [NotesView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/NotesView.tsx#L446-L466)
- **Changes:**
  1. Collapse Behavioral Delta accordion by default inside `DeepenNoteModal` when `book?.kind === 'fiction' && deltaStatus === 'none' && !deltaTrigger && !deltaAction`.
  2. Add `Save & Next in Inbox` secondary submit button in `DeepenNoteModal` when next `inbox` / `in-reflection` notes exist.
  3. Surface an inline `Deepen` button directly on `inbox` / `in-reflection` cards in `NotesView` alongside `VIEW NOTE ↗`.

### M6.3 — Keyboard Polish & Discoverability
- **Files:** [NotesView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/NotesView.tsx#L139-L145), [BookDetailView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/BookDetailView.tsx#L99-L105), [PracticeView.tsx](file:///home/antigravity/saimanoj01/pragya/src/components/views/PracticeView.tsx#L123-L129), [useKeyboardShortcuts.ts](file:///home/antigravity/saimanoj01/pragya/src/hooks/useKeyboardShortcuts.ts)
- **Changes:**
  1. Call `el?.scrollIntoView({ block: 'nearest' })` on `[data-focused="true"]` changes across `NotesView`, `BookDetailView`, and `PracticeView`.
  2. Support `D` (deepen focused note) and `J`/`K` + `E` cleanly inside `BookDetailView`.
  3. Add `?` (`Shift+/`) global shortcut opening a lightweight **Keyboard Shortcuts Help** modal (also linked gently from `Sidebar` footer or `CommandPalette`).

### M6.4 — Conditional CLI `_batch_write` Raw-Value Gate
- **Files:** [pragya_cli.py](file:///home/antigravity/saimanoj01/pragya/scripts/pragya_cli.py#L982-L993), [test_pragya_cli.py](file:///home/antigravity/saimanoj01/pragya/tests/unit/test_pragya_cli.py#L1023-L1110)
- **Action Gate (Verification First):**
  1. Test `/opt/antigravity/bin/gsheets mutate batch` against a real test spreadsheet with strings starting with `=`, `+`, `-`, `@` and `YYYY-MM-DD` dates.
  2. **If** the live CLI uses `USER_ENTERED` coercion: migrate `_batch_write` cleanly to `gsheets mutate raw-batch` (mapping sheet tab names -> numeric `sheetId` from `list-sheets`, emitting `updateCells`/`appendCells` payloads, and updating mock assertions in [test_pragya_cli.py](file:///home/antigravity/saimanoj01/pragya/tests/unit/test_pragya_cli.py#L1074-L1110)). **If** it is already raw-safe, document verified behavior and close without unnecessary churn.
- **Resolution (M6 Track B, B1.1):** Because `gsheets mutate batch` applies `USER_ENTERED` coercion (the behavior the M5.7 probe documents), the CLI was migrated. `_batch_write` is gone; all Sheet writes (rows and header repair) use `gsheets mutate raw-batch <sid> -f {"requests":[…]}` with `updateCells`/`appendCells` (`numberValue` for numbers, `stringValue` for everything else). There is deliberately **no** legacy `mutate batch` fallback for Sheet data (it would reintroduce coercion); an unsupported raw-batch fails loudly. `gdocs mutate batch` remains for Doc append ops, and in-place Doc edits use `gdocs mutate raw-batch` with `writeControl.requiredRevisionId`. Both raw-batch transports are release-gated on the opt-in live probe (see README "Release gates").

---

## 7. Deprioritized P3 Backlog & Permanent Cuts

### P3 Deferred Items (Do Not Build Without Explicit Trigger)

| Item | Why Deferred | Objective Trigger to Revisit |
|---|---|---|
| **Offline IndexedDB Mutation Outbox + Interactive Conflict Merge Modal** | M4 cached read-only mode + silent `localStorage` draft autosave solves read/draft loss cleanly without distributed CRDT/queue merge bugs. | User regularly logs 5+ offline captures/advances in a single session on flights/commutes and finds read-only guard limiting. |
| **Google Picker (`drive.file`-Only OAuth Migration)** | Breaks zero-prompt cross-client discovery of Sheets/media/Docs created by `pragya_cli.py` unless rebuilt cleanly with Picker workflows. | Distributing the hosted app to external Google accounts requiring formal Google OAuth App Verification. |
| **Soft-Archive / Undoable Book & Note Delete** | Direct Google Sheet `deleteDimension` risks UUID/row-shift races with concurrent `pragya-companion` CLI writes. | Active workspaces exceed duplicate cleanup tolerance (prefer adding an `'archived'` status enum before hard row deletion). |
| **Interactive `[[Wikilink]]` Force Graph Canvas** | Adds bundle bloat and little clarity below 100 notes compared to Backlinks chips + clickable tags. | Commonplace corpus exceeds **> 150 atomic notes** with dense cross-book links. |
| **Browser WASM OCR, Demo-to-Cloud Non-Destructive Merge, Book Cover Art** | OCR already lives cleanly in `pragya_cli.py ocr-backfill`; JSON snapshot + Cover metadata clutter add maintenance surface. | Proven user pull after M4–M5 adoption. |

### Permanent Anti-Feature Cuts (Out of Bounds)
- **Zero In-App AI / LLM Calls / API Key Storage** ([SPEC.md#L9](file:///home/antigravity/saimanoj01/pragya/docs/SPEC.md#L9)) — Socratic reflection stays in the external `pragya-companion` skill.
- **Zero Custom Browser Mic / Audio Recording UI** ([SPEC.md#L9](file:///home/antigravity/saimanoj01/pragya/docs/SPEC.md#L9)) — Rely on native mobile/OS keyboard dictation.
- **Zero Reading Timers, Stopwatches, Streak Guilt, or Overdue Flashcard Queues** ([SPEC.md#L17](file:///home/antigravity/saimanoj01/pragya/docs/SPEC.md#L17)).
- **Zero Vanity Analytics Dashboards** (pages/hr, charts, yearly goals), **Zero Push/Email Reminders**, **Zero Calendar Sync**, **Zero Bidirectional Markdown Diff Sync**, **Zero Browser Drive `DELETE` Calls** ([SPEC.md#L337](file:///home/antigravity/saimanoj01/pragya/docs/SPEC.md#L337)).

---

## 8. Manual Release & Live GitHub Pages Activation Checklist

> [!CAUTION]
> Passing CI workflows alone does not make live Google Sign-In work on GitHub Pages; the following external repository & Cloud Console settings require manual verification/configuration:

1. **GitHub Pages Activation:**
   - Ensure Repository **Settings -> Pages -> Source** is set to **GitHub Actions** and confirm `https://saimanoj01.github.io/pragya/` serves HTTP `200` after running [deploy.yml](file:///home/antigravity/saimanoj01/pragya/.github/workflows/deploy.yml).
2. **Optional Build-Time Client ID Secret:**
   - (Optional) Configure GitHub Repository Secret `VITE_GOOGLE_CLIENT_ID` so users do not need to paste a Client ID on first load (runtime `localStorage('pragya_google_client_id')` override remains active).
3. **Google Cloud Console OAuth Configuration:**
   - Enable APIs: **Google Sheets API**, **Google Drive API** (and **Google Docs API** if using `pragya-companion`).
   - Add **Authorized JavaScript Origin:** `https://saimanoj01.github.io`
   - Add **Authorized Redirect URI:** `https://saimanoj01.github.io/pragya/` (and `http://localhost:3000/` for local dev).
   - While app publishing status is **Testing**, add active Google accounts under **OAuth Consent Screen -> Test Users**.
