// AV-F3 — Czech machinery / vehicle brand + body-type dictionary.
// ─────────────────────────────────────────────────────────────────────────────
// Pure data module consumed by vehicleExtractor.js. No I/O, no imports — kept
// trivially testable + zero-cost import.
//
// Source-of-truth note: lists derived from real inbound reply samples observed
// in the operator queue 2026-04 → 2026-05 plus authorized-dealer brand
// universe (Garaaage truck/van/excavator outreach). When a brand name shows
// up consistently in incoming offers AND maps cleanly to a Czech B2B
// machinery seller, it lands here. No speculative brands — every entry has
// a real reply on record.
//
// Ordering: case-insensitive alphabetical across the entire list. Grouping by
// vehicle category lives in commentary only — the runtime BRANDS array is
// flat-sorted so the audit ratchet (case-insensitive lexicographic sort) can
// detect insertion drift. The longer "Mercedes-Benz" intentionally sits
// alongside "Mercedes" — vehicleExtractor.canonicalBrand normalizes both to
// "Mercedes" so the modal stays predictable.
//
// HARD rules tied:
//   feedback_no_speculation — every brand sourced from real reply samples
//   feedback_no_magic_thresholds — list size constants exported below for
//     test assertions; downstream extractor uses these too where applicable
//
// Vehicle-category notes (commentary-only):
//   Excavators/construction: Atlas, Bobcat, Case, Caterpillar, Doosan,
//     Hitachi, Hyundai, JCB, Komatsu, Kubota, Liebherr, New Holland,
//     Takeuchi, Terex, Wacker, Yanmar
//   Trucks/heavy commercial: DAF, Fiat, Ford, Iveco, MAN, Mercedes,
//     Mercedes-Benz, Renault, Scania, Tatra, Volvo
//   Vans / LCVs (sub-brands operator treats as their own marque):
//     Crafter, Ducato, Master, Movano, Sprinter, Transit
//   Agricultural: Claas, Deutz, Fendt, John Deere, Massey Ferguson, Same,
//     Steyr, Valtra, Zetor

// ── Brands ───────────────────────────────────────────────────────────────────
// Stored in canonical case (capitalized) — the regex is case-insensitive and
// the extractor normalizes matched text against this list to produce a
// consistent `make` field (e.g. "HITACHI" / "hitachi" → "Hitachi").
//
// Note: "CAT" deliberately omitted as a standalone — the extractor matches
// the substring via Caterpillar's regex and "CAT" alone collides too often
// with English noise ("CAT scan", "category"). Operator can still type "CAT"
// manually in the modal.
export const BRANDS = Object.freeze([
  'Atlas',
  'BMW',
  'Bobcat',
  'Case',
  'Caterpillar',
  'Claas',
  'Crafter',
  'Dacia',
  'DAF',
  'Deutz',
  'Doosan',
  'Ducato',
  'Fendt',
  'Fiat',
  'Ford',
  'Hitachi',
  'Hyundai',
  'Iveco',
  'JCB',
  'Jeep',
  'John Deere',
  'Komatsu',
  'Kubota',
  'Liebherr',
  'MAN',
  'Massey Ferguson',
  'Master',
  'Mazda',
  'Mercedes',
  'Mercedes-Benz',
  'Movano',
  'New Holland',
  'Renault',
  'Same',
  'Scania',
  'Sprinter',
  'Steyr',
  'Takeuchi',
  'Tatra',
  'Terex',
  'Transit',
  'Valtra',
  'Volkswagen',
  'Volvo',
  'Wacker',
  'Yanmar',
  'Zetor',
])

// Body types — Czech-language descriptors that frequently appear alongside
// (or instead of) a brand in inbound replies. Used as a secondary axis to
// describe the vehicle category when the operator scans the modal.
//
// Multi-word entries kept in the list so the regex can grab the longest
// match first (e.g. "kolový bagr" beats "bagr" alone).
// Stored in a single flat list, case-insensitive alphabetic order. Grouping
// (excavators / loaders / cranes / trucks / agricultural) is commentary only.
export const BODY_TYPES = Object.freeze([
  'autojeřáb',
  'bagr',
  'dodávka',
  'jeřáb',
  'kloubový nakladač',
  'kolový bagr',
  'kolový nakladač',
  'kombajn',
  'manipulátor',
  'mini bagr',
  'mobilní jeřáb',
  'mulčovač',
  'nakladač',
  'pásový bagr',
  'plachta',
  'silosázecí',
  'sklopka',
  'skříňák',
  'smykem řízený nakladač',
  'tahač',
  'teleskopický manipulátor',
  'traktor',
  'valník',
])

// Exposed sizes so tests can ratchet on growth without re-counting by hand.
export const BRAND_COUNT = BRANDS.length
export const BODY_TYPE_COUNT = BODY_TYPES.length
