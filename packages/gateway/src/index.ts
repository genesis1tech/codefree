import type { Server } from "bun"
import { openDatabase } from "./db"

const PRICE_TABLE = {
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  default: { in: 2.5, out: 10 },
} as const

type PriceRow = (typeof PRICE_TABLE)[keyof typeof PRICE_TABLE]

export type GatewayOptions = {
  dbPath?: string
  port?: number
  upstreamBaseUrl?: string
  upstreamKey?: string
}

type AccountRow = {
  user_id: string
  api_key: string
  balance_usd: number
  created_at: number
}

type DepositRow = {
  id: string
  user_id: string
  usd: number
  reference: string
  created_at: number
}

export function priceForModel(model: string): PriceRow {
  if (model in PRICE_TABLE) return PRICE_TABLE[model as keyof typeof PRICE_TABLE]
  return PRICE_TABLE.default
}

export function calculateCost(model: string, promptTokens: number, completionTokens: number) {
  const price = priceForModel(model)
  return (promptTokens * price.in) / 1e6 + (completionTokens * price.out) / 1e6
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status })
}

function error(message: string, status: number) {
  return json({ error: { message } }, status)
}

function parseBearer(req: Request) {
  const header = req.headers.get("authorization")
  if (!header?.startsWith("Bearer ")) return null
  return header.slice("Bearer ".length).trim()
}

function getAccountByKey(db: ReturnType<typeof openDatabase>, apiKey: string) {
  return db.query("SELECT user_id, api_key, balance_usd, created_at FROM accounts WHERE api_key = ?").get(apiKey) as
    | AccountRow
    | null
}

function getAccountByUserId(db: ReturnType<typeof openDatabase>, userId: string) {
  return db.query("SELECT user_id, api_key, balance_usd, created_at FROM accounts WHERE user_id = ?").get(userId) as
    | AccountRow
    | null
}

function recordUsage(
  db: ReturnType<typeof openDatabase>,
  userId: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  costUsd: number,
) {
  db.run(
    "INSERT INTO usage_events (id, user_id, model, prompt_tokens, completion_tokens, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [crypto.randomUUID(), userId, model, promptTokens, completionTokens, costUsd, Date.now()],
  )
  db.run("UPDATE accounts SET balance_usd = balance_usd - ? WHERE user_id = ?", [costUsd, userId])
}

async function parseJsonBody(req: Request) {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

async function scanStreamUsage(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue
      try {
        const data = JSON.parse(line.slice(6)) as { usage?: { prompt_tokens?: number; completion_tokens?: number } }
        if (data.usage) usage = data.usage
      } catch {
        // ignore malformed SSE chunks
      }
    }
  }

  if (buffer.startsWith("data: ") && buffer !== "data: [DONE]") {
    try {
      const data = JSON.parse(buffer.slice(6)) as { usage?: { prompt_tokens?: number; completion_tokens?: number } }
      if (data.usage) usage = data.usage
    } catch {
      // ignore malformed SSE chunks
    }
  }

  return usage
}

export function createGatewayHandler(options: {
  db: ReturnType<typeof openDatabase>
  upstreamBaseUrl: string
  upstreamKey: string | undefined
}) {
  const { db, upstreamBaseUrl, upstreamKey } = options

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const path = url.pathname

    if (req.method === "POST" && path === "/accounts") {
      const body = await parseJsonBody(req)
      if (!body || typeof body.user_id !== "string" || body.user_id.length === 0) {
        return error("user_id is required", 400)
      }

      const existing = getAccountByUserId(db, body.user_id)
      if (existing) {
        return json({
          user_id: existing.user_id,
          api_key: existing.api_key,
          balance_usd: existing.balance_usd,
        })
      }

      const apiKey = `cfg_${crypto.randomUUID()}`
      const createdAt = Date.now()
      db.run("INSERT INTO accounts (user_id, api_key, balance_usd, created_at) VALUES (?, ?, 0, ?)", [
        body.user_id,
        apiKey,
        createdAt,
      ])

      return json({ user_id: body.user_id, api_key: apiKey, balance_usd: 0 }, 201)
    }

    const depositMatch = path.match(/^\/accounts\/([^/]+)\/deposit$/)
    if (req.method === "POST" && depositMatch) {
      const userId = decodeURIComponent(depositMatch[1]!)
      const body = await parseJsonBody(req)
      if (!body || typeof body.usd !== "number" || typeof body.reference !== "string") {
        return error("usd and reference are required", 400)
      }

      const account = getAccountByUserId(db, userId)
      if (!account) return error("account not found", 404)

      const existingDeposit = db
        .query("SELECT id, user_id, usd, reference, created_at FROM deposits WHERE reference = ?")
        .get(body.reference) as DepositRow | null

      if (existingDeposit) {
        const current = getAccountByUserId(db, userId)!
        return json({ deposit_id: existingDeposit.id, balance_usd: current.balance_usd })
      }

      const depositId = crypto.randomUUID()
      const createdAt = Date.now()
      db.run("INSERT INTO deposits (id, user_id, usd, reference, created_at) VALUES (?, ?, ?, ?, ?)", [
        depositId,
        userId,
        body.usd,
        body.reference,
        createdAt,
      ])
      db.run("UPDATE accounts SET balance_usd = balance_usd + ? WHERE user_id = ?", [body.usd, userId])

      const updated = getAccountByUserId(db, userId)!
      return json({ deposit_id: depositId, balance_usd: updated.balance_usd }, 201)
    }

    const accountMatch = path.match(/^\/accounts\/([^/]+)$/)
    if (req.method === "GET" && accountMatch) {
      const userId = decodeURIComponent(accountMatch[1]!)
      const account = getAccountByUserId(db, userId)
      if (!account) return error("account not found", 404)
      return json({ user_id: account.user_id, balance_usd: account.balance_usd })
    }

    if (req.method === "POST" && path === "/v1/chat/completions") {
      const apiKey = parseBearer(req)
      if (!apiKey) return error("missing authorization", 401)

      const account = getAccountByKey(db, apiKey)
      if (!account) return error("invalid api key", 401)
      if (account.balance_usd <= 0) return error("CodeFree gateway balance exhausted", 402)

      if (!upstreamKey) return error("gateway upstream key not configured", 503)

      const body = await parseJsonBody(req)
      if (!body) return error("invalid json body", 400)

      const model = typeof body.model === "string" ? body.model : "default"
      const stream = body.stream === true
      const forwardedBody = stream
        ? { ...body, stream_options: { include_usage: true } }
        : body

      const upstreamResponse = await fetch(`${upstreamBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${upstreamKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(forwardedBody),
      })

      if (!stream) {
        const payload = (await upstreamResponse.json()) as {
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        if (payload.usage) {
          const promptTokens = payload.usage.prompt_tokens ?? 0
          const completionTokens = payload.usage.completion_tokens ?? 0
          const costUsd = calculateCost(model, promptTokens, completionTokens)
          recordUsage(db, account.user_id, model, promptTokens, completionTokens, costUsd)
        }
        return new Response(JSON.stringify(payload), {
          status: upstreamResponse.status,
          headers: { "content-type": "application/json" },
        })
      }

      if (!upstreamResponse.body) {
        return error("upstream returned empty body", 502)
      }

      const [clientStream, scanStream] = upstreamResponse.body.tee()
      void scanStreamUsage(scanStream).then((usage) => {
        if (!usage) return
        const promptTokens = usage.prompt_tokens ?? 0
        const completionTokens = usage.completion_tokens ?? 0
        const costUsd = calculateCost(model, promptTokens, completionTokens)
        recordUsage(db, account.user_id, model, promptTokens, completionTokens, costUsd)
      })

      return new Response(clientStream, {
        status: upstreamResponse.status,
        headers: upstreamResponse.headers,
      })
    }

    return error("not found", 404)
  }
}

export function startGateway(options: GatewayOptions = {}) {
  const dbPath = options.dbPath ?? process.env.CODEFREE_GATEWAY_DB ?? "gateway.db"
  const port = options.port ?? Number(process.env.CODEFREE_GATEWAY_PORT ?? 8791)
  const upstreamBaseUrl = options.upstreamBaseUrl ?? process.env.CODEFREE_UPSTREAM_BASE_URL ?? "https://api.openai.com"
  const upstreamKey = options.upstreamKey ?? process.env.CODEFREE_UPSTREAM_KEY

  const db = openDatabase(dbPath)
  const fetch = createGatewayHandler({ db, upstreamBaseUrl, upstreamKey })

  const server = Bun.serve({ port, fetch })
  return { server, db }
}

if (import.meta.main) {
  const { server } = startGateway()
  console.log(`@codefree/gateway listening on http://localhost:${server.port}`)
}

export type GatewayServer = Server<unknown>
