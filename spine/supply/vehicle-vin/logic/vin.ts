// ISO 3779 VIN: 17 chars, letters I/O/Q excluded (they would be confused with 1/0).
// The character class [A-HJ-NPR-Z0-9] omits I, O and Q.
export const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/

export const isValidVin = (vin: string): boolean => VIN_RE.test(vin.trim().toUpperCase())
