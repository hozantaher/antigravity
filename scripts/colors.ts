// Minimální ANSI barvy bez závislosti. Vypnuté při NO_COLOR nebo ne-TTY (→ čisté logy/pipe/redirect).
const on = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const w =
  (code: number) =>
  (s: string | number): string =>
    on ? `\x1b[${code}m${s}\x1b[0m` : String(s);

export const c = {
  red: w(31),
  green: w(32),
  yellow: w(33),
  blue: w(34),
  magenta: w(35),
  cyan: w(36),
  gray: w(90),
  bold: w(1),
  dim: w(2),
};

/** Barva podle stavu (struktura / outcome). */
export const stateColor = (state: string): string => {
  if (state === 'migrated' || state === 'written' || state === 'valid-dryrun') return c.green(state);
  if (state === 'partial') return c.yellow(state);
  if (state === 'unmigrated' || state === 'invalid' || state === 'no-story') return c.yellow(state);
  return state;
};
