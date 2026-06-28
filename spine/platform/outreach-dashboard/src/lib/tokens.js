// Design tokens. Mirror of CSS custom properties in index.css.
//
// Use in inline JSX styles as NUMBERS (px implied):
//   <div style={{ fontSize: T.text.sm, padding: T.s(3) }}>
//
// Use in Lucide/react-icons `size=` props:
//   <Icon size={T.icon.sm} />
//
// For CSS-only spots prefer the var() form in stylesheets.
// If density ever changes at runtime, call `readDensityTokens()` which
// resolves live var values from :root.

export const T = {
  text: {
    '2xs': 10,
    xs:    11,
    sm:    12,
    base:  13,
    md:    14,
    lg:    15,
    xl:    19,
    '2xl': 24,
    '3xl': 31,
  },
  s: (step) => {
    const scale = { 0: 2, 1: 3, 2: 6, 3: 10, 4: 13, 5: 15, 6: 19, 7: 25, 8: 37, 9: 51, 10: 76 }
    return scale[step] ?? step
  },
  icon: {
    '2xs': 8,
    xs:    10,
    sm:    11,
    md:    13,
    lg:    14,
    xl:    18,
    '2xl': 22,
    '3xl': 32,
  },
  radius: { sm: 3, base: 4, lg: 7 },
}

// Live-read actual tokens from :root (useful if data-density changes).
export function readDensityTokens() {
  if (typeof window === 'undefined') return T
  const root = getComputedStyle(document.documentElement)
  const px = name => {
    const v = root.getPropertyValue(name).trim()
    return v ? parseFloat(v) : undefined
  }
  return {
    text: {
      '2xs': px('--text-2xs') ?? T.text['2xs'],
      xs:    px('--text-xs')  ?? T.text.xs,
      sm:    px('--text-sm')  ?? T.text.sm,
      base:  px('--text-base') ?? T.text.base,
      md:    px('--text-md')  ?? T.text.md,
      lg:    px('--text-lg')  ?? T.text.lg,
      xl:    px('--text-xl')  ?? T.text.xl,
      '2xl': px('--text-2xl') ?? T.text['2xl'],
    },
    icon: {
      xs: px('--icon-xs') ?? T.icon.xs,
      sm: px('--icon-sm') ?? T.icon.sm,
      md: px('--icon-md') ?? T.icon.md,
      lg: px('--icon-lg') ?? T.icon.lg,
      xl: px('--icon-xl') ?? T.icon.xl,
    },
  }
}
