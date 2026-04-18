// ANSI escape codes
const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const REVERSE = `${ESC}7m`;
const UNDERLINE = `${ESC}4m`;
// Green on black, like a phosphor monitor
const GREEN_FG = `${ESC}32m`;
const BRIGHT_GREEN_FG = `${ESC}92m`;
// Lotus 1-2-3 style: white on blue
const BLUE_BG = `${ESC}44m`;
const WHITE_FG = `${ESC}97m`;
const BRIGHT_CYAN_FG = `${ESC}96m`;
// Amber phosphor (VT220/VAX terminal)
const AMBER_FG = `${ESC}38;5;214m`;       // 256-color: orange/amber
const BRIGHT_AMBER_FG = `${ESC}38;5;220m`; // brighter amber/yellow
const DIM_AMBER_FG = `${ESC}38;5;172m`;    // dimmer amber/dark orange
// Paper: dark text on white/light gray
const BLACK_FG = `${ESC}30m`;
const DARK_GRAY_FG = `${ESC}90m`;
const WHITE_BG = `${ESC}47m`;
// DOS / CP437 palette: bright yellow on blue, cyan labels, gray screen
const YELLOW_FG = `${ESC}93m`;
const CYAN_FG = `${ESC}36m`;
const GRAY_FG = `${ESC}37m`;
const DARK_BLUE_BG = `${ESC}48;5;18m`;     // 256-color: deep navy
const BRIGHT_BLUE_BG = `${ESC}48;5;21m`;   // 256-color: IBM-blue
// Matrix palette: scanning-line greens
const MATRIX_GREEN = `${ESC}38;5;46m`;     // pure phosphor green
const MATRIX_DIM = `${ESC}38;5;28m`;       // muted green for trails
const MATRIX_BRIGHT = `${ESC}38;5;118m`;   // highlight green
const BLACK_BG = `${ESC}40m`;
// Commodore 64 palette: light blue on navy, pastel accents
const C64_LIGHT_BLUE = `${ESC}38;5;111m`;  // approx C64 "light blue" #8EAFDF
const C64_WHITE = `${ESC}38;5;255m`;
const C64_NAVY_BG = `${ESC}48;5;19m`;      // approx C64 "blue" #4242B4
// Goat palette: cream paper + pastel meadow, earthy browns for text
const GOAT_CREAM_BG = `${ESC}48;5;230m`;   // warm cream
const GOAT_PASTURE_BG = `${ESC}48;5;194m`; // soft spring green
const GOAT_BROWN_FG = `${ESC}38;5;94m`;    // walnut brown
const GOAT_DARK_FG = `${ESC}38;5;52m`;     // deep maroon-brown
const GOAT_MEADOW_FG = `${ESC}38;5;28m`;   // deep grass green

/**
 * A theme controls all visual styling: ANSI formatting, box-drawing characters,
 * and text chrome used by the renderer.
 */
export interface Theme {
  // ANSI style sequences (each should be self-contained, paired with reset)
  titleBar: (text: string) => string;
  titleBarDim: (text: string) => string;
  columnHeader: (text: string) => string;
  rowNumber: (text: string) => string;
  cursor: (text: string) => string;
  fieldLabel: (text: string) => string;
  fieldLabelActive: (text: string) => string;
  helpBar: (text: string) => string;
  pickerSelected: (text: string) => string;

  // Box-drawing / separator characters
  colSeparator: string;     // between columns in data rows (e.g. " │ " or "  ")
  headerSeparator: string;  // between columns in header (e.g. " │ " or "  ")
  rowSepChar: string;       // horizontal rule character (e.g. "─" or "-")
  crossChar: string;        // intersection of row sep and col sep (e.g. "┼" or "+")
  borderHoriz: string;      // horizontal border between panes (e.g. "─" or "-")
  borderVert: string;       // vertical border between panes (e.g. "│" or "|")

  // Layout control
  headerSepLine: boolean;   // whether to draw the ---+--- line below column headers
  screenBg: string;         // ANSI sequence applied to the whole screen background (e.g. blue bg)

  // Title formatting
  titleFormat: (label: string, detail: string) => string;
  pickerTitleFormat: (label: string) => string;
}

export const defaultTheme: Theme = {
  titleBar: (text) => REVERSE + text + RESET,
  titleBarDim: (text) => DIM + REVERSE + text + RESET,
  columnHeader: (text) => BOLD + text + RESET,
  rowNumber: (text) => text,
  cursor: (text) => REVERSE + text + RESET,
  fieldLabel: (text) => DIM + text + RESET,
  fieldLabelActive: (text) => BOLD + text + RESET,
  helpBar: (text) => BOLD + text + RESET,
  pickerSelected: (text) => REVERSE + text + RESET,

  colSeparator: " \u2502 ",
  headerSeparator: " \u2502 ",
  rowSepChar: "\u2500",
  crossChar: "\u253c",
  borderHoriz: "\u2500",
  borderVert: "\u2502",
  headerSepLine: true,
  screenBg: "",

  titleFormat: (label, detail) => ` Grist Console \u2014 ${label} ${detail} `,
  pickerTitleFormat: (label) => ` Grist Console \u2014 ${label} `,
};

/**
 * VisiCalc theme: green phosphor monitor with the classic "inverted L" frame.
 * Status line, column headers, and row numbers are all inverse video (the L).
 * Data cells are plain green on black. No cell separators, no header sep line.
 *
 * The title format evokes the Apple II VisiCalc status row: a blinking-cell
 * indicator (`!`) and the global recalc arrow (`C` = column-major). Those are
 * fixed for now -- the point is the look.
 */
export const visicalcTheme: Theme = {
  titleBar: (text) => GREEN_FG + REVERSE + text + RESET,
  titleBarDim: (text) => GREEN_FG + REVERSE + text + RESET,
  columnHeader: (text) => GREEN_FG + REVERSE + text + RESET,
  rowNumber: (text) => GREEN_FG + REVERSE + text + RESET,
  cursor: (text) => REVERSE + text + RESET,
  fieldLabel: (text) => GREEN_FG + text + RESET,
  fieldLabelActive: (text) => GREEN_FG + REVERSE + text + RESET,
  helpBar: (text) => GREEN_FG + text + RESET,
  pickerSelected: (text) => REVERSE + text + RESET,

  colSeparator: "  ",
  headerSeparator: "  ",
  rowSepChar: "",
  crossChar: "",
  borderHoriz: "-",
  borderVert: "|",
  headerSepLine: false,
  screenBg: "",

  // The slash prefix is VisiCalc's command indicator; C = column-major
  // recalc order; ! = cursor-direction marker. Static for now, but the
  // silhouette matches the real status row.
  titleFormat: (label, detail) => ` /${label}${detail ? " " + detail : ""}   C !`,
  pickerTitleFormat: (label) => ` /${label}   C !`,
};

/**
 * DOS theme: IBM PC / Norton-Commander vibes. CP437 double-line borders,
 * yellow-on-blue title chrome, bright-cyan column headers, white-on-blue
 * data cells, deep-blue full-screen background. The `titleFormat` wraps
 * the label in `╡ ╞` frame-filler arms -- the same decoration MS-DOS apps
 * used to break up their menu bars.
 */
export const dosTheme: Theme = {
  titleBar: (text) => YELLOW_FG + BOLD + BRIGHT_BLUE_BG + text + RESET,
  titleBarDim: (text) => GRAY_FG + BRIGHT_BLUE_BG + text + RESET,
  columnHeader: (text) => BRIGHT_CYAN_FG + BOLD + BRIGHT_BLUE_BG + text + RESET,
  rowNumber: (text) => YELLOW_FG + BRIGHT_BLUE_BG + text + RESET,
  cursor: (text) => BLACK_FG + `${ESC}47m` + text + RESET,
  fieldLabel: (text) => GRAY_FG + BRIGHT_BLUE_BG + text + RESET,
  fieldLabelActive: (text) => YELLOW_FG + BOLD + BRIGHT_BLUE_BG + text + RESET,
  helpBar: (text) => BLACK_FG + `${ESC}46m` + text + RESET,   // black on cyan -- DOS help line
  pickerSelected: (text) => BLACK_FG + `${ESC}47m` + text + RESET,

  colSeparator: " \u2551 ",   // ║
  headerSeparator: " \u2551 ", // ║
  rowSepChar: "\u2550",        // ═
  crossChar: "\u256C",         // ╬
  borderHoriz: "\u2550",       // ═
  borderVert: "\u2551",        // ║
  headerSepLine: true,
  screenBg: BRIGHT_BLUE_BG + WHITE_FG,

  titleFormat: (label, detail) => `\u2561 ${label}${detail ? " " + detail : ""} \u255E`, // ╡ ... ╞
  pickerTitleFormat: (label) => `\u2561 ${label} \u255E`,
};

/**
 * Matrix theme: falling-green-rain aesthetic. Shade-block row separators
 * (`▓`) give the grid a dense, scanning-line texture; column headers glow
 * (bright-green + bold + underline) like the "wake me up" prompt; the
 * title bar uses `//` double-slash bookends instead of ` `, so every pane
 * has a touch of terminal-BBS decoration.
 */
export const matrixTheme: Theme = {
  titleBar: (text) => MATRIX_BRIGHT + REVERSE + BOLD + text + RESET,
  titleBarDim: (text) => MATRIX_DIM + REVERSE + text + RESET,
  columnHeader: (text) => MATRIX_BRIGHT + BOLD + UNDERLINE + text + RESET,
  rowNumber: (text) => MATRIX_DIM + text + RESET,
  cursor: (text) => BLACK_FG + `${ESC}102m` + text + RESET, // black on bright green
  fieldLabel: (text) => MATRIX_DIM + text + RESET,
  fieldLabelActive: (text) => MATRIX_BRIGHT + BOLD + text + RESET,
  helpBar: (text) => MATRIX_GREEN + BOLD + text + RESET,
  pickerSelected: (text) => BLACK_FG + `${ESC}102m` + text + RESET,

  colSeparator: MATRIX_DIM + " \u2502 " + RESET,
  headerSeparator: MATRIX_DIM + " \u2502 " + RESET,
  rowSepChar: "\u2593",        // ▓ -- dense phosphor trail
  crossChar: "\u2588",         // █ -- full block at intersections
  borderHoriz: "\u2592",       // ▒ -- medium shade between panes
  borderVert: "\u2592",
  headerSepLine: true,
  screenBg: BLACK_BG + MATRIX_GREEN,

  titleFormat: (label, detail) => `// ${label}${detail ? " " + detail : ""} //`,
  pickerTitleFormat: (label) => `// ${label} //`,
};

/**
 * Commodore 64 theme: light blue on navy, echoing the startup screen.
 * Borders use block quadrants (▖▗▘▝) to hint at PETSCII's pixel-art grid.
 * Title format adds stars (★) like a READY prompt banner.
 */
export const c64Theme: Theme = {
  titleBar: (text) => C64_WHITE + BOLD + C64_NAVY_BG + text + RESET,
  titleBarDim: (text) => C64_LIGHT_BLUE + C64_NAVY_BG + text + RESET,
  columnHeader: (text) => C64_WHITE + BOLD + C64_NAVY_BG + text + RESET,
  rowNumber: (text) => C64_LIGHT_BLUE + C64_NAVY_BG + text + RESET,
  cursor: (text) => `${ESC}48;5;111m${ESC}30m` + text + RESET,  // black on light-blue
  fieldLabel: (text) => C64_LIGHT_BLUE + C64_NAVY_BG + text + RESET,
  fieldLabelActive: (text) => C64_WHITE + BOLD + C64_NAVY_BG + text + RESET,
  helpBar: (text) => C64_WHITE + BOLD + C64_NAVY_BG + text + RESET,
  pickerSelected: (text) => C64_NAVY_BG + `${ESC}48;5;111m` + `${ESC}30m` + text + RESET,

  colSeparator: " \u2595 ",    // ▕ right-half block
  headerSeparator: " \u2595 ",
  rowSepChar: "\u2581",        // ▁ one eighth block (low)
  crossChar: "\u258F",         // ▏ left-eighth block
  borderHoriz: "\u2584",       // ▄ lower half
  borderVert: "\u258C",        // ▌ left half
  headerSepLine: true,
  screenBg: C64_NAVY_BG + C64_LIGHT_BLUE,

  titleFormat: (label, detail) => `\u2605 ${label}${detail ? " " + detail : ""} \u2605`, // ★
  pickerTitleFormat: (label) => `\u2605 ${label} \u2605`,
};

/**
 * Lotus 1-2-3 style: bright white text on a blue background.
 * Status line and cursor in reverse (white bg, dark text).
 */
export const lotus123Theme: Theme = {
  titleBar: (text) => WHITE_FG + REVERSE + BLUE_BG + text + RESET,
  titleBarDim: (text) => WHITE_FG + REVERSE + BLUE_BG + text + RESET,
  columnHeader: (text) => BRIGHT_CYAN_FG + BLUE_BG + text + RESET,
  rowNumber: (text) => BRIGHT_CYAN_FG + BLUE_BG + text + RESET,
  cursor: (text) => REVERSE + BLUE_BG + text + RESET,
  fieldLabel: (text) => BRIGHT_CYAN_FG + BLUE_BG + text + RESET,
  fieldLabelActive: (text) => WHITE_FG + BOLD + BLUE_BG + text + RESET,
  helpBar: (text) => WHITE_FG + REVERSE + BLUE_BG + text + RESET,
  pickerSelected: (text) => REVERSE + BLUE_BG + text + RESET,

  colSeparator: "  ",
  headerSeparator: "  ",
  rowSepChar: "",
  crossChar: "",
  borderHoriz: "-",
  borderVert: "|",
  headerSepLine: false,
  screenBg: BLUE_BG + WHITE_FG,

  titleFormat: (label, detail) => ` ${label} ${detail} `,
  pickerTitleFormat: (label) => ` ${label} `,
};

// Rainbow helpers
const RAINBOW_FGS = [
  `${ESC}91m`, // red
  `${ESC}93m`, // yellow
  `${ESC}92m`, // green
  `${ESC}96m`, // cyan
  `${ESC}94m`, // blue
  `${ESC}95m`, // magenta
];

function rainbow(text: string, offset = 0): string {
  let out = "";
  let ci = offset;
  for (const ch of text) {
    if (ch === " ") {
      out += ch;
    } else {
      out += RAINBOW_FGS[ci % RAINBOW_FGS.length] + ch;
      ci++;
    }
  }
  return out + RESET;
}

function rainbowReverse(text: string, offset = 0): string {
  let out = "";
  let ci = offset;
  for (const ch of text) {
    if (ch === " ") {
      out += REVERSE + ch;
    } else {
      out += RAINBOW_FGS[ci % RAINBOW_FGS.length] + REVERSE + ch;
      ci++;
    }
  }
  return out + RESET;
}

// Use a shifting offset so each call gets different starting colors
let rainbowCounter = 0;

/**
 * Rainbow theme: every element gets a different color from the rainbow.
 * Title bars cycle colors per character. Very festive.
 */
export const rainbowTheme: Theme = {
  titleBar: (text) => rainbowReverse(text, rainbowCounter++),
  titleBarDim: (text) => rainbowReverse(text, rainbowCounter++),
  columnHeader: (text) => BOLD + rainbow(text, 0) + RESET,
  rowNumber: (text) => `${ESC}95m` + text + RESET,
  cursor: (text) => rainbowReverse(text, rainbowCounter++),
  fieldLabel: (text) => `${ESC}96m` + text + RESET,
  fieldLabelActive: (text) => BOLD + `${ESC}93m` + text + RESET,
  helpBar: (text) => rainbow(text, 3),
  pickerSelected: (text) => rainbowReverse(text, rainbowCounter++),

  colSeparator: " \u2502 ",
  headerSeparator: " \u2502 ",
  rowSepChar: "\u2500",
  crossChar: "\u253c",
  borderHoriz: "\u2500",
  borderVert: "\u2502",
  headerSepLine: true,
  screenBg: "",

  titleFormat: (label, detail) => ` \u2728 ${label} ${detail} \u2728 `,
  pickerTitleFormat: (label) => ` \u2728 ${label} \u2728 `,
};

/**
 * Boring theme: no styling whatsoever. No bold, no dim, no reverse, no color.
 * Plain ASCII. Like piping to a file.
 */
export const boringTheme: Theme = {
  titleBar: (text) => text,
  titleBarDim: (text) => text,
  columnHeader: (text) => text,
  rowNumber: (text) => text,
  cursor: (text) => `${ESC}4m` + text + RESET,
  fieldLabel: (text) => text,
  fieldLabelActive: (text) => text,
  helpBar: (text) => text,
  pickerSelected: (text) => text,

  colSeparator: " | ",
  headerSeparator: " | ",
  rowSepChar: "-",
  crossChar: "+",
  borderHoriz: "-",
  borderVert: "|",
  headerSepLine: true,
  screenBg: "",

  titleFormat: (label, detail) => ` ${label} ${detail} `,
  pickerTitleFormat: (label) => ` ${label} `,
};

/**
 * Amber theme: VT220/VAX terminal with amber phosphor. Reverse video
 * status bars and column headers, dim amber for secondary elements.
 * DEC Special Graphics box drawing. The classic VAX/VMS look.
 */
export const amberTheme: Theme = {
  titleBar: (text) => AMBER_FG + REVERSE + text + RESET,
  titleBarDim: (text) => DIM_AMBER_FG + REVERSE + text + RESET,
  columnHeader: (text) => BRIGHT_AMBER_FG + UNDERLINE + text + RESET,
  rowNumber: (text) => DIM_AMBER_FG + text + RESET,
  cursor: (text) => AMBER_FG + REVERSE + text + RESET,
  fieldLabel: (text) => DIM_AMBER_FG + text + RESET,
  fieldLabelActive: (text) => BRIGHT_AMBER_FG + text + RESET,
  helpBar: (text) => AMBER_FG + REVERSE + text + RESET,
  pickerSelected: (text) => AMBER_FG + REVERSE + text + RESET,

  colSeparator: " \u2502 ",
  headerSeparator: " \u2502 ",
  rowSepChar: "\u2500",
  crossChar: "\u253c",
  borderHoriz: "\u2500",
  borderVert: "\u2502",
  headerSepLine: true,
  screenBg: "",

  titleFormat: (label, detail) => ` ${label} ${detail} `,
  pickerTitleFormat: (label) => ` ${label} `,
};

/**
 * Paper theme: dark text on a white background. Like a printed spreadsheet
 * or a document on screen. Understated, high contrast, easy to read.
 */
export const paperTheme: Theme = {
  titleBar: (text) => BLACK_FG + REVERSE + WHITE_BG + text + RESET,
  titleBarDim: (text) => DARK_GRAY_FG + REVERSE + WHITE_BG + text + RESET,
  columnHeader: (text) => BLACK_FG + BOLD + WHITE_BG + text + RESET,
  rowNumber: (text) => DARK_GRAY_FG + WHITE_BG + text + RESET,
  cursor: (text) => REVERSE + WHITE_BG + text + RESET,
  fieldLabel: (text) => DARK_GRAY_FG + WHITE_BG + text + RESET,
  fieldLabelActive: (text) => BLACK_FG + BOLD + WHITE_BG + text + RESET,
  helpBar: (text) => DARK_GRAY_FG + WHITE_BG + text + RESET,
  pickerSelected: (text) => REVERSE + WHITE_BG + text + RESET,

  colSeparator: " \u2502 ",
  headerSeparator: " \u2502 ",
  rowSepChar: "\u2500",
  crossChar: "\u253c",
  borderHoriz: "\u2500",
  borderVert: "\u2502",
  headerSepLine: true,
  screenBg: WHITE_BG + BLACK_FG,

  titleFormat: (label, detail) => ` ${label} ${detail} `,
  pickerTitleFormat: (label) => ` ${label} `,
};

/**
 * Goat theme: cream paper with a soft meadow pasture tint. Brown-ink
 * headers, deep-green labels. Paired with the goat animation, which
 * wanders the focused pane munching cells (see GoatAnimation.ts).
 */
export const goatTheme: Theme = {
  titleBar: (text) => GOAT_DARK_FG + BOLD + GOAT_PASTURE_BG + text + RESET,
  titleBarDim: (text) => GOAT_BROWN_FG + GOAT_PASTURE_BG + text + RESET,
  columnHeader: (text) => GOAT_DARK_FG + BOLD + GOAT_CREAM_BG + text + RESET,
  rowNumber: (text) => GOAT_MEADOW_FG + GOAT_CREAM_BG + text + RESET,
  cursor: (text) => GOAT_CREAM_BG + REVERSE + text + RESET,
  fieldLabel: (text) => GOAT_BROWN_FG + GOAT_CREAM_BG + text + RESET,
  fieldLabelActive: (text) => GOAT_DARK_FG + BOLD + GOAT_CREAM_BG + text + RESET,
  helpBar: (text) => GOAT_DARK_FG + GOAT_PASTURE_BG + text + RESET,
  pickerSelected: (text) => GOAT_CREAM_BG + REVERSE + text + RESET,

  colSeparator: " \u2502 ",
  headerSeparator: " \u2502 ",
  rowSepChar: "\u2500",
  crossChar: "\u253c",
  borderHoriz: "\u2500",
  borderVert: "\u2502",
  headerSepLine: true,
  screenBg: GOAT_CREAM_BG + GOAT_BROWN_FG,

  titleFormat: (label, detail) => ` \u{1F410} ${label}${detail ? " " + detail : ""} `,
  pickerTitleFormat: (label) => ` \u{1F410} ${label} `,
};

const themes: Record<string, Theme> = {
  default: defaultTheme,
  visicalc: visicalcTheme,
  lotus: lotus123Theme,
  dos: dosTheme,
  matrix: matrixTheme,
  c64: c64Theme,
  amber: amberTheme,
  paper: paperTheme,
  rainbow: rainbowTheme,
  goat: goatTheme,
  boring: boringTheme,
};

/** True if the theme is the goat theme (enables the wandering animation). */
export function isGoatTheme(t: Theme): boolean {
  return t === goatTheme;
}

export function getTheme(name: string): Theme {
  const theme = themes[name];
  if (!theme) {
    const available = Object.keys(themes).join(", ");
    throw new Error(`Unknown theme "${name}". Available themes: ${available}`);
  }
  return theme;
}

export function getThemeNames(): string[] {
  return Object.keys(themes);
}

/**
 * Given the current theme, return the next theme in the cycle and its name.
 */
export function cycleTheme(current: Theme): { name: string; theme: Theme } {
  const names = Object.keys(themes);
  const currentIdx = names.findIndex(n => themes[n] === current);
  const nextIdx = (currentIdx + 1) % names.length;
  return { name: names[nextIdx], theme: themes[names[nextIdx]] };
}
