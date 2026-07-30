import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createGatewayHandler, calculateCost } from "../src/index"
import { openDatabase } from "../src/db"

type MockUpstream = {
  port: number
  requests: Array<{ body: Record<string, unknown>; auth: string | null }>
  stop: () => void
}

function startMockUpstream(handlers: {
  nonStream?: (body: Record<string, unknown>) => { status: number; body: unknown }
  stream?: (body: Record<string, unknown>) => ReadableStream<Uint8Array>
}) {
  const requests: MockUpstream["requests"] = []

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const auth = req.headers.get("authorization")
      const body = (await req.json()) as Record<string, unknown>
      requests.push({ body, auth })

      if (body.stream === true && handlers.stream) {
        return new Response(handlers.stream(body), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      }

      if (handlers.nonStream) {
        const result = handlers.nonStream(body)
        return Response.json(result.body, { status: result.status })
      }

      return Response.json({ error: "no handler" }, { status: 500 })
    },
  })

  const port = server.port!
  return {
    port,
    requests,
    stop: () => server.stop(),
  }
}

function startTestGateway(options: {
  dbPath: string
  upstreamBaseUrl: string
  upstreamKey?: string
}) {
  const db = openDatabase(options.dbPath)
  const handler = createGatewayHandler({
    db,
    upstreamBaseUrl: options.upstreamBaseUrl,
    upstreamKey: options.upstreamKey,
  })
  const server = Bun.serve({ port: 0, fetch: handler })
  return { db, server, baseUrl: `http://localhost:${server.port}` }
}

describe("gateway", () => {
  let dbPath: string
  let gateway: ReturnType<typeof startTestGateway> | null = null

  beforeEach(() => {
    dbPath = `/tmp/gateway-test-${crypto.randomUUID()}.db`
  })

  afterEach(() => {
    gateway?.server.stop()
    gateway = null
  })

  test("VAL-GW-001: POST /accounts is idempotent and returns cfg_ key", async () => {
    gateway = startTestGateway({ dbPath, upstreamBaseUrl: "http://localhost:1", upstreamKey: "sk-test" })

    const first = await fetch(`${gateway.baseUrl}/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: "cfu_test" }),
    })
    expect(first.status).toBe(201)
    const firstBody = (await first.json()) as { user_id: string; api_key: string; balance_usd: number }
    expect(firstBody.user_id).toBe("cfu_test")
    expect(firstBody.api_key.startsWith("cfg_")).toBe(true)
    expect(firstBody.balance_usd).toBe(0)

    const second = await fetch(`${gateway.baseUrl}/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: "cfu_test" }),
    })
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as { user_id: string; api_key: string; balance_usd: number }
    expect(secondBody.api_key).toBe(firstBody.api_key)
  })

  test("VAL-GW-002: deposit is idempotent on reference", async () => {
    gateway = startTestGateway({ dbPath, upstreamBaseUrl: "http://localhost:1", upstreamKey: "sk-test" })

    await fetch(`${gateway.baseUrl}/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: "cfu_deposit" }),
    })

    const first = await fetch(`${gateway.baseUrl}/accounts/cfu_deposit/deposit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usd: 5, reference: "wdl_abc123" }),
    })
    expect(first.status).toBe(201)
    const firstBody = (await first.json()) as { deposit_id: string; balance_usd: number }
    expect(firstBody.balance_usd).toBe(5)

    const second = await fetch(`${gateway.baseUrl}/accounts/cfu_deposit/deposit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usd: 5, reference: "wdl_abc123" }),
    })
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as { deposit_id: string; balance_usd: number }
    expect(secondBody.deposit_id).toBe(firstBody.deposit_id)
    expect(secondBody.balance_usd).toBe(5)

    const account = await fetch(`${gateway.baseUrl}/accounts/cfu_deposit`)
    const accountBody = (await account.json()) as { balance_usd: number }
    expect(accountBody.balance_usd).toBe(5)
  })

  test("VAL-GW-003: chat completions returns 402 on zero balance", async () => {
    gateway = startTestGateway({ dbPath, upstreamBaseUrl: "http://localhost:1", upstreamKey: "sk-test" })

    const created = await fetch(`${gateway.baseUrl}/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: "cfu_zero" }),
    })
    const { api_key } = (await created.json()) as { api_key: string }

    const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${api_key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    })

    expect(response.status).toBe(402)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toBe("CodeFree gateway balance exhausted")
  })

  test("VAL-GW-004: non-stream completions meter usage against balance", async () => {
    const mockUpstream = startMockUpstream({
      nonStream: () => ({
        status: 200,
        body: {
          id: "chatcmpl-test",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "hello" } }],
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
        },
      }),
    })

    gateway = startTestGateway({
      dbPath,
      upstreamBaseUrl: `http://localhost:${mockUpstream.port}`,
      upstreamKey: "sk-upstream",
    })

    const created = await fetch(`${gateway.baseUrl}/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: "cfu_meter" }),
    })
    const { api_key } = (await created.json()) as { api_key: string }

    await fetch(`${gateway.baseUrl}/accounts/cfu_meter/deposit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usd: 1, reference: "seed-meter" }),
    })

    const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${api_key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    })

    expect(response.status).toBe(200)
    const expectedCost = calculateCost("gpt-4o", 1000, 500)
    const account = await fetch(`${gateway.baseUrl}/accounts/cfu_meter`)
    const accountBody = (await account.json()) as { balance_usd: number }
    expect(accountBody.balance_usd).toBeCloseTo(1 - expectedCost, 8)
    expect(mockUpstream.requests.length).toBe(1)
    expect(mockUpstream.requests[0]?.auth).toBe("Bearer sk-upstream")
  })

  test("VAL-GW-005: stream completions meter usage from final SSE chunk", async () => {
    const mockUpstream = startMockUpstream({
      stream: () => {
        const encoder = new TextEncoder()
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[],"usage":{"prompt_tokens":2000,"completion_tokens":1000}}\n\n',
              ),
            )
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
          },
        })
      },
    })

    gateway = startTestGateway({
      dbPath,
      upstreamBaseUrl: `http://localhost:${mockUpstream.port}`,
      upstreamKey: "sk-upstream",
    })

    const created = await fetch(`${gateway.baseUrl}/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: "cfu_stream" }),
    })
    const { api_key } = (await created.json()) as { api_key: string }

    await fetch(`${gateway.baseUrl}/accounts/cfu_stream/deposit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usd: 2, reference: "seed-stream" }),
    })

    const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${api_key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain("data: [DONE]")

    await Bun.sleep(50)

    const expectedCost = calculateCost("gpt-4o-mini", 2000, 1000)
    const account = await fetch(`${gateway.baseUrl}/accounts/cfu_stream`)
    const accountBody = (await account.json()) as { balance_usd: number }
    expect(accountBody.balance_usd).toBeCloseTo(2 - expectedCost, 8)

    const forwarded = mockUpstream.requests[0]?.body
    expect(forwarded?.stream).toBe(true)
    expect((forwarded?.stream_options as { include_usage?: boolean })?.include_usage).toBe(true)
  })

  test("VAL-GW-006: chat completions returns 503 when upstream key is unset", async () => {
    gateway = startTestGateway({ dbPath, upstreamBaseUrl: "http://localhost:1" })

    const created = await fetch(`${gateway.baseUrl}/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: "cfu_nokey" }),
    })
    const { api_key } = (await created.json()) as { api_key: string }

    await fetch(`${gateway.baseUrl}/accounts/cfu_nokey/deposit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usd: 1, reference: "seed-nokey" }),
    })

    const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${api_key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    })

    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toBe("gateway upstream key not configured")
  })

  test("VAL-GW-007: invalid bearer token returns 401", async () => {
    gateway = startTestGateway({ dbPath, upstreamBaseUrl: "http://localhost:1", upstreamKey: "sk-test" })

    const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer WRONG",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    })

    expect(response.status).toBe(401)
  })
})
