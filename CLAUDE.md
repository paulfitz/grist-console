# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A terminal UI for [Grist](https://www.getgrist.com/) documents. WebSocket
to a Grist server, multi-pane spreadsheet views in the terminal, live
updates from other clients. Fun side project, heavy vibe coding.

## Build & Run Commands

```bash
yarn install
yarn build             # tsc → dist/
yarn watch             # incremental
yarn cli <url>         # run against a Grist doc or site URL
```

CLI accepts: doc URL, site URL (opens the site picker), `server-url doc-id`
pair, or a JSON config file. Options: `--api-key`, `--table`, `--theme`,
`--verbose`. `GRIST_CONSOLE_TRACE_FILE=/path` alongside `--verbose` also
streams the diagnostic trace to a file (survives any kind of exit).

## Testing

```bash
yarn test              # unit tests (no server needed) — mocha on dist/test/ConsoleClient.js
yarn test:integration  # integration tests (starts Grist Docker container on port 8585)
yarn test:all          # both
```

Must `yarn build` before running tests (mocha runs compiled JS from `dist/`). Set `GRIST_RUNNING=1` to skip Docker container startup if a Grist server is already running on port 8585. Integration tests use `gristlabs/grist` Docker image with `GRIST_TEST_LOGIN=1`.

## Architecture

**Entry point:** `src/index.ts` — CLI argument parsing (Commander.js),
URL normalization, terminal-mode setup (alt-screen / raw-mode /
bracketed-paste once for the whole session), and a small loop between
`runSitePicker()` and `consoleMain()` so the user can pop back to the
site listing with `s`.

Module names rhyme with the grist-core web client (`app/client/components/`)
where there's a natural counterpart, so a reader familiar with that codebase
should recognise the structure.

**Core modules and data flow:**

```
index.ts (orchestrator: owns alt-screen/raw-mode for the session,
          loops between picker and doc)
   │
   ├── SitePicker.runSitePicker (no doc yet -- pick one)
   │     └── SiteApi.listSiteDocs (REST)
   │
   └── ConsoleMain.consoleMain (one doc open)
         │
         Keystroke → ConsoleInput (parse) → InputAction
                                                ↓
                  ConsoleMain (event loop)
                    ├── Commands (executeSaveEdit/AddRow/DeleteRow → applyUserActions)
                    ├── UndoStack (handleOwnActionGroup, executeUndo/Redo)
                    ├── LinkingState (sort, filter, cross-section linking)
                    ├── ActionDispatcher (DocAction broadcasts → pane mutations)
                    ├── WidthProbe (background terminal-width measurement)
                    ├── ConsoleConnection (WebSocket RPC)
                    ├── ConsoleLayout (metadata → page/section/column structure)
                    └── ConsoleRenderer (state → ANSI output)
                           └── ConsoleMultiPane (buffer-based multi-section render)
```

**Module responsibilities:**

- **ConsoleMain.ts** — Per-doc event loop. Dispatches `InputAction`s
  from `ConsoleInput` to commands/renderer, wires WebSocket pushes
  through `ActionDispatcher` + `LinkingState` + `render`. Returns
  `{ kind: "quit" | "switch_to_site" }` so `index.ts` can loop back
  to the picker. Modes: `site_picker`, `table_picker`, `page_picker`,
  `grid`, `editing`, `confirm_delete`, `overlay`, `cell_viewer`.
- **ConsoleAppState.ts** — `AppState` / `PaneState` / `AppMode` types
  + small derivation helpers (`activeView`, `editReturnMode`,
  `paneTableId`, `paneTitle`). Kept separate so input/dispatcher/renderer
  can share types without importing each other.
- **ConsoleConnection.ts** — WebSocket handshake (org resolution, doc
  worker discovery, `openDoc` RPC). API key → Authorization header;
  no key → session cookies for public docs. 30s request timeouts.
  Pushes live `docUserAction` updates.
- **ConsoleLayout.ts** — Parses Grist meta tables (`_grist_Pages`,
  `_grist_Views_section`, `_grist_Tables_column`, …) into pages,
  sections, fields, and section-linking config. Recursive layout
  algorithm: even depth = vertical split, odd = horizontal.
- **ConsoleRenderer.ts** — Top-level render dispatch + line-based
  renderers for single-table grid, cell viewer, and pickers. Shares
  `computeColLayout` with `ConsoleInput.ensureColVisible`.
- **ConsoleMultiPane.ts** — Buffer-based renderer for multi-section
  pages and the full-screen overlay. Composes `renderPaneInto`,
  `renderCardPaneInto`, `renderChartPlaceholder` into a 2D char
  buffer, then flushes with cursor-positioning escapes.
- **ConsoleInput.ts** — Parses raw keyboard buffers (UTF-8 included),
  dispatches per-mode (`handleGridViewKey` is shared by multi-pane
  and overlay), returns an `InputAction`.
- **ConsoleDisplay.ts** — Pure ANSI/string helpers (`displayWidth`,
  `truncate`, `padRight`, `extractUrls`, `editWindow`, ANSI constants).
- **Commands.ts** — User-action executors (`executeSaveEdit`,
  `executeAddRow`, `executeDeleteRow`, `computeInsertManualSort`):
  UI intent → `applyUserActions` RPC.
- **UndoStack.ts** — Tracks own `ActionGroup` broadcasts, issues
  undo/redo via `applyUserActionsById`. Mirrors grist-core's
  `app/client/components/UndoStack.ts`.
- **LinkingState.ts** — Sort, filter, cross-section linking
  (`reapplySortAndFilter`, `applyAllSectionLinks`, `applySortSpec`,
  `applySectionFilters`, `compareCellValues`).
- **ActionDispatcher.ts** — Applies incoming Grist `DocAction`s
  (`UpdateRecord`, `BulkAddRecord`, `RemoveRecord`, …) to local pane
  state. Mirrors grist-core's `TableData.receiveAction()`.
- **WidthProbe.ts** — Background terminal-width probing via cursor-
  position reports. Buffers user input during a probe, replays after
  with CPR responses stripped.
- **ConsoleCellFormat.ts** — `formatCellValue()` for display (Grist's
  encoded types like `["D", ts, tz]`, `["R", tableId, rowId]`,
  `["E", error]`) and `parseCellInput()` for editing.
- **types.ts** — Grist type definitions inlined from grist-core.
  `DocAction`, `CellValue`, `BulkColValues` (`{colId: [values]}`),
  `getBaseType()`.
- **SiteApi.ts** — `listSiteDocs()` (`GET /api/orgs/<slug>/workspaces`,
  flatten, drop trashed, sort by `updatedAt` desc; falls back to
  `/api/orgs` when "current" doesn't resolve) + `formatRelativeTime()`.
- **SitePicker.ts** — `runSitePicker()` runs the pre-doc UI. Takes
  `persistTerminal` so the orchestrator in `index.ts` can own
  alt-screen / raw-mode across phases (toggling them between phases
  caused stray-byte injection on some terminals).
- **Trace.ts** — Diagnostic trace, opt-in via `--verbose`.

**Key design patterns:**

- **Columnar data format:** Data is `{colId: [val1, val2, ...]}` not row
  objects — matches Grist's wire format.
- **One pane shape:** Every mode that shows data uses `state.panes:
  PaneState[]`. Single-table mode is a one-element array with no
  `sectionInfo`; multi-section pages have one `PaneState` per section. Use
  `activeView(state)` to get the user's current pane (overlay or focused).
- **Section linking:** Child panes auto-filter rows based on parent pane's
  cursor position (via `linkSrcSectionRef`, `linkSrcColRef`,
  `linkTargetColRef`).
- **Live updates:** Server pushes `docUserAction`; `ActionDispatcher`
  applies `DocAction`s incrementally to pane state, then `LinkingState`
  re-runs sort/filter/linking, all without a full refetch.
- **No external TUI library:** All rendering via raw ANSI escape codes.

## Writing style (README, PUBLISH.md, commits)

- **Light and breezy, no jargon, no marketing.** Direct address
  ("you'll see…", "press s to bounce back"). Describe what the user
  does and what they see, not what the change "enables" or "delivers".
  If a sentence sounds like LinkedIn, rewrite it. Acronyms get a
  one-phrase gloss or get cut.
- **Inverted pyramid for docs.** Lead with the one command the reader
  will actually run; edge cases further down. See PUBLISH.md.
- **Commit messages: a story, not a list.** Sentence-cased one-liner,
  then a couple of short paragraphs on the *why* and the gotchas.
  Avoid bulleted feature inventories — those belong in release notes.
- **No emoji** unless asked. Goat theme is the one place 🐐 are licensed.
- **Footer:** every commit ends with
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

Canonical examples: recent commit log, PUBLISH.md, README.md.
