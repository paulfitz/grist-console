# grist-console

A terminal UI for [Grist](https://www.getgrist.com/) documents. Browse pages, edit cells, watch live updates — all in your terminal, like tmux for spreadsheets.

This is a fun side project, not a serious productivity tool. Heavy use of vibe coding.

**Big caveat:** grist-core's WebSocket path only authenticates via session cookies, not API keys. So grist-console can only open **publicly accessible documents** (shared with "everyone"). Private docs will fail with "No view access" even with a valid API key. This is a grist-core limitation — the REST API respects API keys, but the WebSocket upgrade handler ignores them.

## Install

```bash
npx grist-console https://templates.getgrist.com/5iMYwmESm33J/Rental-Management
```

Or install globally:

```bash
npm install -g grist-console
grist-console https://docs.getgrist.com/your-doc-url
```

You can also pass `--api-key <key>` or set `GRIST_API_KEY`. Use `--table <name>` to jump straight to a specific table.

## What it looks like

Opening the [Rental Management](https://templates.getgrist.com/5iMYwmESm33J/Rental-Management) template:

```
 Grist Console — Select a Page

   > 👨‍👩‍👧 Current Signers
    🏢 Apartments
    📃 Leases
      Tenancies
      People
    💲 Profit and Loss Overview
      Income and Expenses
    💸 Profit and Loss by Apartment
    🔨 Income and Expense breakdown
    GristDocTour

 ↑↓:select  Enter:open  t:tables  q:quit
```

Select a page to get the same multi-pane layout you'd see in the browser — grid on top, card detail below, with section linking:

```
 Apartments (6)
   # │ Apartment │ Lease Start │ Lease End  │ Lease Term │ Num Tenants
 ────┼───────────┼─────────────┼────────────┼────────────┼────────────
   1 │ 1A        │ 2016-01-01  │ 1514678400 │ 2          │           2
   2 │ 1B        │ 2016-12-01  │ 1543536000 │ 2          │           2
   3 │ 1C        │ 2016-02-01  │ 1485820800 │ 1          │           4
   4 │ 2A        │ 2016-02-01  │ 1517356800 │ 2          │           2
   5 │ 2B        │ 2016-12-01  │ 1512000000 │ 1          │           4
   6 │ 2C        │ 2015-03-01  │ 1488240000 │ 2          │           5
 ──────────────────────────────────────────────────────────────────────
 Apartments (1/6)
 Apartment     │ 1A
 Bedrooms      │ 1
 Area          │ 700
 Bathrooms     │ 1
 Additional    │ Facing back, access to backyard
 ↑↓←→:move  Tab:pane  Enter:edit  a:add  d:del  p:pages  q:quit
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

## What doesn't

Formulas (view-only), charts, formatting, column operations, sorting, filtering, access rules, undo. Grist is a big application. This renders tables and lets you poke at cells.

## Keyboard shortcuts

<details>
<summary>Page picker</summary>

| Key | Action |
|-----|--------|
| Up/Down | Select page |
| Enter | Open page |
| t | Switch to table picker |
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
