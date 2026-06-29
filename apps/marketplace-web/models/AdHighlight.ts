export interface AdHighlight {
  paramId?: number
  title: string
  value: string
  placeholder?: string
}

// Legacy auction24 stored highlight titles as i18n param codes (cpBrand, cpModel…) rather
// than display strings; seed/admin items store already-localized titles. Matches only the
// code shape so human free-text titles are never mistaken for keys.
export const isLegacyParamCode = (title: string): boolean => /^cp[A-Z]\w*$/.test(title.trim())

// Minimal i18n surface for resolving a highlight label: key-existence + translator. Lets the
// resolver stay pure (testable against real locale data) while the caller wires vue-i18n te/t.
export interface HighlightI18n {
  has: (key: string) => boolean
  translate: (key: string) => string
}

// Resolve a highlight title to a display label: a legacy param code is translated when a
// matching key exists; already-localized titles (and unknown codes) pass through unchanged.
export const resolveHighlightLabel = (title: string, i18n: HighlightI18n): string =>
  isLegacyParamCode(title) && i18n.has(title) ? i18n.translate(title) : title

// Public highlight list: pick the best-filled per-locale array (active → cz → en → first
// non-empty) and drop blank-label drafts. Pure — caller resolves labels via i18n.
export const selectPublicHighlights = (
  byLang: Record<string, AdHighlight[]> | null | undefined,
  localeKey: string,
): AdHighlight[] => {
  const all = byLang ?? {}
  const pick = (key: string) => (all[key]?.length ? all[key] : undefined)
  const list = pick(localeKey) ?? pick('cz') ?? pick('en') ?? Object.values(all).find(a => a?.length) ?? []
  return list.filter(h => h.title?.trim())
}
