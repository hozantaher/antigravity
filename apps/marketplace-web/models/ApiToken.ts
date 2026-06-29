// Admin-issued API token for third-party programmatic access. Dates are epoch-ms
// (FE contract); the raw token is only present in ApiTokenCreated, shown once.
export interface ApiTokenRow {
  id: string
  name: string
  tokenPrefix: string
  createdBy: string
  createdByName: string | null
  createdAt: number
  lastUsedAt: number | null
}

export interface ApiTokenCreated {
  token: string
  row: ApiTokenRow
}
