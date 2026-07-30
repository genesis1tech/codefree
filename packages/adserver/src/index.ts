import type { Database } from "bun:sqlite"
import { openDatabase } from "./db"
import { seedAds } from "./seed"

const IMPRESSION_USD = 0.04
const CLICK_USD = 1.0

const SLOT_CATEGORY_AFFINITY: Record<string, ReadonlyArray<string>> = {
  thinking: ["devtool", "education"],
  toolgap: ["devtool", "saas"],
  idle: ["affiliate", "recruiting", "education"],
}

type AdResponse = {
  id: string
  advertiser_id: string
  headline: string
  body: string
  cta_text: string
  cta_url: string
  display_url: string
  category: string
  format?: "text" | "markdown"
  image_url?: string
}

type AdRow = {
  id: string
  advertiser_id: string
  category: string
  headline: string
  body: string
  cta_text: string
  cta_url: string
  display_url: string
  format: string | null
  image_url: string | null
}

export function createAdServer(db: Database) {
  return {
    fetch: (request: Request) => handleRequest(db, request),
  }
}

export function handleRequest(db: Database, request: Request): Response | Promise<Response> {
  const url = new URL(request.url)

  if (request.method === "GET" && url.pathname === "/ads") {
    return jsonResponse(listAds(db, url))
  }

  if (request.method === "POST" && url.pathname === "/impressions") {
    return handleImpression(db, request)
  }

  if (request.method === "POST" && url.pathname === "/clicks") {
    return handleClick(db, request)
  }

  const advertiserMatch = url.pathname.match(/^\/advertisers\/([^/]+)\/stats$/)
  if (request.method === "GET" && advertiserMatch) {
    return jsonResponse(advertiserStats(db, decodeURIComponent(advertiserMatch[1]!)))
  }

  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  })
}

function listAds(db: Database, url: URL) {
  const slot = url.searchParams.get("slot") ?? undefined
  const categories = parseCategories(url.searchParams.get("categories"))
  const affinity = slot ? (SLOT_CATEGORY_AFFINITY[slot] ?? []) : []

  let rows = db.query("SELECT * FROM ads WHERE active = 1").all() as AdRow[]

  if (categories.length > 0) {
    const allowed = new Set(categories)
    rows = rows.filter((row) => allowed.has(row.category))
  }

  rows.sort((a, b) => {
    const aAffinity = affinity.includes(a.category) ? 0 : 1
    const bAffinity = affinity.includes(b.category) ? 0 : 1
    if (aAffinity !== bAffinity) return aAffinity - bAffinity
    return a.id.localeCompare(b.id)
  })

  return { ads: rows.slice(0, 20).map(toAdResponse) }
}

function toAdResponse(row: AdRow): AdResponse {
  const ad: AdResponse = {
    id: row.id,
    advertiser_id: row.advertiser_id,
    headline: row.headline,
    body: row.body,
    cta_text: row.cta_text,
    cta_url: row.cta_url,
    display_url: row.display_url,
    category: row.category,
  }

  if (row.format === "text" || row.format === "markdown") {
    ad.format = row.format
  }

  if (row.image_url) {
    ad.image_url = row.image_url
  }

  return ad
}

function parseCategories(raw: string | null) {
  if (!raw) return []
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

function handleImpression(db: Database, request: Request) {
  return parseJsonBody(request).then((body) => {
    const impressionId = requireString(body, "impression_id")
    if (!impressionId.ok) return badRequest(impressionId.error)

    const adId = requireString(body, "ad_id")
    if (!adId.ok) return badRequest(adId.error)

    const userId = requireString(body, "user_id")
    if (!userId.ok) return badRequest(userId.error)

    const slotType = requireString(body, "slot_type")
    if (!slotType.ok) return badRequest(slotType.error)

    const createdAt = requireNumber(body, "created_at")
    if (!createdAt.ok) return badRequest(createdAt.error)

    db.run(
      `INSERT OR IGNORE INTO impressions (id, ad_id, user_id, slot_type, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [impressionId.value, adId.value, userId.value, slotType.value, createdAt.value],
    )

    return new Response(null, { status: 204 })
  })
}

function handleClick(db: Database, request: Request) {
  return parseJsonBody(request).then((body) => {
    const impressionId = requireString(body, "impression_id")
    if (!impressionId.ok) return badRequest(impressionId.error)

    const adId = requireString(body, "ad_id")
    if (!adId.ok) return badRequest(adId.error)

    const userId = requireString(body, "user_id")
    if (!userId.ok) return badRequest(userId.error)

    const clickUrl = requireString(body, "click_url")
    if (!clickUrl.ok) return badRequest(clickUrl.error)

    db.run(
      `INSERT INTO clicks (id, impression_id, ad_id, user_id, click_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), impressionId.value, adId.value, userId.value, clickUrl.value, Date.now()],
    )

    return new Response(null, { status: 204 })
  })
}

function advertiserStats(db: Database, advertiserId: string) {
  const impressions = (
    db
      .query(
        `SELECT COUNT(*) AS n
         FROM impressions i
         INNER JOIN ads a ON a.id = i.ad_id
         WHERE a.advertiser_id = ?`,
      )
      .get(advertiserId) as { n: number }
  ).n

  const clicks = (
    db
      .query(
        `SELECT COUNT(*) AS n
         FROM clicks c
         INNER JOIN ads a ON a.id = c.ad_id
         WHERE a.advertiser_id = ?`,
      )
      .get(advertiserId) as { n: number }
  ).n

  return {
    impressions,
    clicks,
    spend_usd: impressions * IMPRESSION_USD + clicks * CLICK_USD,
  }
}

async function parseJsonBody(request: Request) {
  try {
    return (await request.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

function requireString(body: Record<string, unknown> | null, field: string) {
  if (!body) return { ok: false as const, error: "invalid json body" }
  const value = body[field]
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false as const, error: `missing or invalid ${field}` }
  }
  return { ok: true as const, value }
}

function requireNumber(body: Record<string, unknown> | null, field: string) {
  if (!body) return { ok: false as const, error: "invalid json body" }
  const value = body[field]
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false as const, error: `missing or invalid ${field}` }
  }
  return { ok: true as const, value }
}

function badRequest(message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "content-type": "application/json" },
  })
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

if (import.meta.main) {
  const db = openDatabase()
  seedAds(db)

  const port = Number(process.env.CODEFREE_ADSERVER_PORT ?? 8790)
  const app = createAdServer(db)

  Bun.serve({
    port,
    fetch: app.fetch,
  })

  console.log(`@codefree/adserver listening on http://localhost:${port}`)
}
