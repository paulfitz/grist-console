# grist-console

A terminal UI for [Grist](https://www.getgrist.com/) documents. Browse pages, edit cells, watch live updates — all in your terminal, like tmux for spreadsheets.

This is a fun side project, not a serious productivity tool. Heavy use of vibe coding.

**Big caveat:** grist-core's WebSocket path only authenticates via session cookies, not API keys. So grist-console can only open **publicly accessible documents** (shared with "everyone"). Private docs will fail with "No view access" even with a valid API key. This is a grist-core limitation — the REST API respects API keys, but the WebSocket upgrade handler ignores them.

## Quick start

```bash
yarn install && yarn build
yarn cli https://docs.getgrist.com/your-doc-url
```

Or with explicit server and doc ID:

```bash
yarn cli http://localhost:8484 <doc-id> --api-key <key>
```

Set `GRIST_API_KEY` as an environment variable, or pass `--api-key`. Use `--table <name>` to jump straight to a specific table.

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

## Testing

```bash
yarn test                # unit tests (no server needed)
yarn test:integration    # integration tests (starts a Grist Docker container)
yarn test:all            # both
```

Set `GRIST_RUNNING=1` to skip Docker container management if you already have a Grist server on port 8585.

## License

Apache-2.0
