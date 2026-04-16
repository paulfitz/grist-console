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

You can also pass `--api-key <key>` or set `GRIST_API_KEY`. Use `--table <name>` to jump straight to a specific table. Use `--theme <name>` to set the color theme.

URLs with page suffixes are supported — `/p/3` opens that page directly:

```bash
grist-console https://templates.getgrist.com/hQHXqAQXceeQ/Personal-Notebook/p/32
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

- **Pages and multi-pane layouts.** Select a page, get the same split-pane arrangement you'd see in the browser. Tab/Shift-Tab switches focus between panes.
- **Grid views.** Arrow keys, scrolling, column headers, row counts.
- **Card views.** Field label/value pairs. Left/right flips between records.
- **Section linking.** Select a person in one pane, see their projects in another.
- **Editing.** Enter to edit, Enter to save. Text, numbers, dates, booleans, references.
- **Add/delete rows.** `a` to add, `d` to delete.
- **Live updates.** Changes from other users appear in real time.
- **Formatting.** Dates, numbers, and currencies display using the document's format settings (date format strings, currency mode, decimal places, etc.).
- **Reference display.** Ref and RefList columns show the display value (e.g. a name) instead of raw row IDs.

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

Formulas (view-only), charts, column operations, sorting, filtering, access rules, undo. Grist is a big application. This renders tables and lets you poke at cells.

## Keyboard shortcuts

<details>
<summary>Page picker</summary>

| Key | Action |
|-----|--------|
| Up/Down | Select page |
| Enter | Open page |
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
| Tab/Shift-Tab | Focus next/previous pane |
| Enter | Edit cell |
| a | Add row |
| d | Delete row |
| r | Refresh |
| p | Back to page picker |
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
