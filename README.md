# grist-console

A terminal UI for [Grist](https://www.getgrist.com/) documents. Browse pages, edit cells, watch live updates — all in your terminal, like tmux for spreadsheets.

This is a fun side project, not a serious productivity tool. Heavy use of vibe coding.

Works with both private documents (using an API key) and publicly shared documents (no key needed).

## Install

```bash
npx grist-console https://templates.getgrist.com/5iMYwmESm33J/Rental-Management
```

Or install globally:

```bash
npm install -g grist-console
grist-console https://templates.getgrist.com/5iMYwmESm33J/Rental-Management
```

You can also pass `--api-key <key>` or set `GRIST_API_KEY`. Use `--table <name>` to jump straight to a specific table. Use `--theme <name>` to set the color theme. Use `--verbose` to log the connection handshake and, on exit, a report of any emoji width mismatches detected in your terminal.

URLs with page suffixes are supported — `/p/3` opens that page directly:

```bash
grist-console https://templates.getgrist.com/hQHXqAQXceeQ/Personal-Notebook/p/32
```

You can also point at a JSON config file with `doc` (URL) and optional `key` (API key) fields:

```bash
grist-console mydoc.json
```

## What it looks like

Opening the [Rental Management](https://templates.getgrist.com/5iMYwmESm33J/Rental-Management) template:

```
 Grist Console — Select a Page

   > Current Signers
    Apartments
    Leases
      Tenancies
      People
    Profit and Loss Overview
      Income and Expenses
    Profit and Loss by Apartment
    Income and Expense breakdown
    GristDocTour

 ↑↓:select  Enter:open  t:tables  T:theme  q:quit
```

Select a page to get the same multi-pane layout you'd see in the browser — grid on top, card detail below, with section linking:

```
 Apartments (6)
   # │ Apartment │ Lease Start │ Lease End  │ Lease Term │ Num Tenants
 ────┼───────────┼─────────────┼────────────┼────────────┼────────────
   1 │ 1A        │ 01/01/2016  │ 12/31/2017 │ 2          │           2
   2 │ 1B        │ 12/01/2016  │ 11/30/2018 │ 2          │           2
   3 │ 1C        │ 02/01/2016  │ 01/31/2017 │ 1          │           4
 ──────────────────────────────────────────────────────────────────────
 Apartments (1/6)
 Apartment     │ 1A
 Bedrooms      │ 1
 Area          │ 700
 Bathrooms     │ 1
 Additional    │ Facing back, access to backyard
 ↑↓←→:move  Tab:pane  Enter:edit  a:add  d:del  p:pages  T:theme  q:quit
```

Title bars and cursor are highlighted in your terminal (reverse video).

## What works

- **Pages and multi-pane layouts.** Select a page, get the same split-pane arrangement you'd see in the browser. Tab/Shift-Tab switches focus between panes (in visual order).
- **Grid views.** Arrow keys, scrolling, column headers, row counts.
- **Card views.** Field label/value pairs. Left/right flips between records.
- **Section linking.** Select a person in one pane, see their projects in another. Supports RefList columns (filters by any row ID in the list).
- **Sorting.** Sections use their configured `sortColRefs` (multi-column, ascending/descending). When none is set, falls back to Grist's natural `manualSort` order.
- **Filtering.** Section filters from `_grist_Filters` are applied: inclusion, exclusion, numeric ranges, and list-column aware (ChoiceList, RefList).
- **Collapsed widgets.** Pages with minimized sections show a tray at the top; press `1`-`9` to open any collapsed widget full-screen, Escape to dismiss.
- **Cell viewer.** Press `v` to see the full content of a cell in a scrollable full-screen view. Press `o` to cycle through embedded URLs and Enter to open the selected link. Enter without a selected link switches to editing.
- **Editing.** Enter to edit, Enter to save. Text, numbers, dates, booleans, references. Terminal cursor shows insertion point; edit text scrolls horizontally within the cell so the cursor stays visible.
- **Add/delete rows.** `a` to add, `d` to delete.
- **Undo/redo.** `u` to undo your last action, `U` (shift-u) to redo. Only actions you made during the current session are undoable; uses Grist's `applyUserActionsById` like the web client.
- **Live updates.** Changes from other users appear in real time.
- **Formatting.** Dates, numbers, and currencies display using the document's format settings (date format strings, currency mode, decimal places, etc.).
- **Reference display.** Ref and RefList columns show the display value (e.g. a name) instead of raw row IDs.
- **Choice colors.** Choice and ChoiceList columns render with their configured fill/text colors using 24-bit ANSI color.
- **Emoji width handling.** At startup and in the background, the terminal is probed via cursor-position queries to measure actual rendered widths of emoji. If the terminal supports [DEC mode 2027](https://github.com/contour-terminal/terminal-unicode-core) (Kitty, Ghostty, WezTerm, foot, Contour, recent Windows Terminal), that's enabled for better grapheme-cluster width handling.

## Themes

Press `T` to cycle through themes, or use `--theme <name>`:

| Theme | Description |
|-------|-------------|
| `default` | Standard terminal look — bold headers, Unicode box-drawing |
| `visicalc` | Green phosphor with inverse-video "inverted L" frame |
| `lotus` | White on blue, Lotus 1-2-3 style |
| `amber` | Amber phosphor VT220/VAX terminal |
| `paper` | Dark text on white background, like a printed spreadsheet |
| `rainbow` | Every element a different color. Festive. |
| `boring` | No styling at all. Underline cursor. |

## What doesn't work

Formulas (view-only), charts, column operations. Grist is a big application. This renders tables and lets you poke at cells.

Emoji alignment inside `tmux` / `screen` can still drift because those multiplexers have their own Unicode width tables and don't speak mode 2027. If you see misalignment, try running outside the multiplexer, upgrade to `tmux` 3.6+, or set `variation-selector-always-wide on` in `.tmux.conf`.

## Keyboard shortcuts

<details>
<summary>Page picker / Table picker</summary>

| Key | Action |
|-----|--------|
| Up/Down | Select page/table |
| Page Up/Down, Home/End | Scroll by page or jump to top/bottom |
| Enter | Open |
| p / Escape | Switch between page picker and table picker |
| t | Switch to table picker |
| T | Cycle theme |
| q | Quit |

</details>

<details>
<summary>Grid view</summary>

| Key | Action |
|-----|--------|
| Arrow keys | Move cursor |
| Page Up/Down | Scroll by page |
| Home/End | Jump to first/last row |
| Tab/Shift-Tab | Focus next/previous pane (visual order, skips collapsed) |
| 1-9 | Open collapsed widget full-screen (if any) |
| Enter | Edit cell |
| v | View full cell content |
| a | Add row |
| d | Delete row |
| u | Undo last action (session only) |
| U | Redo |
| r | Refresh |
| p / Escape | Back to page picker |
| t | Switch to table picker |
| T | Cycle theme |
| q | Quit |

</details>

<details>
<summary>Card view</summary>

| Key | Action |
|-----|--------|
| Up/Down | Move between fields |
| Left/Right | Previous/next record |
| Enter | Edit field |
| Tab/Shift-Tab | Focus next/previous pane |

</details>

<details>
<summary>Cell viewer (press <code>v</code>)</summary>

| Key | Action |
|-----|--------|
| Up/Down, Page Up/Down, Home/End | Scroll content |
| o | Cycle through URLs found in the cell |
| Enter | Open highlighted URL, or enter edit mode |
| Escape / v / q | Close viewer |

</details>

<details>
<summary>Overlay (collapsed widget, press <code>1</code>-<code>9</code>)</summary>

| Key | Action |
|-----|--------|
| Arrow keys, Page Up/Down | Navigate (full grid controls) |
| Enter | Edit cell |
| a / d / v | Add row / delete row / view cell |
| Escape | Close overlay (returns cursor-linking updates to linked panes) |

</details>

<details>
<summary>Editing</summary>

| Key | Action |
|-----|--------|
| Enter | Save |
| Escape | Cancel |
| Left/Right/Home/End | Move cursor within text |

</details>

## Build from source

```bash
git clone https://github.com/paulfitz/grist-console.git
cd grist-console
yarn install && yarn build
yarn cli https://docs.getgrist.com/your-doc-url
```

## Testing

```bash
yarn test                # unit tests (no server needed)
yarn test:integration    # integration tests (starts a Grist Docker container)
yarn test:all            # both
```

Set `GRIST_RUNNING=1` to skip Docker container management if you already have a Grist server on port 8585.

## License

Apache-2.0
