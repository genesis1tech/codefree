import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Schema, Stream } from "effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Wallet } from "@opencode-ai/core/wallet"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMEvent } from "@opencode-ai/llm"
import { CodeFree } from "@/session/codefree"
import { SessionStatus } from "@/session/status"

// --- Provider / model config (non-zero costs so usage.cost > 0) ---

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

// Construct a valid Provider.Model with non-zero costs directly from the schema, avoiding
// provider.getModel() which triggers plugin loading (and the pre-existing @opencode-ai/server
// subpath resolution issue). With input/output at 10000 per million tokens, 100 tokens each
// yields usage.cost = 100*10000/1e6 + 100*10000/1e6 = 2.0.
const testModel = Schema.decodeUnknownSync(Provider.Model)({
  id: "test-model",
  providerID: "test",
  api: { id: "test", url: "http://localhost:1/v1", npm: "@ai-sdk/openai-compatible" },
  name: "Test Model",
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 10000, output: 10000, cache: { read: 0, write: 0 } },
  limit: { context: 100000, output: 10000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2025-01-01",
})

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

// --- Spy CodeFree.Service ---
//
// Module-level mutable state so each test can configure the spy's behavior (return values,
// failure mode, blocking). The spy records every maybeShowAd/applyUsage invocation so the
// processor wiring tests can assert which hooks fired, with which slot types and costs.

interface MaybeShowAdCall {
  sessionID: SessionID
  messageID: SessionV1.MessageID
  slotType: string
}
interface ApplyUsageCall {
  sessionID: SessionID
  costUSD: number
}

let spyMaybeShowAdCalls: MaybeShowAdCall[] = []
let spyApplyUsageCalls: ApplyUsageCall[] = []
let spyApplyUsageUncovered = 0
let spyApplyUsageFail = false
let spyMaybeShowAdBlock: Deferred.Deferred<void> | undefined

function resetSpy() {
  spyMaybeShowAdCalls = []
  spyApplyUsageCalls = []
  spyApplyUsageUncovered = 0
  spyApplyUsageFail = false
  spyMaybeShowAdBlock = undefined
}

const spyCodefree = Layer.succeed(
  CodeFree.Service,
  CodeFree.Service.of({
    maybeShowAd: (sessionID: SessionID, messageID: SessionV1.MessageID, slotType: "thinking" | "toolgap" | "idle") =>
      Effect.gen(function* () {
        spyMaybeShowAdCalls.push({ sessionID, messageID, slotType })
        if (spyMaybeShowAdBlock) {
          yield* Deferred.await(spyMaybeShowAdBlock)
        }
      }),
    applyUsage: (sessionID: SessionID, costUSD: number) =>
      Effect.gen(function* () {
        spyApplyUsageCalls.push({ sessionID, costUSD })
        if (spyApplyUsageFail) {
          return yield* new Wallet.InsufficientBalanceError({ required: 999, available: 0 })
        }
        return spyApplyUsageUncovered
      }),
    hydrateWallet: () => Effect.void,
  }),
)

// --- Mock LLMs ---

// Reasoning flow: step-start → reasoning-start → reasoning-delta → reasoning-end → step-finish → finish
const reasoningLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "r1" }),
        LLMEvent.reasoningDelta({ id: "r1", text: "thinking..." }),
        LLMEvent.reasoningEnd({ id: "r1" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 100, outputTokens: 100 } }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)

// Tool flow: step-start → tool-input-start → tool-input-end → tool-call → tool-result → step-finish → finish
const toolLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "c1", name: "lookup" }),
        LLMEvent.toolInputEnd({ id: "c1", name: "lookup" }),
        LLMEvent.toolCall({ id: "c1", name: "lookup", input: {}, providerExecuted: true }),
        LLMEvent.toolResult({
          id: "c1",
          name: "lookup",
          result: { type: "error", value: "test error" },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 100, outputTokens: 100 } }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)

// Minimal flow: step-start → step-finish (for applyUsage / costCoveredByCredits tests)
const stepFinishLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 100, outputTokens: 100 } }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)

// --- Layer env ---

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
])
const replacements = [
  LayerNode.replace(SessionSummary.node, summary),
  LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })),
  LayerNode.replace(CodeFree.node, spyCodefree),
]

function buildEnv(llm: Layer.Layer<LLM.Service>) {
  return LayerNode.buildLayer(root, {
    replacements: [...replacements, LayerNode.replace(LLM.node, llm)],
  })
}

const itReasoning = testEffect(buildEnv(reasoningLLM))
const itTool = testEffect(buildEnv(toolLLM))
const itStepFinish = testEffect(buildEnv(stepFinishLLM))

// --- Helpers ---

const boot = Effect.fn("TestSession.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  return { processors, session }
})

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

function streamInput(chatID: SessionID, parentID: MessageID, text: string) {
  return {
    user: {
      id: parentID,
      sessionID: chatID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ref.providerID, modelID: ref.modelID },
    } satisfies SessionV1.User,
    sessionID: chatID,
    model: testModel,
    agent: agent(),
    system: [],
    messages: [{ role: "user", content: text }],
    tools: {},
  } satisfies LLM.StreamInput
}

// =====================================================================================
// VAL-SESSION-031: thinking slot fires maybeShowAd on reasoning-end
// =====================================================================================

describe("processor codefree hooks (VAL-SESSION-031/032/033/034/019/021)", () => {
  itReasoning.live("reasoning-end triggers maybeShowAd with slotType 'thinking' (VAL-SESSION-031)", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          resetSpy()
          const { processors, session } = yield* boot()
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "think")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: testModel })

          yield* handle.process(streamInput(chat.id, parent.id, "think"))

          // The forked maybeShowAd may not have recorded yet — poll for it.
          yield* pollWithTimeout(
            Effect.sync(() =>
              spyMaybeShowAdCalls.some((c) => c.slotType === "thinking") ? true : undefined,
            ),
            "thinking-slot maybeShowAd was not called",
          )
          const thinkingCall = spyMaybeShowAdCalls.find((c) => c.slotType === "thinking")
          expect(thinkingCall).toBeDefined()
          expect(thinkingCall!.sessionID).toBe(chat.id)
        }),
    ),
  )

  // =====================================================================================
  // VAL-SESSION-032: toolgap slot fires on tool-result
  // =====================================================================================

  itTool.live("tool-result triggers maybeShowAd with slotType 'toolgap' (VAL-SESSION-032)", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          resetSpy()
          const { processors, session } = yield* boot()
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "tool")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: testModel })

          yield* handle.process(streamInput(chat.id, parent.id, "tool"))

          yield* pollWithTimeout(
            Effect.sync(() =>
              spyMaybeShowAdCalls.some((c) => c.slotType === "toolgap") ? true : undefined,
            ),
            "toolgap-slot maybeShowAd was not called",
          )
          const toolgapCall = spyMaybeShowAdCalls.find((c) => c.slotType === "toolgap")
          expect(toolgapCall).toBeDefined()
          expect(toolgapCall!.sessionID).toBe(chat.id)
        }),
    ),
  )

  // =====================================================================================
  // VAL-SESSION-034: step-finish triggers applyUsage with usage.cost
  // =====================================================================================

  itStepFinish.live("step-finish triggers applyUsage with the usage cost (VAL-SESSION-034)", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          resetSpy()
          const { processors, session } = yield* boot()
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "cost")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: testModel })

          yield* handle.process(streamInput(chat.id, parent.id, "cost"))

          // applyUsage is called synchronously during step-finish handling, so it's recorded
          // by the time process() returns.
          expect(spyApplyUsageCalls.length).toBe(1)
          expect(spyApplyUsageCalls[0]!.costUSD).toBeGreaterThan(0)
          expect(spyApplyUsageCalls[0]!.sessionID).toBe(chat.id)
        }),
    ),
  )

  // =====================================================================================
  // VAL-SESSION-019: processor sets costCoveredByCredits = usage.cost - uncovered
  // =====================================================================================

  itStepFinish.live("processor sets costCoveredByCredits = usage.cost - uncovered (VAL-SESSION-019)", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          // Partial coverage: spy returns half the cost as uncovered.
          resetSpy()
          const { processors, session } = yield* boot()
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "partial")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: testModel })

          // usage.cost = 2.0 (100 input + 100 output tokens at $0.01/token each).
          // Spy returns uncovered = 1.0 → costCoveredByCredits = 2.0 - 1.0 = 1.0.
          spyApplyUsageUncovered = 1.0

          yield* handle.process(streamInput(chat.id, parent.id, "partial"))

          const usageCost = spyApplyUsageCalls[0]!.costUSD
          expect(handle.message.costCoveredByCredits).toBe(usageCost - 1.0)
          expect(handle.message.costCoveredByCredits).toBeGreaterThan(0)
        }),
    ),
  )

  itStepFinish.live("full coverage: costCoveredByCredits == usage.cost (VAL-SESSION-019)", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          resetSpy()
          const { processors, session } = yield* boot()
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "full")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: testModel })

          // Spy returns uncovered = 0 → costCoveredByCredits = usage.cost.
          spyApplyUsageUncovered = 0

          yield* handle.process(streamInput(chat.id, parent.id, "full"))

          expect(handle.message.costCoveredByCredits).toBe(spyApplyUsageCalls[0]!.costUSD)
        }),
    ),
  )

  // =====================================================================================
  // VAL-SESSION-021: applyUsage failure never breaks the session
  // =====================================================================================

  itStepFinish.live("applyUsage failure falls back to costCoveredByCredits = 0 (VAL-SESSION-021)", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          resetSpy()
          spyApplyUsageFail = true
          const { processors, session } = yield* boot()
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "fail")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: testModel })

          // The session must complete despite applyUsage failing.
          const result = yield* handle.process(streamInput(chat.id, parent.id, "fail"))

          expect(result).toBe("continue")
          // On failure, the full cost is uncovered → costCoveredByCredits = 0.
          expect(handle.message.costCoveredByCredits).toBe(0)
          expect(handle.message.error).toBeUndefined()
        }),
    ),
  )

  // =====================================================================================
  // VAL-SESSION-033: ad injection does not block the stream event loop
  // =====================================================================================

  itReasoning.live("ad injection is forked — stream advances past a blocking ad (VAL-SESSION-033)", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          resetSpy()
          // Block the forked maybeShowAd on a deferred that we control. If the processor did NOT
          // fork (blocked on maybeShowAd), process() would hang waiting for the deferred.
          const block = yield* Deferred.make<void>()
          spyMaybeShowAdBlock = block

          const { processors, session } = yield* boot()
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "nonblock")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: testModel })

          // Feed reasoning-end + step-finish. The stream must complete without waiting for the
          // blocking ad fiber. process() returning at all proves non-blocking.
          yield* handle.process(streamInput(chat.id, parent.id, "nonblock"))

          // step-finish was processed (applyUsage called) despite maybeShowAd still blocked.
          expect(spyApplyUsageCalls.length).toBe(1)

          // Resolve the block so the forked fiber can complete before scope cleanup.
          yield* Deferred.succeed(block, undefined)
          spyMaybeShowAdBlock = undefined
        }),
    ),
  )
})
