import { createHmac, randomBytes } from 'node:crypto'

// Raw third-party API tokens: `grg_` + 256 bits of hex entropy. Only the HMAC of
// this value is stored, so the plaintext is shown exactly once at creation.
export const API_TOKEN_PREFIX = 'grg_'

export const generateApiToken = (): string => API_TOKEN_PREFIX + randomBytes(32).toString('hex')

// HMAC-SHA256 keyed with INTERNAL_API_SECRET (pepper): the high token entropy makes
// a per-token salt unnecessary, and the key blocks offline hash lookups if the DB leaks.
export const hashApiToken = (token: string, secret: string): string =>
  createHmac('sha256', secret).update(token).digest('hex')

export const apiTokenDisplayPrefix = (token: string): string => token.slice(0, 12)
