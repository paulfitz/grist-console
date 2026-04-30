/**
 * Galaxy-spiral / hyperdrive transition shown while listSiteDocs is in
 * flight. Multiple arms of particles spiral outward from the centre of
 * the terminal, in the active theme's accent colours. Each frame paints
 * over the alt-screen; runs only as long as the caller's predicate
 * returns true (i.e. while the network call is still pending), so a
 * fast site listing barely shows a frame and a slow one keeps spinning.
 */

import { Theme } from "./ConsoleTheme.js";

const FRAME_MS = 50;             // ~20 fps -- smooth enough, cheap enough
const NUM_ARMS = 6;
const PARTICLES_PER_ARM = 12;
const ARM_SWEEP = Math.PI * 2.0; // how much each arm spirals over its length
const ASPECT = 0.5;              // terminal cells are taller than wide

/**
 * Run the spiral until `keepGoing()` returns false. Each frame is
 * synchronously painted and then the loop yields for FRAME_MS. Resolves
 * once `keepGoing()` flips to false.
 */
export async function runHyperdrive(theme: Theme, keepGoing: () => boolean): Promise<void> {
  if (!process.stdout.isTTY) { return; }
  let frame = 0;
  while (keepGoing()) {
    paintFrame(theme, frame);
    frame++;
    await sleep(FRAME_MS);
  }
}

function paintFrame(theme: Theme, frame: number): void {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const cx = cols / 2;
  const cy = rows / 2;
  const maxR = Math.min(cols / 2, (rows / 2) / ASPECT) * 1.05;
  const t = frame * 0.08; // time parameter, advances each frame

  // Re-paint the screen background each frame so the spiral sits on a
  // themed surface (otherwise particles look stranded on whatever was
  // underneath, e.g. the page picker).
  let out = (theme.screenBg || "") + "\x1b[2J\x1b[H";

  // Track which character to draw at each (y,x), keeping the brightest.
  // Naive last-write-wins would let dim trail particles erase bright
  // leading-edge ones if their order was unlucky.
  const buf = new Map<number, { ch: string; layer: 0 | 1 | 2 }>();
  const set = (x: number, y: number, ch: string, layer: 0 | 1 | 2) => {
    if (x < 0 || x >= cols || y < 0 || y >= rows) { return; }
    const key = y * cols + x;
    const existing = buf.get(key);
    if (!existing || existing.layer < layer) {
      buf.set(key, { ch, layer });
    }
  };

  for (let arm = 0; arm < NUM_ARMS; arm++) {
    const baseAngle = (arm / NUM_ARMS) * Math.PI * 2 + t;
    for (let p = 0; p < PARTICLES_PER_ARM; p++) {
      const along = p / (PARTICLES_PER_ARM - 1); // 0 (centre) .. 1 (rim)
      const r = along * maxR;
      const angle = baseAngle + along * ARM_SWEEP;
      const x = Math.round(cx + r * Math.cos(angle));
      const y = Math.round(cy + r * Math.sin(angle) * ASPECT);
      // Brightest near the rim (the leading edge), dimmer toward centre.
      const layer = along > 0.7 ? 2 : along > 0.35 ? 1 : 0;
      const ch = layer === 2 ? "*" : layer === 1 ? "+" : "·";
      set(x, y, ch, layer);
    }
  }

  // Emit the buffer in row-major order so cursor-positioning escapes are
  // minimal-ish. (Could be optimised further but at 20fps it's fine.)
  for (const [key, { ch, layer }] of buf.entries()) {
    const x = key % cols;
    const y = Math.floor(key / cols);
    const styled = layer === 2 ? theme.fieldLabelActive(ch) :
                   layer === 1 ? theme.helpBar(ch) :
                                 theme.fieldLabel(ch);
    out += `\x1b[${y + 1};${x + 1}H${styled}`;
  }

  process.stdout.write(out);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
