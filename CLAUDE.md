# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A terminal UI (TUI) for [Grist](https://www.getgrist.com/) documents. Connects via WebSocket to a Grist server, renders interactive spreadsheet views with multi-pane layouts directly in the terminal. Browse pages, edit cells, watch live updates — like tmux for spreadsheets. Fun side project with heavy vibe coding.

Works with both private documents (using `--api-key`) and publicly shared documents (no key needed).

## Build & Run Commands

```bash
yarn install
yarn build             # tsc (compiles TS from src/ and test/ to dist/)
yarn watch             # incremental TypeScript compilation
yarn cli <url>         # run against a Grist doc URL
```

Supports multiple URL formats: full doc URLs, server+docId pairs, org-prefixed URLs. Options: `--api-key <key>`, `--table <name>`.

## Testing

```bash
yarn test              # unit tests (no server needed) — mocha on dist/test/ConsoleClient.js
yarn test:integration  # integration tests (starts Grist Docker container on port 8585)
yarn test:all          # both
```

Must `yarn build` before running tests (mocha runs compiled JS from `dist/`). Set `GRIST_RUNNING=1` to skip Docker container startup if a Grist server is already running on port 8585. Integration tests use `gristlabs/grist` Docker image with `GRIST_TEST_LOGIN=1`.

## Architecture

**Entry point:** `src/index.ts` — CLI argument parsing (Commander.js), URL normalization, invokes `consoleMain()`.

Module names rhyme with the grist-core web client (`app/client/components/`)
where there's a natural counterpart, so a reader familiar with that codebase
should recognise the structure.

**Core modules and data flow:**

```
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

State and pure helpers live separately so input/dispatcher/renderer modules
can share types without importing each other:

- **ConsoleAppState.ts** — `AppState`, `PaneState`, `AppMode` types and the
  small derivation helpers (`activeView`, `editReturnMode`, `paneTableId`,
  `paneTitle`).
- **ConsoleDisplay.ts** — Pure string/ANSI helpers (`displayWidth`,
  `truncate`, `padRight`, `extractUrls`, `editWindow`, ANSI constants).

**Module responsibilities:**

- **ConsoleMain.ts** — Orchestrator. Owns the event loop, dispatches
  `InputAction`s from `ConsoleInput` to the right command/renderer, and wires
  WebSocket pushes through `ActionDispatcher` + `LinkingState` + `render`.
  Modes: `table_picker`, `page_picker`, `grid`, `editing`, `confirm_delete`,
  `overlay`, `cell_viewer`.
- **ConsoleConnection.ts** — WebSocket handshake (org resolution, doc worker
  discovery, `openDoc` RPC). With an API key, auth goes via the Authorization
  header; without one, session cookies are a fallback for public docs.
  Request/response tracking with 30s timeouts. Pushes live `docUserAction`
  updates.
- **ConsoleLayout.ts** — Parses Grist metadata tables (`_grist_Pages`,
  `_grist_Views_section`, `_grist_Tables_column`, etc.) to extract pages,
  sections, fields, and section linking config. Recursive layout algorithm
  assigns pixel-perfect rects: even depth = vertical split, odd = horizontal.
- **ConsoleRenderer.ts** — Top-level render dispatcher plus the line-based
  renderers for single-table grid, cell viewer, and pickers. Re-uses
  `computeColLayout` (also called by `ConsoleInput.ensureColVisible`).
- **ConsoleMultiPane.ts** — Buffer-based renderer for multi-section pages
  and the full-screen overlay. Composes per-pane render-into helpers
  (`renderPaneInto`, `renderCardPaneInto`, `renderChartPlaceholder`) into a
  2D character buffer, then flushes with cursor-positioning escapes.
- **ConsoleInput.ts** — Parses raw keyboard buffers (including UTF-8
  multi-byte) and dispatches per-mode (`handleGridViewKey` is shared by
  multi-pane and overlay; `handleCardPaneKey`, `handleEditKey`, etc.).
  Returns an `InputAction` for `ConsoleMain` to act on.
- **Commands.ts** — User-action executors (`executeSaveEdit`,
  `executeAddRow`, `executeDeleteRow`, `computeInsertManualSort`). Translate
  UI intents into Grist `applyUserActions` RPCs.
- **UndoStack.ts** — Tracks `ActionGroup` broadcasts from this client and
  issues undo/redo via `applyUserActionsById`. Mirrors
  `app/client/components/UndoStack.ts`.
- **LinkingState.ts** — Section sort/filter/cross-section linking. Owns
  `reapplySortAndFilter`, `applyAllSectionLinks`, `applySortSpec`,
  `applySectionFilters`, `compareCellValues`.
- **ActionDispatcher.ts** — Applies incoming Grist `DocAction`s
  (`UpdateRecord`, `BulkAddRecord`, `RemoveRecord`, ...) to local pane
  state. Mirrors grist-core's `TableData.receiveAction()`.
- **WidthProbe.ts** — Background terminal-width probing via cursor-position
  reports (CPR). Buffers user input during a probe, then replays it with
  CPR responses stripped.
- **ConsoleCellFormat.ts** — Bidirectional: `formatCellValue()` for display
  (handles Grist's encoded types like `["D", timestamp, tz]`,
  `["R", tableId, rowId]`, `["E", error]`) and `parseCellInput()` for
  editing (bool, int, numeric, date, ref, text).
- **types.ts** — Grist type definitions inlined from grist-core (no external
  dependency). `DocAction` union, `CellValue`, `BulkColValues` (columnar
  format: `{colId: [values]}`), `getBaseType()` helper.

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
