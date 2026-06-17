# Demo animation

One [VHS](https://github.com/charmbracelet/vhs) tape that produces the
hero GIF (and a matching MP4) for the top-level README.

## Install VHS

VHS is a Go program that drives a headless terminal (`ttyd`) and renders
the output with `ffmpeg`.

```bash
# With Go toolchain
go install github.com/charmbracelet/vhs@latest

# macOS / Linuxbrew
brew install vhs
```

VHS also needs `ttyd` and `ffmpeg` on PATH. On Debian/Ubuntu:

```bash
sudo apt install ffmpeg ttyd
```

`grist-console` must be on PATH too:

```bash
npm install -g grist-console
# or from a source checkout:
yarn build && npm link
```

## Record

From the repo root:

```bash
vhs docs/demo/demo.tape
```

Writes `docs/demo/demo.gif` and `docs/demo/demo.mp4`.

## What the tape shows

1. Launches against the public
   [Rental Management](https://templates.getgrist.com/5iMYwmESm33J/Rental-Management)
   template (no API key).
2. Page picker → opens a multi-pane page; walks the grid, where the card
   pane tracks the cursor via section linking.
3. From the page picker, presses `s` to warp out to the whole-site document
   list, and opens a different document (the U.S. National Park Database).
4. Bounces back to the picker and flips through all eleven themes with `T`,
   landing on `goat`.
5. Reopens the page in the goat theme and lets the goat wander over the data.

## Tuning

- Adjust `Set TypingSpeed` and `Sleep` lines to taste. GitHub renders GIFs
  at their natural speed, so pacing matters more than file size.
- `Set Width` / `Set Height` control the recorded terminal size — the TUI
  reads them at startup.
- Themes (`T`) and the site switch (`s`) are driven from a **picker**, not
  the grid: in the grid every printable key starts editing the cell under the
  cursor, and VHS can't send the grid's `F12` theme key. The tape presses `T`
  9 times to walk from `default` to `goat`; if you add or reorder themes in
  the code, re-pace that run.
- Step 3 picks the second document by counting `Down` presses into the site's
  "most recently updated" list. That order drifts as templates are edited, so
  check the list and re-pace the `Down` count if you re-record.
- `gifsicle -O3 --lossy=90 --colors 200` roughly halves the GIF that VHS
  emits, with no visible loss on the terminal output.
