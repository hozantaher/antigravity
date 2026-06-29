import Stripe from 'stripe'
import { loadEnv } from './load-env'

// One-time provisioning: registers this deployment's Stripe webhook endpoint and
// prints its signing secret (shown by Stripe ONLY at creation — store it in
// Secret Manager as STRIPE_WEBHOOK_SECRET right away).
//
//   pnpm tsx scripts/setup-stripe-webhook.ts [url]
//
// Default url is the App Hosting origin. A test-mode STRIPE_SECRET_KEY creates a
// test-mode endpoint; repeat with the live key at go-live.

const DEFAULT_URL = 'https://garaaage-auction--garaaage-auction24.europe-west4.hosted.app/api/webhooks/stripe'

const main = async () => {
  loadEnv()
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set')

  const url = process.argv[2] || DEFAULT_URL
  const stripe = new Stripe(key)

  const existing = await stripe.webhookEndpoints.list({ limit: 100 })
  const dupe = existing.data.find(e => e.url === url)
  if (dupe) {
    console.log(`Endpoint already exists: ${dupe.id} (${dupe.url}, status ${dupe.status})`)
    console.log('Stripe never re-shows its secret — delete it first to mint a new one:')
    console.log(`  stripe webhook_endpoints delete ${dupe.id}`)
    return
  }

  const endpoint = await stripe.webhookEndpoints.create({
    url,
    enabled_events: ['checkout.session.completed'],
    description: 'garaaage-auction deposit payments',
  })

  console.log(`Created webhook endpoint ${endpoint.id} → ${endpoint.url}`)
  console.log(`Mode: ${endpoint.livemode ? 'LIVE' : 'TEST'}`)
  console.log('Signing secret (store as STRIPE_WEBHOOK_SECRET, shown only once):')
  console.log(endpoint.secret)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
