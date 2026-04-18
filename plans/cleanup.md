# grist-console cleanup plan

> **Status: complete (2026-04-17).** Phases 1 through 4c landed plus
> phases 5-10 added during execution (key-handler consolidation,
> picker-key navigateList helper, multi-pane renderer extraction,
> Commands extraction, three-agent simplify pass). Final file sizes:
> ConsoleMain 519 (was 1440), ConsoleRenderer 382 (was 1114),
> ConsoleInput 636 (was 961). Full test suite green at every commit.

The project grew organically. This plan consolidates it into fewer, more
cohesive modules and removes the single-pane/multi-pane duplication
that pervades the code. Where sensible, module names rhyme with the
grist-core web client so anyone familiar with that codebase recognises
the structure.

## Naming conventions from the web client

| web client (`app/client/components/`) | our equivalent |
|---|---|
| `BaseView.ts` / `GridView.ts` / `DetailView.ts` / `ViewPane.ts` | `PaneState` (ConsoleRenderer) |
| `UndoStack.ts` | currently inline in `ConsoleMain.ts` |
| `ViewLayout.ts` | `ConsoleLayout.ts` |
| `LinkingState.ts` / `ViewLinker.css` | section-linking bits inline in `ConsoleMain.ts` |
| `Cursor.ts` | `cursorRow` / `cursorCol` fields on state |
| `Comm.ts` / `DocComm.ts` | `ConsoleConnection.ts` |
| `ActionDispatcher.ts` | currently `applyDocActions` / `applyDocActionToPane` |

Where we add new modules we'll rhyme: `UndoStack.ts`, `ActionDispatcher.ts`,
`WidthProbe.ts`, etc.

## File size snapshot before cleanup

```
1440 src/ConsoleMain.ts         <- orchestrator + 6 other concerns
1114 src/ConsoleRenderer.ts     <- types + display utils + 5 render kinds
 961 src/ConsoleInput.ts        <- key parse + 7 mode handlers + execute*
 454 src/ConsoleConnection.ts
 361 src/ConsoleLayout.ts
 344 src/termWidth.ts
 323 src/ConsoleTheme.ts
 288 src/ConsoleCellFormat.ts
```

Target: drop ~500-800 lines across the tree while reducing branches
like `if (state.panes.length > 0) { ... } else { ... }` to near-zero.

## Guiding rules

- Every step must keep the full test suite green (`yarn test:all`).
- Pure moves / renames first; behaviour-changing refactors later.
- Commit at the end of each phase so regressions are easy to bisect.
- Don't touch `ConsoleConnection.ts`, `ConsoleCellFormat.ts`, `ConsoleTheme.ts`,
  `ConsoleLayout.ts`, `urlParser.ts`, `types.ts`, `index.ts` -- they're
  appropriately scoped.

---

## Phase 1 -- low-risk extractions (ConsoleMain.ts shrinks)

### 1a. Extract undo/redo into `src/UndoStack.ts`

Move out of `ConsoleMain.ts`:
- `_expectingRedo` module flag + `_setExpectingRedo` test hook
- `handleOwnActionGroup`
- `executeUndo`
- `executeRedo`

Exports: `handleOwnActionGroup`, `executeUndo`, `executeRedo`, `_setExpectingRedo`.
`ConsoleMain.ts` imports from `UndoStack.ts`; test imports update.

Size: ~90 lines moved. Low risk.

### 1b. Extract the background probe into `src/WidthProbe.ts`

Move out of `ConsoleMain.ts`:
- Module-level `_probing`, `_probingBuffer`, `_probeTimer`, `_replayToHandler`
- `scheduleProbe`
- `collectUnprobedChars`
- `runProbe`
- `printWidthReport` (pair with the probe since it reports probe results)

Expose a small API, e.g. `setReplayHandler(fn)`, `scheduleProbe(state)`,
`bufferInput(data): boolean` (returns true if buffered), `printReport(verbose)`.

Size: ~175 lines moved. Low risk.

### Phase 1 commit

After 1a + 1b, `ConsoleMain.ts` drops to ~1175 lines. `yarn test:all` green.

---

## Phase 2 -- pure moves out of ConsoleRenderer.ts

### 2a. Create `src/ConsoleAppState.ts`

Move from `ConsoleRenderer.ts`:
- `AppMode` type
- `PaneState` interface
- `AppState` interface
- `createInitialState` factory
- `isCardPane` predicate (if present)

Keep everything else in `ConsoleRenderer.ts`. Update all imports.
This is the state type shared by input/renderer/main, so it deserves its
own file.

Size: ~100 lines moved.

### 2b. Create `src/ConsoleDisplay.ts`

Move from `ConsoleRenderer.ts`:
- `displayWidth`
- `flattenToLine`
- `truncate`
- `padRight` / `padLeft`
- `stripAnsi`
- `editWindow`
- `hexToAnsi`
- `applyChoiceColor`
- Constants `ENTER_ALT_SCREEN`, `EXIT_ALT_SCREEN`, `CLEAR_LINE`, `MOVE_TO`,
  `HIDE_CURSOR`, `SHOW_CURSOR`

Pure string / ANSI helpers. Already imported by `ConsoleInput.ts` via
`displayWidth`, so a dedicated module reduces the coupling to the renderer.

Size: ~150 lines moved.

### Phase 2 commit

After 2a + 2b, `ConsoleRenderer.ts` drops to ~850 lines and becomes
focused on actual rendering.

---

## Phase 3 -- unify single-pane and multi-pane (the big one)

The codebase currently maintains two parallel code paths:

- **single-pane** via top-level `AppState` fields (`rowIds`, `colValues`,
  `cursorRow`, `columns`, ...)
- **multi-pane** via `state.panes: PaneState[]` array (with `allRowIds`,
  `allColValues` in addition)

Every edit / input / doc-action handler has `if (state.panes.length > 0)
{ ... } else { ... }`. There are ~15 such branches across the codebase.

### Approach

Represent every mode (table picker → single grid, page picker → multi-pane)
as a one-or-more array of `PaneState` objects. Single-pane = a single
implicit pane with no `sectionInfo`.

Changes:
- Remove top-level `rowIds` / `colValues` / `cursorRow` / `cursorCol` /
  `scrollRow` / `scrollCol` / `columns` from `AppState`.
- Make `PaneState.sectionInfo` optional (single-pane has none).
- Make `PaneState.allRowIds` / `allColValues` optional (single-pane
  doesn't need them -- no section linking).
- Add `getActiveView(state): PaneState` helper returning the overlay pane,
  focused pane, or single pane as appropriate.
- Single-pane "grid" mode always has `state.panes.length === 1`.

### Call-site simplifications

- `executeSaveEdit`, `executeAddRow`, `executeDeleteRow` drop the
  branching.
- `enterEditMode` vs `enterPaneEditMode` collapse into one.
- `handleGridKey` vs `handleMultiPaneGridKey` share a core
  `handleGridViewKey(key, view, availWidth)`. Only the pane-focus /
  tab-cycling behaviour stays in the multi-pane wrapper.
- `handleOverlayKey` uses the same core.
- `computeColLayout` vs `computePaneColLayout` collapse into one
  `computeColLayoutForView(view, paneWidth)`.
- `ensureColVisible` uses the unified layout helper instead of rolling
  its own.
- `state.panes.length > 0` branches in the event loop disappear.

### Risk

Medium. The type shape changes. Every file in `src/` touches at least
one thing that moves. Plan:

1. Widen `PaneState` to accept optional fields.
2. Add a `getActiveView` helper and convert one call site at a time
   to use it.
3. Once every call site goes through the view helper, remove the
   duplicated `AppState` fields.
4. Collapse the handler / execute / layout helpers.

Keep tests green after each step.

Target: ConsoleMain.ts under 900 lines, ConsoleInput.ts under 700.

---

## Phase 4 -- merge doc-action handling and finish quick wins

### 4a. Create `src/ActionDispatcher.ts`

Move from `ConsoleMain.ts`:
- `applyDocActions` (single-pane)
- `applyDocActionToPane` (multi-pane)
- `appendRowToColValues`
- `defaultForColumnType`

After phase 3 these two functions share the same view abstraction and
collapse to one `applyDocActionToView(view, action)` plus a loop at
the caller.

### 4b. Small quick wins

- Helper: `maybeApplyLinks(state, conn)` for the repeated
  `if (state.panes.length > 0) applyAllSectionLinks(state, conn)`
  (still applicable even after phase 3 -- single-pane has no linking).
- `extractUrls(s)` in `ConsoleDisplay.ts`; callers in the cell viewer
  path (currently duplicated in two places).
- `ensureColVisible` calls the unified `computeColLayoutForView` instead
  of duplicating width math.

### 4c. Optionally extract section-linking logic

`applySortSpec`, `applySectionFilters`, `applyAllSectionLinks`,
`filterPaneRows`, `applySortByColumn`, `reapplySortAndFilter`,
`compareCellValues`, `extractFiltersForSection` form a coherent
~320-line subsystem. Extract to `src/LinkingState.ts` (matches grist-core
naming) if the resulting `ConsoleMain.ts` is still too large.

Consider deferring until after phase 3 is settled.

---

## Success criteria

- `yarn test:all` passes at the end of every phase commit.
- Each of `ConsoleMain.ts`, `ConsoleInput.ts`, `ConsoleRenderer.ts`
  ends under 1000 lines.
- No `if (state.panes.length > 0)` branches remain in the input /
  doc-action / execute paths.
- No function is copy-pasted across single-pane and multi-pane code.
- A reader familiar with grist-core recognises `UndoStack.ts`,
  `ActionDispatcher.ts`, `LinkingState.ts`, `ViewPane`-ish concepts
  immediately.

## Phase order summary

1. ✅ Phase 1a: extract `UndoStack.ts` (safe)
2. ✅ Phase 1b: extract `WidthProbe.ts` (safe)
3. ✅ Phase 2a: extract `ConsoleAppState.ts` (safe)
4. ✅ Phase 2b: extract `ConsoleDisplay.ts` (safe)
5. ✅ Phase 3: unify pane state (behaviour-preserving but structural)
6. ✅ Phase 4a: extract `ActionDispatcher.ts`
7. ✅ Phase 4b: extractUrls + unify column-width math
8. ✅ Phase 4c: extract `LinkingState.ts`
9. ✅ Phase 5: consolidate grid + overlay key handlers (handleGridViewKey)
10. ✅ Phase 6: clearViewState helper, drop overlay focusedPane swap
11. ✅ Phase 7: navigateList helper for picker key handlers
12. ✅ Phase 8: import state types from ConsoleAppState directly
13. ✅ Phase 9: extract `ConsoleMultiPane.ts` buffer renderer
14. ✅ Phase 10: extract `Commands.ts` (executeSaveEdit/AddRow/DeleteRow)
15. ✅ Simplify pass: 3-agent review (reuse / quality / efficiency).
    Results: getBaseType/paneTableId/paneTitle/writeTitleBar helpers,
    Map-based BulkUpdateRecord lookups, displayWidth → stripAnsi.
