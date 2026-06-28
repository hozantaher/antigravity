// AS3: relay pool capacity endpoint.
//
// GET /api/relay/pool-capacity
//   Returns how many wgpool Mullvad endpoints are configured, how many are
//   already pinned to a mailbox, and how many remain free. The UI panel (AS5)
//   uses this to warn operators before the pool is exhausted.
//
// Response shape:
//   {
//     pool_size:    number,   // total endpoints in WIREPROXY_POOL_CONFIG
//     pinned_count: number,   // endpoints already assigned to a mailbox
//     free_count:   number,   // pool_size - pinned_count (floored at 0)
//     can_add:      boolean,  // pinned_count < pool_size
//   }
//
// Query params:
//   ?env=production|test  (default: production)
//
// When WIREPROXY_POOL_CONFIG is not set, pool_size=0 and can_add=false.

import { preFlightPoolCapacity } from './mailboxes.js'

/**
 * @param {import('express').Express} app
 * @param {{ pool: import('pg').Pool, capture500: Function, safeError: Function }} deps
 */
export function mountRelayPoolCapacityRoute(app, { pool, capture500, safeError }) {
  app.get('/api/relay/pool-capacity', async (req, res) => {
    try {
      const env = req.query.env === 'test' ? 'test' : 'production'
      const cap = await preFlightPoolCapacity(pool, env)
      res.json(cap)
    } catch (e) {
      capture500(res, e, safeError)
    }
  })
}
