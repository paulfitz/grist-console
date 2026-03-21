// ANSI escape codes
const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const REVERSE = `${ESC}7m`;
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
const UNDERLINE = `${ESC}4m`;

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

  titleFormat: (label, detail) => ` ${label} ${detail} `,
  pickerTitleFormat: (label) => ` ${label} `,
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

const themes: Record<string, Theme> = {
  default: defaultTheme,
  visicalc: visicalcTheme,
  lotus: lotus123Theme,
  amber: amberTheme,
  paper: paperTheme,
  rainbow: rainbowTheme,
  boring: boringTheme,
};

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
