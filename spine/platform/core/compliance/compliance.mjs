// Compliance — the platform guardrail (ADR 0002): read drops seller PII + respects robots.txt;
// write runs only on OUR authorized accounts. Nothing we wouldn't do by hand with full authorization.
const PII_KEYS = ['sellerName', 'sellerPhone', 'sellerEmail']

export function dropPII(record) {
  const clean = { ...record }
  for (const k of PII_KEYS) delete clean[k]
  return clean
}

export function robotsAllowed(path, disallow = []) {
  return !disallow.some((rule) => path.startsWith(rule))
}

export function writeAuthorized(account, ourAccounts = []) {
  return ourAccounts.includes(account)
}
