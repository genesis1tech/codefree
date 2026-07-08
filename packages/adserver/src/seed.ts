import type { Database } from "bun:sqlite"

const SAMPLE_ADS = [
  {
    id: "ad-vercel-001",
    advertiser_id: "vercel",
    category: "devtool",
    headline: "Ship faster with Vercel",
    body: "Zero-config deploys, edge functions, and instant previews. From localhost to production in seconds.",
    cta_text: "Start deploying free",
    cta_url: "https://vercel.com/?utm_source=codefree",
    display_url: "vercel.com",
    frequency_cap: 3,
    format: "markdown",
  },
  {
    id: "ad-supabase-001",
    advertiser_id: "supabase",
    category: "devtool",
    headline: "Supabase — Open Source Firebase Alternative",
    body: "Postgres database, auth, storage, and real-time subscriptions. Build in a weekend, scale to millions.",
    cta_text: "Get started free",
    cta_url: "https://supabase.com/?utm_source=codefree",
    display_url: "supabase.com",
    frequency_cap: 3,
    format: "markdown",
  },
  {
    id: "ad-planetscale-001",
    advertiser_id: "planetscale",
    category: "saas",
    headline: "PlanetScale — Serverless MySQL",
    body: "Branch your database like your code. Non-blocking schema changes and zero-downtime deploys.",
    cta_text: "Start free tier",
    cta_url: "https://planetscale.com/?utm_source=codefree",
    display_url: "planetscale.com",
    frequency_cap: 3,
    format: "markdown",
  },
  {
    id: "ad-notion-001",
    advertiser_id: "notion",
    category: "saas",
    headline: "Notion for engineering teams",
    body: "Docs, wikis, and project hubs in one workspace. Keep specs and runbooks where your team already works.",
    cta_text: "Try Notion free",
    cta_url: "https://notion.so/?utm_source=codefree",
    display_url: "notion.so",
    frequency_cap: 3,
    format: "text",
  },
  {
    id: "ad-linear-001",
    advertiser_id: "linear",
    category: "recruiting",
    headline: "Linear is hiring senior engineers",
    body: "Join a small team building the issue tracker developers actually want. Remote-friendly, high ownership.",
    cta_text: "View open roles",
    cta_url: "https://linear.app/careers?utm_source=codefree",
    display_url: "linear.app/careers",
    frequency_cap: 2,
    format: "markdown",
  },
  {
    id: "ad-coursera-001",
    advertiser_id: "coursera",
    category: "education",
    headline: "Level up with Coursera",
    body: "Courses from top universities on systems design, ML, and cloud. Learn on your schedule.",
    cta_text: "Browse courses",
    cta_url: "https://coursera.org/?utm_source=codefree",
    display_url: "coursera.org",
    frequency_cap: 3,
    format: "markdown",
  },
  {
    id: "ad-egghead-001",
    advertiser_id: "egghead",
    category: "education",
    headline: "Egghead — bite-sized dev lessons",
    body: "Short videos on React, TypeScript, and modern tooling. Ship skills, not slide decks.",
    cta_text: "Start learning",
    cta_url: "https://egghead.io/?utm_source=codefree",
    display_url: "egghead.io",
    frequency_cap: 3,
    format: "text",
  },
  {
    id: "ad-amazon-001",
    advertiser_id: "amazon",
    category: "affiliate",
    headline: "Mechanical keyboards for long coding sessions",
    body: "Curated picks for developers who type all day. Commission supports CodeFree when you buy through our link.",
    cta_text: "Shop keyboards",
    cta_url: "https://amazon.com/dp/example?utm_source=codefree",
    display_url: "amazon.com",
    frequency_cap: 5,
    format: "markdown",
    image_url: "https://example.com/keyboard.jpg",
  },
] as const

export function seedAds(db: Database) {
  const count = db.query("SELECT COUNT(*) AS n FROM ads").get() as { n: number }
  if (count.n > 0) return

  const insert = db.prepare(`
    INSERT INTO ads (
      id, advertiser_id, category, headline, body, cta_text, cta_url, display_url,
      frequency_cap, active, format, image_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `)

  for (const ad of SAMPLE_ADS) {
    insert.run(
      ad.id,
      ad.advertiser_id,
      ad.category,
      ad.headline,
      ad.body,
      ad.cta_text,
      ad.cta_url,
      ad.display_url,
      ad.frequency_cap,
      ad.format,
      "image_url" in ad ? ad.image_url : null,
    )
  }
}
