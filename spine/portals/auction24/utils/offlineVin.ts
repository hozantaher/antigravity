// Offline, dependency-free VIN decoding — PURE VIN math, runnable on both client and server (no
// network, no secrets, no DB). Returns ONLY the fields actually ENCODED in the 17 VIN characters per
// ISO 3779/3780 — manufacturer (WMI), country/region, model year, plant code. Engine, dimensions,
// weight, CO2, emissions etc. are NOT in the VIN (they are a paid catalog / registry lookup — that
// is what Vincario sells). Lives in utils/ so the editor can decode client-side (no admin round-trip).

export interface OfflineVinInfo {
  valid: boolean
  manufacturer?: string
  country?: string
  region?: string
  yearOfManufacture?: number
  plantCode?: string
  // VIN check digit (position 9) is compulsory only in North America / China; European VINs
  // frequently fail it, so this is informational and must NOT be used as a hard validity gate.
  checkDigitValid?: boolean
}

// 17 chars, letters excluding I, O, Q.
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/

// WMI (positions 1–3) → manufacturer. SEED of high-confidence marques (EU-weighted). The full
// registry is ~500 codes — generate a complete table from the public SAE / Wikibooks WMI list and
// replace this map before relying on full coverage. Unknown WMI → manufacturer stays undefined.
const WMI: Record<string, string> = {
  WVW: 'Volkswagen',
  WV1: 'Volkswagen Commercial Vehicles',
  WV2: 'Volkswagen Bus/Van',
  '1VW': 'Volkswagen (USA)',
  '3VW': 'Volkswagen (Mexico)',
  WAU: 'Audi',
  WA1: 'Audi',
  TRU: 'Audi (Hungary)',
  WP0: 'Porsche',
  WP1: 'Porsche (SUV)',
  WBA: 'BMW',
  WBS: 'BMW M',
  WBY: 'BMW i',
  WMW: 'MINI',
  WDB: 'Mercedes-Benz',
  WDD: 'Mercedes-Benz',
  WDC: 'Mercedes-Benz (SUV)',
  W1K: 'Mercedes-Benz',
  WMA: 'MAN',
  TMB: 'Škoda',
  VSS: 'SEAT',
  W0L: 'Opel',
  VF1: 'Renault',
  VF6: 'Renault Trucks',
  VF3: 'Peugeot',
  VF7: 'Citroën',
  ZFA: 'Fiat',
  ZFF: 'Ferrari',
  ZAR: 'Alfa Romeo',
  ZAM: 'Maserati',
  ZCF: 'Iveco',
  YV1: 'Volvo',
  YS2: 'Scania',
  WF0: 'Ford (Europe)',
  SAL: 'Land Rover',
  SAJ: 'Jaguar',
  SCA: 'Rolls-Royce',
  SCB: 'Bentley',
  SCF: 'Aston Martin',
  SCC: 'Lotus',
  KMH: 'Hyundai',
  KNA: 'Kia',
  JHM: 'Honda',
  JN1: 'Nissan',
  JM1: 'Mazda',
  JF1: 'Subaru',
  '5YJ': 'Tesla',
  '1HG': 'Honda (USA)',
}

// Continent from the first VIN character (ISO 3780). Reliable; country sub-ranges are nuanced, so
// `country` below is a best-effort subset of the most common EU + global codes.
const regionFromChar = (c: string): string | undefined => {
  if (c >= 'A' && c <= 'H') return 'Africa'
  if (c >= 'J' && c <= 'R') return 'Asia'
  if (c >= 'S' && c <= 'Z') return 'Europe'
  if (c >= '1' && c <= '5') return 'North America'
  if (c >= '6' && c <= '7') return 'Oceania'
  if (c >= '8' && c <= '9') return 'South America'
  return undefined
}

// Best-effort country from positions 1–2 (ISO 3780). Covers the common EU + a few global codes;
// returns undefined when not confidently known (region is still set).
const countryFromVin = (vin: string): string | undefined => {
  const a = vin[0]!
  const b = vin[1]!
  if (a === 'W') return 'Germany'
  if (a === 'V') {
    if (b >= 'A' && b <= 'E') return 'Austria'
    if (b >= 'F' && b <= 'R') return 'France'
    if (b >= 'S' && b <= 'W') return 'Spain'
  }
  if (a === 'T') {
    if (b >= 'A' && b <= 'H') return 'Switzerland'
    if (b >= 'J' && b <= 'P') return 'Czech Republic'
    if (b >= 'R' && b <= 'V') return 'Hungary'
  }
  if (a === 'S') {
    if (b >= 'A' && b <= 'M') return 'United Kingdom'
    if (b >= 'N' && b <= 'T') return 'Germany'
    if (b >= 'U' && b <= 'Z') return 'Poland'
  }
  if (a === 'Z') return 'Italy'
  if (a === 'Y') {
    if (b >= 'A' && b <= 'E') return 'Belgium'
    if (b >= 'F' && b <= 'K') return 'Finland'
    if (b >= 'S' && b <= 'W') return 'Sweden'
  }
  if (a === '1' || a === '4' || a === '5') return 'United States'
  if (a === '2') return 'Canada'
  if (a === '3') return 'Mexico'
  if (a === 'J') return 'Japan'
  if (a === 'K' && b >= 'L' && b <= 'R') return 'South Korea'
  if (a === 'L') return 'China'
  return undefined
}

// Model-year codes for position 10, one 30-year cycle (1980–2009), excluding I/O/Q/U/Z/0.
const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789'

// The year letter repeats every 30 years (A = 1980 or 2010 or 2040…). The North-American position-7
// numeric/alpha disambiguation rule is NOT reliably followed by European makers, so instead pick the
// most recent cycle that is not in the future. Correct for current auction inventory; it would
// misdate a genuinely pre-~1996 vehicle to the recent cycle (acceptable + documented).
const yearFromVin = (vin: string, currentYear: number): number | undefined => {
  const p = YEAR_CODES.indexOf(vin[9]!)
  if (p < 0) return undefined
  let year = 1980 + p
  while (year + 30 <= currentYear + 1) year += 30
  return year
}

// VIN transliteration values for the ISO 3779 check-digit algorithm.
const TRANSLIT: Record<string, number> = {
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  E: 5,
  F: 6,
  G: 7,
  H: 8,
  J: 1,
  K: 2,
  L: 3,
  M: 4,
  N: 5,
  P: 7,
  R: 9,
  S: 2,
  T: 3,
  U: 4,
  V: 5,
  W: 6,
  X: 7,
  Y: 8,
  Z: 9,
}
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2]

const isCheckDigitValid = (vin: string): boolean => {
  let sum = 0
  for (let i = 0; i < 17; i++) {
    const ch = vin[i]!
    const v = ch >= '0' && ch <= '9' ? Number(ch) : (TRANSLIT[ch] ?? 0)
    sum += v * WEIGHTS[i]!
  }
  const remainder = sum % 11
  const expected = remainder === 10 ? 'X' : String(remainder)
  return vin[8] === expected
}

// Decode the offline-derivable fields. `currentYear` is injectable for deterministic tests.
export const decodeVinOffline = (raw: string, currentYear: number = new Date().getFullYear()): OfflineVinInfo => {
  const vin = raw.trim().toUpperCase()
  if (!VIN_RE.test(vin)) return { valid: false }
  return {
    valid: true,
    manufacturer: WMI[vin.slice(0, 3)],
    country: countryFromVin(vin),
    region: regionFromChar(vin[0]!),
    yearOfManufacture: yearFromVin(vin, currentYear),
    plantCode: vin[10],
    checkDigitValid: isCheckDigitValid(vin),
  }
}
