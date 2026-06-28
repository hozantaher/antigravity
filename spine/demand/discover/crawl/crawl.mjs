// Crawl — map a portal's public surface (pages + forms) into a catalog, RESPECTING robots.txt:
// a disallowed path is never catalogued. Input for the learn phase; no live traffic in the PoC.
export function crawl(pages, robotsDisallow = []) {
  const allowed = pages.filter((p) => !robotsDisallow.some((r) => p.path.startsWith(r)))
  return {
    pages: allowed.map((p) => p.path),
    forms: allowed.flatMap((p) => (p.forms || []).map((f) => ({ page: p.path, fields: f.fields }))),
    skippedByRobots: pages.length - allowed.length,
  }
}
