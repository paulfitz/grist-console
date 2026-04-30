# grist-console

A spreadsheet in your terminal, talking to a [Grist](https://www.getgrist.com/) document over the network. Browse pages, edit cells, watch other people's edits arrive in real time. Think tmux for spreadsheets.

This is a fun side project, not a serious productivity tool. There is a goat theme.

## Trying it out

You need Node. Open a terminal and run:

```bash
npx grist-console https://templates.getgrist.com/5iMYwmESm33J/Rental-Management
```

That opens a public Grist template. You should see a list of pages. Pick one with the arrow keys and Enter, and you're in.

If you want it around for longer:

```bash
npm install -g grist-console
grist-console <a-grist-doc-url>
```

That gives you a `grist-console` command on your `$PATH`.

## Pointing it at your own doc

If your doc is public (a "Public access" share link from Grist), just paste the URL. No setup.

If your doc is private, you need an API key. Get one from your Grist profile page, then:

```bash
grist-console <doc-url> --api-key <your-key>
```

Or set `GRIST_API_KEY` in your environment so you don't have to pass it every time.

A few extra flags worth knowing:

* `--table <name>` jumps straight to a single table, skipping the page picker.
* `--theme <name>` picks a color theme. (More on those below.)
* `--verbose` prints connection details and, on exit, a small report about emoji widths in your terminal.

URLs ending in `/p/3` open page 3 directly:

```bash
grist-console https://templates.getgrist.com/hQHXqAQXceeQ/Personal-Notebook/p/32
```

Got several docs you flip between? Save a tiny JSON file with `doc` (URL) and optional `key` (API key), then:

```bash
grist-console mydoc.json
```

## Browsing a whole site

Point at a Grist site instead of one specific doc and you'll get a list:

```bash
grist-console https://myteam.getgrist.com --api-key $GRIST_API_KEY
```

```
 // Open a doc  (17) //

   > Sales pipeline           Home          5 min ago
     Customer feedback        Home          2 hr ago
     Q4 campaigns             Marketing     yesterday
     Onboarding tracker       Sales         3 days ago
     ...

 ↑↓:select  Enter:open  T:theme  q:quit
```

Most-recent first, with the workspace and a relative time alongside the
doc name. Pick one with Enter and you're in.

Also works for public sites — no API key needed for things like
`https://templates.getgrist.com`.

Already inside a doc and want to switch? From the page or table picker,
press **s** to bounce back to the site listing. Pick a different doc and
keep going. The help bar shows `s:site` whenever this works.

A few things to note:

* On a team subdomain (`myteam.getgrist.com`), the URL itself names the
  site. On a multi-tenant host, use `/o/<team>` (`docs.getgrist.com/o/myteam`).
  Bare hosts pick the first org you have access to.
* Trashed docs aren't shown.

## Getting around

You'll start in the page picker:

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

 ↑↓:select  Enter:open  Tab:tables  T:theme  q:quit
```

Move with the arrow keys. Press Enter to open a page. You get the same multi-pane layout you'd see in the browser, sometimes a grid on top with a card detail below, sometimes side by side, sometimes a tray of collapsed widgets at the top:

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
```

Move the cursor with arrows. The bottom of the screen always shows the most useful keys for whatever mode you're in.

## Editing cells

It works like Excel or Google Sheets. Three ways to start editing the cell under your cursor:

1. **Just type.** Whatever you type replaces the cell. Hit Enter to save, Escape to cancel.
2. **Press Enter (or F2)** to edit the cell while keeping its current value. Useful for tweaking, not replacing.
3. **Press Backspace** to start editing with the cell empty. **Press Delete** to clear the cell with no edit prompt at all.

When you save (Enter), the change goes to the server immediately and other people see it. Mistakes are fine: **Ctrl+Z** undoes your last edit, **Ctrl+Y** (or Ctrl+Shift+Z) redoes it. Only edits made in this session are undoable.

To add a row, **Ctrl+Enter**. (Or **F7** if your terminal eats Ctrl+Enter, see the keys section.) To delete one, **Ctrl+Delete** or **F8**, then `y` to confirm.

## Moving around

* Arrow keys move one cell at a time.
* **Tab** and **Shift+Tab** move to the next or previous cell in the row, like in a real spreadsheet.
* **Page Up** and **Page Down** scroll a screen at a time.
* **Home** and **End** jump to the first or last column of the current row.
* **Ctrl+Home** and **Ctrl+End** jump to the corners of the table.
* **Ctrl+Up** / **Ctrl+Down** jump to the first or last record.

When a page has more than one widget on it, **F6** moves focus to the next pane, **Shift+F6** to the previous one. If the page has collapsed widgets in the tray at the top, **Alt+1** through **Alt+9** open one of them full screen. Escape closes the overlay.

## Card views

Some pages have card views (one record per page, fields stacked vertically). Up and Down walk through the fields. Left and Right (or Ctrl+Up / Ctrl+Down) flip through records. Everything else works the same as a grid: type to edit, Enter to save, Ctrl+Z to undo.

If the card is linked to another widget on the page, flipping records will move the linked widget's cursor too. That's section linking.

## Looking at long cells

Some cells have a paragraph of text or a URL or a markdown blob in them. Press **F3** to open a full-screen viewer with scrolling. Up, Down, Page Up, Page Down, Home, End all scroll. **Tab** cycles through any URLs found in the cell, and Enter opens the highlighted one in your browser. Escape (or F3 again) closes the viewer.

## Quitting

From a picker, press **q**.

From a grid or card view, **q** goes into the cell (it's just a letter now). Use **Ctrl+C** or **Ctrl+Q** to quit. Or press Escape to back out to the page picker first, then `q`.

## Themes

There are eleven of them. Cycle with **F12** (or **T** while you're in a picker), or pick one up front with `--theme <name>`:

| Theme | What it looks like |
|-------|--------------------|
| `default` | Normal terminal colors, bold headers, Unicode borders |
| `visicalc` | Green phosphor, inverted L frame, VisiCalc status chrome |
| `lotus` | White on blue, Lotus 1-2-3 |
| `dos` | DOS double-line borders, yellow on blue, very Norton Commander |
| `matrix` | Falling green phosphor, glowing headers, shaded row separators |
| `c64` | Light blue on navy, PETSCII block quadrants, little stars |
| `amber` | Old amber phosphor terminal |
| `paper` | Dark text on white, like a printed spreadsheet |
| `rainbow` | Every element a different color. Festive. |
| `goat` | Cream pasture with a 🐐 wandering between cells, eating, leaving 🌻🌼🌱. The status line narrates ("🐐 nibbling on People.Name[Alice]"). It avoids your cursor. |
| `boring` | No styling at all. Underlined cursor. |

## What it can't do

Formulas are view only. No charts. No column operations (add, remove, rename, retype). Grist is a big application; this is a small viewer that lets you poke at cells.

If your terminal lives inside `tmux` or `screen`, emoji alignment can drift, because those programs track their own ideas about character widths. Try running outside the multiplexer, upgrade to `tmux` 3.6 or newer, or add `variation-selector-always-wide on` to your `.tmux.conf`.

## All the keys, in one place

Most things have an obvious key and a fallback. The fallback is there because terminals vary: some can tell `Ctrl+Enter` from plain Enter, some can't. If a Ctrl combination doesn't seem to do anything, try the function-key version (F5, F7, F8, and so on).

<details>
<summary>Page picker / Table picker</summary>

| Key | Action |
|-----|--------|
| Up/Down | Select page or table |
| Page Up/Down, Home/End | Scroll a page or jump to top/bottom |
| Enter | Open the selected one |
| Tab, `p`, Escape | Swap between page picker and table picker |
| `t`, F4 | Switch to table picker |
| `s` | Back to the site listing |
| `T`, F12 | Cycle theme |
| `q`, Ctrl+Q, Ctrl+C | Quit |

</details>

<details>
<summary>Grid view</summary>

| Key | Action |
|-----|--------|
| Any printable character | Start editing, replacing the cell |
| Enter, F2 | Start editing, keeping the current value |
| Backspace | Start editing with an empty cell |
| Delete | Clear the cell |
| Arrow keys | Move one cell |
| Tab, Shift+Tab | Next or previous cell in the row |
| Page Up/Down | Scroll a page |
| Home, End | First or last column of the row |
| Ctrl+Home, Ctrl+End | First or last cell of the table |
| Ctrl+↑, Ctrl+↓ | First or last record |
| Ctrl+←, Ctrl+→ | First or last column |
| F6, Shift+F6 | Next or previous pane |
| Alt+1 ... Alt+9 | Open a collapsed widget full screen |
| Ctrl+Enter, F7 | Add a row |
| Ctrl+Delete, Ctrl+Backspace, F8 | Delete the row |
| F3 | Open the full-cell viewer |
| Ctrl+Z | Undo (this session only) |
| Ctrl+Y, Ctrl+Shift+Z | Redo |
| Ctrl+R, F5 | Refresh |
| Escape | Back to the page picker |
| F4 | Switch to the table picker |
| F12 | Cycle theme |
| Ctrl+Q, Ctrl+C | Quit |

</details>

<details>
<summary>Card view</summary>

| Key | Action |
|-----|--------|
| Any printable character | Start editing the focused field, replacing it |
| Enter, F2 | Edit the field, keeping its value |
| Up, Down | Previous or next field |
| Tab, Shift+Tab | Next or previous field (form style) |
| Home, End | First or last field |
| Left, Right | Previous or next record |
| Ctrl+↑, Ctrl+↓ | Previous or next record |
| Page Up, Page Down | Previous or next record |
| Ctrl+Home, Ctrl+End | First or last record |
| F6, Shift+F6 | Next or previous pane |
| Ctrl+Enter / F7, Ctrl+Delete / F8 | Add or delete row |
| Ctrl+Z, Ctrl+Y, Ctrl+R, F5, F12 | Undo, redo, refresh, theme |
| Escape | Back to the page picker |

</details>

<details>
<summary>Cell viewer (F3)</summary>

| Key | Action |
|-----|--------|
| Up/Down, Page Up/Down, Home/End | Scroll the content |
| Tab, Shift+Tab | Cycle through URLs in the cell |
| Enter | Open the highlighted URL, or start editing |
| Escape, F3 | Close the viewer |

</details>

<details>
<summary>Overlay (a collapsed widget opened full screen)</summary>

Same keys as the grid view. Escape closes the overlay and the linking
state catches up with anything you changed.

</details>

<details>
<summary>While you're editing a cell</summary>

| Key | Action |
|-----|--------|
| Enter | Save |
| Escape | Cancel |
| Left, Right, Home, End | Move within the text |

</details>

## Building from source

```bash
git clone https://github.com/paulfitz/grist-console.git
cd grist-console
yarn install && yarn build
yarn cli https://docs.getgrist.com/your-doc-url
```

## Testing

```bash
yarn test                # unit tests, no server needed
yarn test:integration    # spins up a Grist Docker container on port 8585
yarn test:all            # both
```

Set `GRIST_RUNNING=1` if you already have a Grist server on port 8585 and want to skip the Docker setup.

## License

Apache-2.0
