// search.js — GET /api/search?q= — cross-entity global search.
//
// The data-mining entry point: one query fans out across replies, vehicles,
// contacts, companies and CRM clients and returns the top hits per type, each
// with the id/ico the surfaces deep-link on. Read-only. Each arm is LIMITed
// small so it stays fast even on the 405k/426k contact/company tables (Postgres
// stops at the limit). Trigram-free ILIKE — same pattern the per-entity search
// boxes already use.

const PER_TYPE_LIMIT = 6
const MIN_Q = 2

export function mountSearchRoute(app, deps) {
  const { pool, capture500, safeError } = deps

  app.get('/api/search', async (req, res) => {
    try {
      const q = (req.query.q || '').toString().trim()
      if (q.length < MIN_Q) {
        return res.json({ q, replies: [], vehicles: [], contacts: [], companies: [], crm: [] })
      }
      const like = `%${q}%`
      const L = PER_TYPE_LIMIT

      const [replies, vehicles, contacts, companies, crm] = await Promise.all([
        pool.query(
          `SELECT id, from_email, subject, classification, received_at
             FROM reply_inbox
            WHERE from_email ILIKE $1 OR subject ILIKE $1
            ORDER BY received_at DESC NULLS LAST LIMIT ${L}`, [like]),
        pool.query(
          `SELECT id, make, model, year, status, source_reply_email
             FROM vehicles
            WHERE make ILIKE $1 OR model ILIKE $1 OR vin ILIKE $1 OR notes ILIKE $1 OR source_reply_email ILIKE $1
            ORDER BY created_at DESC NULLS LAST LIMIT ${L}`, [like]),
        pool.query(
          `SELECT id, email, first_name, last_name, company_name, phone
             FROM contacts
            WHERE email ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1 OR company_name ILIKE $1 OR phone ILIKE $1
            LIMIT ${L}`, [like]),
        pool.query(
          `SELECT ico, name, sector_primary, address_locality
             FROM companies
            WHERE name ILIKE $1 OR ico ILIKE $1
            ORDER BY best_targeting_score DESC NULLS LAST LIMIT ${L}`, [like]),
        pool.query(
          `SELECT id, name, ico, crm_status, email_primary
             FROM crm_clients
            WHERE name ILIKE $1 OR ico ILIKE $1 OR email_primary ILIKE $1
            LIMIT ${L}`, [like]),
      ])

      res.json({
        q,
        replies: replies.rows,
        vehicles: vehicles.rows,
        contacts: contacts.rows,
        companies: companies.rows,
        crm: crm.rows,
      })
    } catch (e) { capture500(res, e, safeError) }
  })
}
