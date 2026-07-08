import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { unlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openDatabase } from "../src/db"
import { createAdServer } from "../src/index"
import { seedAds } from "../src/seed"

const REQUIRED_AD_FIELDS = [
  "id",
  "advertiser_id",
  "headline",
  "body",
  "cta_text",
  "cta_url",
  "display_url",
  "category",
] as const

const OPTIONAL_AD_FIELDS = ["format", "image_url"] as const

let dbPath = ""
let db: ReturnType<typeof openDatabase>
let server: ReturnType<typeof Bun.serve>

beforeEach(() => {
  dbPath = join(tmpdir(), `adserver-test-${crypto.randomUUID()}.db`)
  db = openDatabase(dbPath)
  seedAds(db)
  server = Bun.serve({
    port: 0,
    fetch: createAdServer(db).fetch,
  })
})

afterEach(() => {
  server?.stop(true)
  if (dbPath) unlinkSync(dbPath)
})

async function get(path: string) {
  return fetch(`${server.url}${path}`)
}

async function post(path: string, body: Record<string, unknown>) {
  return fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("adserver", () => {
  test("VAL-ADS-001: GET /ads returns AdServerResponse field names", async () => {
    const response = await get("/ads")
    expect(response.status).toBe(200)

    const payload = (await response.json()) as { ads: Array<Record<string, unknown>> }
    expect(Array.isArray(payload.ads)).toBe(true)
    expect(payload.ads.length).toBeGreaterThan(0)

    for (const ad of payload.ads) {
      for (const field of REQUIRED_AD_FIELDS) {
        expect(ad).toHaveProperty(field)
        expect(typeof ad[field]).toBe("string")
      }

      for (const field of OPTIONAL_AD_FIELDS) {
        if (field in ad) {
          expect(typeof ad[field]).toBe("string")
        }
      }

      if ("format" in ad && typeof ad.format === "string") {
        expect(["text", "markdown"]).toContain(ad.format)
      }
    }
  })

  test("VAL-ADS-002: GET /ads orders slot-affinity categories first", async () => {
    const response = await get("/ads?slot=thinking")
    expect(response.status).toBe(200)

    const payload = (await response.json()) as { ads: Array<{ category: string }> }
    const categories = payload.ads.map((ad) => ad.category)

    const affinity = ["devtool", "education"]
    const firstNonAffinity = categories.findIndex((category) => !affinity.includes(category))
    if (firstNonAffinity === -1) return

    for (const category of categories.slice(firstNonAffinity)) {
      expect(affinity.includes(category)).toBe(false)
    }
  })

  test("VAL-ADS-003: POST /impressions is idempotent on duplicate impression_id", async () => {
    const body = {
      impression_id: "imp-dup-001",
      ad_id: "ad-vercel-001",
      user_id: "cfu_test",
      slot_type: "thinking",
      created_at: Date.now(),
    }

    const first = await post("/impressions", body)
    const second = await post("/impressions", body)

    expect(first.status).toBe(204)
    expect(second.status).toBe(204)

    const count = db.query("SELECT COUNT(*) AS n FROM impressions WHERE id = ?").get(body.impression_id) as {
      n: number
    }
    expect(count.n).toBe(1)
  })

  test("VAL-ADS-004: GET /advertisers/:id/stats computes spend_usd", async () => {
    const impressionBody = {
      impression_id: "imp-stats-001",
      ad_id: "ad-vercel-001",
      user_id: "cfu_test",
      slot_type: "thinking",
      created_at: Date.now(),
    }

    const clickBody = {
      impression_id: "imp-stats-001",
      ad_id: "ad-vercel-001",
      user_id: "cfu_test",
      click_url: "https://vercel.com/?utm_source=codefree",
    }

    expect((await post("/impressions", impressionBody)).status).toBe(204)
    expect((await post("/impressions", { ...impressionBody, impression_id: "imp-stats-002" })).status).toBe(204)
    expect((await post("/clicks", clickBody)).status).toBe(204)

    const response = await get("/advertisers/vercel/stats")
    expect(response.status).toBe(200)

    const stats = (await response.json()) as {
      impressions: number
      clicks: number
      spend_usd: number
    }

    expect(stats.impressions).toBe(2)
    expect(stats.clicks).toBe(1)
    expect(stats.spend_usd).toBeCloseTo(2 * 0.04 + 1 * 1.0, 5)
  })
})
