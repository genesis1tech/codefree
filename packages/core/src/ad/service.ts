import { AdCreative, AdConfig, AdImpression, CREDITS_PER_CLICK, CREDITS_PER_VIEW, ImpressionStats } from "./types"

// -- Phase 0 placeholder ads --

const PLACEHOLDER_ADS: ReadonlyArray<AdCreative> = [
  new AdCreative({
    id: "ad-vercel-001",
    advertiser_id: "vercel",
    headline: "Ship faster with Vercel",
    body: "Zero-config deploys, edge functions, and instant previews. From localhost to production in seconds.",
    cta_text: "Start deploying free",
    cta_url: "https://vercel.com/?utm_source=codefree",
    display_url: "vercel.com",
    category: "devtool",
    format: "markdown",
  }),
  new AdCreative({
    id: "ad-supabase-001",
    advertiser_id: "supabase",
    headline: "Supabase — Open Source Firebase Alternative",
    body: "Postgres database, auth, storage, and real-time subscriptions. Build in a weekend, scale to millions.",
    cta_text: "Get started free",
    cta_url: "https://supabase.com/?utm_source=codefree",
    display_url: "supabase.com",
    category: "devtool",
    format: "markdown",
  }),
  new AdCreative({
    id: "ad-railway-001",
    advertiser_id: "railway",
    headline: "Railway — Deploy anything",
    body: "Infrastructure made simple. Spin up databases, deploy apps, and scale effortlessly. No YAML required.",
    cta_text: "Try Railway free",
    cta_url: "https://railway.app/?utm_source=codefree",
    display_url: "railway.app",
    category: "devtool",
    format: "markdown",
  }),
  new AdCreative({
    id: "ad-planetscale-001",
    advertiser_id: "planetscale",
    headline: "PlanetScale — Serverless MySQL",
    body: "Branch your database like your code. Non-blocking schema changes, built-in connection pooling, and zero-downtime.",
    cta_text: "Start free tier",
    cta_url: "https://planetscale.com/?utm_source=codefree",
    display_url: "planetscale.com",
    category: "saas",
    format: "markdown",
  }),
  new AdCreative({
    id: "ad-neon-001",
    advertiser_id: "neon",
    headline: "Neon — Serverless Postgres",
    body: "Branching, auto-scaling, and bottomless storage. The developer-friendly Postgres built for modern apps.",
    cta_text: "Create free database",
    cta_url: "https://neon.tech/?utm_source=codefree",
    display_url: "neon.tech",
    category: "devtool",
    format: "markdown",
  }),
  new AdCreative({
    id: "ad-convex-001",
    advertiser_id: "convex",
    headline: "Convex — The Backend Platform",
    body: "Reactive queries, serverless functions, file storage, and real-time sync. Build full-stack apps without backend plumbing.",
    cta_text: "Start building",
    cta_url: "https://convex.dev/?utm_source=codefree",
    display_url: "convex.dev",
    category: "devtool",
    format: "markdown",
  }),
]

// -- In-memory impression store (Phase 0; DB persistence in Phase 1) --

const impressions: AdImpression[] = []

/**
 * Fetches available ads. Phase 0 returns hardcoded placeholders.
 * Phase 1 will call the ad server API.
 */
export function fetchAds(_config: AdConfig): ReadonlyArray<AdCreative> {
  return PLACEHOLDER_ADS
}

/**
 * Records an ad impression in memory and logs the credit reward.
 * Phase 1 will persist to DB and trigger WalletService credit reward.
 */
export function recordImpression(impression: AdImpression): void {
  impressions.push(impression)
  // Credit reward will be triggered via WalletService in Phase 1
  console.log(`[AdService] Impression recorded: +${CREDITS_PER_VIEW} credits (ad=${impression.ad_id})`)
}

/**
 * Records a click on an ad impression. Updates the impression in place.
 * Phase 1 will persist to DB and trigger WalletService affiliate credit reward.
 */
export function recordClick(impressionId: string, clickUrl: string): void {
  const impression = impressions.find((i) => i.id === impressionId)
  if (!impression) return

  // Create updated copy with click data
  const updated = new AdImpression({
    ...impression,
    clicked: true,
    click_url: clickUrl,
  })

  // Replace in store
  const index = impressions.indexOf(impression)
  if (index >= 0) impressions[index] = updated

  console.log(`[AdService] Click recorded: +${CREDITS_PER_CLICK} credits (ad=${impression.ad_id})`)
}

/**
 * Returns impression statistics for a session.
 */
export function getImpressionStats(sessionId: string): ImpressionStats {
  const sessionImpressions = impressions.filter((i) => i.session_id === sessionId)
  const totalClicks = sessionImpressions.filter((i) => i.clicked).length
  const creditsEarned = sessionImpressions.length * CREDITS_PER_VIEW + totalClicks * CREDITS_PER_CLICK

  return new ImpressionStats({
    total_ads: sessionImpressions.length,
    total_clicks: totalClicks,
    credits_earned: creditsEarned,
  })
}

/**
 * Clears the in-memory impression store. Useful for testing.
 */
export function clearImpressions(): void {
  impressions.length = 0
}
