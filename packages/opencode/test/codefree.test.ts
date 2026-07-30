import { describe, expect, it } from "bun:test"
import path from "path"
import os from "os"
import { mkdtempSync } from "node:fs"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Database } from "@opencode-ai/core/database/database"
import { Wallet } from "@opencode-ai/core/wallet"
import { EventV2 } from "@opencode-ai/core/event"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigCodefree } from "@opencode-ai/core/config/codefree"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionV2 } from "@opencode-ai/core/session"
import { Global } from "@opencode-ai/core/global"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { getImpressionStats, Store, fetchAds, AdSource } from "@opencode-ai/core/ad/service"
import { trackImpression } from "@opencode-ai/core/ad/injector"
import { AD_VIEW_CREDIT_REWARD, AFFILIATE_CLICK_CREDIT_REWARD, MAX_DAILY_CREDITS } from "@opencode-ai/core/wallet/config"
import { Config } from "@/config/config"
import { Account } from "@/account/account"
import { CodeFree } from "@/session/codefree"
import { GlobalBus } from "@/bus/global"
import { EventV2Bridge } from "@/event-v2-bridge"
import { testEffect } from "./lib/effect"

// A stable test user id resolved via the fake Account service (active remote account path).
const TEST_USER_ID = "acct_codefree_test"
const REMOTE_USER_ID = "acct_codefree_remote"

// Shared in-memory database layer source. Each test builds its own layer tree from it, so every
// test starts with a fresh :memory: SQLite connection (no cross-test wallet/event leakage).
const database = Database.layerFromPath(":memory:")

// Fresh temp data dir for the stable local user id persistence. Created once per test file run so
// stability-across-runs tests can read the same dir from independent layer constructions.
const localIdDir = mkdtempSync(path.join(os.tmpdir(), "cf-local-id-"))
const LOCAL_ID_FILE = path.join(localIdDir, "codefree_local_user_id")

// --- Config helpers ---
//
// Build a ConfigV1.Info whose `codefree` block drives the real config read in maybeShowAd. The
// base is decoded from an empty object (all ConfigV1 fields optional) and the codefree block is
// overlaid. This proves maybeShowAd reads the REAL config, not hardcoded AdConfig.defaults.

function configInfo(codefree?: ConfigCodefree.Info) {
  // Decode an empty config (all ConfigV1 fields optional) and cast to the DeepMutable Info type so
  // the codefree block overlays cleanly onto the runtime config shape.
  const base = Schema.decodeUnknownSync(ConfigV1.Info)({}) as ConfigV1.Info
  return { ...base, codefree }
}

function configLayer(codefree: ConfigCodefree.Info) {
  // Cast to the Interface's declared get() return type: the decoded+overlaid object is structurally
  // a valid ConfigV1.Info, but the opencode Info intersection (DeepMutable + plugin_origins?) makes
  // direct inference fiddly for Layer.mock, so assert the exact expected Effect shape.
  return Layer.mock(Config.Service)({
    get: () => Effect.succeed(configInfo(codefree)) as ReturnType<Config.Interface["get"]>,
  })
}

const enabledConfig = configLayer(new ConfigCodefree.Info({ enabled: true, min_interval_ms: 0, frequency_cap: 1000 }))
const disabledConfig = configLayer(new ConfigCodefree.Info({ enabled: false }))

// --- Account fakes ---

function accountLayer(id: string) {
  return Layer.mock(Account.Service)({
    active: () =>
      Effect.succeed(
        Option.some(
          new Account.Info({
            id: Account.AccountID.make(id),
            email: `${id}@test.local`,
            url: "https://codefree.test",
            active_org_id: null,
          }),
        ),
      ),
  })
}

const activeAccount = accountLayer(TEST_USER_ID)
const remoteAccount = accountLayer(REMOTE_USER_ID)
const noAccount = Layer.mock(Account.Service)({
  active: () => Effect.succeed(Option.none()),
})

// --- Layer builder ---
//
// Wires CodeFree.layer with real Wallet + EventV2Bridge (so events reach the GlobalBus) plus the
// scenario-specific Account/Config/Global deps. Only an in-memory Database is supplied externally,
// proving CodeFree provides the Wallet/Config/Account/EventV2/Global deps (VAL-SESSION-037).
function buildLayer(opts: {
  account: Layer.Layer<Account.Service>
  config: Layer.Layer<Config.Service>
  global?: Layer.Layer<Global.Service>
  wallet?: Layer.Layer<Wallet.Service>
}) {
  const globalLayer = opts.global ?? Global.layerWith({ data: localIdDir })
  const eventBridge = EventV2Bridge.layer.pipe(Layer.provide(EventV2.layer))
  const walletLayer = opts.wallet ?? Wallet.layer
  const sharedDeps = Layer.mergeAll(walletLayer, Store.layer, AdSource.layer, eventBridge, opts.account, opts.config, globalLayer).pipe(
    Layer.provide(database),
    Layer.provide(FetchHttpClient.layer),
  )
  const codefreeWithDeps = CodeFree.layer.pipe(Layer.provide(sharedDeps))
  return Layer.mergeAll(codefreeWithDeps, sharedDeps)
}

// A publishPart stub that records every published part.
function recordingPublisher(published: SessionV1.TextPart[]) {
  return (part: SessionV1.TextPart) =>
    Effect.sync(() => {
      published.push(part)
      return part
    })
}

// Collect codefree.* events off the GlobalBus around an effect. Publish->bridge->bus is
// synchronous within the publish Effect, so events are present once `run` completes. Generic over
// the run effect's environment so the Service requirement carried by the namespace accessors flows
// through to the test layer.
function collectCodefreeEvents<R>(run: Effect.Effect<void, never, R>) {
  return Effect.gen(function* () {
    const seen: Array<{ type: string; properties: Record<string, unknown> }> = []
    const handler = (evt: { payload?: { type?: string; properties?: Record<string, unknown> } }) => {
      const type = evt.payload?.type
      if (typeof type === "string" && type.startsWith("codefree.")) {
        seen.push({ type, properties: evt.payload!.properties! })
      }
    }
    GlobalBus.on("event", handler)
    yield* run
    GlobalBus.off("event", handler)
    return seen
  })
}

function backdateImpression(impressionId: string) {
  return Effect.gen(function* () {
    const store = yield* Store.Service
    yield* store.setImpressionShownAt(impressionId, Date.now() - 10_000)
  })
}

function showAdAndComplete<R>(
  sid: SessionV2.ID,
  messageID: SessionV1.MessageID,
  slot: "thinking" | "toolgap" | "idle",
  publishPart: (part: SessionV1.TextPart) => Effect.Effect<SessionV1.TextPart>,
) {
  return Effect.gen(function* () {
    const seen: Array<{ type: string; properties: Record<string, unknown> }> = []
    const handler = (evt: { payload?: { type?: string; properties?: Record<string, unknown> } }) => {
      const type = evt.payload?.type
      if (typeof type === "string" && type.startsWith("codefree.")) {
        seen.push({ type, properties: evt.payload!.properties! })
      }
    }
    GlobalBus.on("event", handler)
    yield* CodeFree.maybeShowAd(sid, messageID, slot, publishPart)
    const impression = seen.find((event) => event.type === "codefree.ad.impression")
    const impressionId = impression?.properties.impression_id
    if (typeof impressionId === "string") {
      yield* backdateImpression(impressionId)
      yield* CodeFree.completeImpression(sid, impressionId)
    }
    GlobalBus.off("event", handler)
    return seen
  }) as Effect.Effect<Array<{ type: string; properties: Record<string, unknown> }>, never, R>
}

// --- Scenario runners (one testEffect per distinct layer configuration) ---

const effEnabled = testEffect(buildLayer({ account: activeAccount, config: enabledConfig }))
const effDisabled = testEffect(buildLayer({ account: activeAccount, config: disabledConfig }))
const effLocal = testEffect(buildLayer({ account: noAccount, config: enabledConfig }))
const effRemote = testEffect(buildLayer({ account: remoteAccount, config: enabledConfig }))
const effGated = testEffect(
  buildLayer({ account: activeAccount, config: configLayer(new ConfigCodefree.Info({ enabled: true, min_interval_ms: 60_000, max_ads_per_hour: 25, frequency_cap: 1000 })) }),
)
const effCapped = testEffect(
  buildLayer({ account: activeAccount, config: configLayer(new ConfigCodefree.Info({ enabled: true, min_interval_ms: 0, max_ads_per_hour: 2, frequency_cap: 1000 })) }),
)
const effIsolated = testEffect(
  buildLayer({ account: activeAccount, config: configLayer(new ConfigCodefree.Info({ enabled: true, min_interval_ms: 0, max_ads_per_hour: 1, frequency_cap: 1000 })) }),
)
const effMerged = testEffect(
  buildLayer({ account: activeAccount, config: configLayer(new ConfigCodefree.Info({ enabled: true, max_ads_per_hour: 1, frequency_cap: 1000 })) }),
)
const effNoAd = testEffect(
  buildLayer({ account: activeAccount, config: configLayer(new ConfigCodefree.Info({ enabled: true, min_interval_ms: 0, frequency_cap: 0 })) }),
)
const failingWallet = Layer.mock(Wallet.Service)({
  creditWallet: () => Effect.fail(new Wallet.WalletNotFoundError({ userId: "boom" })),
})
const effFailing = testEffect(buildLayer({ account: activeAccount, config: enabledConfig, wallet: failingWallet }))

function sessionID(tag: string) {
  return SessionV2.ID.make(`sess_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
}

// =====================================================================================
// VAL-SESSION-043: the namespace barrel resolves to the real service file
// =====================================================================================

describe("CodeFree namespace barrel (VAL-SESSION-043)", () => {
  it("exposes maybeShowAd as a callable function, not undefined", () => {
    expect(CodeFree.maybeShowAd).toBeDefined()
    expect(typeof CodeFree.maybeShowAd).toBe("function")
  })

  it("exposes applyUsage as a callable function, not undefined", () => {
    expect(CodeFree.applyUsage).toBeDefined()
    expect(typeof CodeFree.applyUsage).toBe("function")
  })

  it("exposes Service, layer, defaultLayer, and node on the namespace", () => {
    expect(CodeFree.Service).toBeDefined()
    expect(CodeFree.layer).toBeDefined()
    expect(CodeFree.defaultLayer).toBeDefined()
    expect(CodeFree.node).toBeDefined()
  })
})

// =====================================================================================
// VAL-SESSION-036: namespace accessors resolve to the real Service (not undefined)
// =====================================================================================

describe("CodeFree namespace accessors delegate to the Service (VAL-SESSION-036)", () => {
  effEnabled.effect("maybeShowAd accessor publishes one synthetic markdown text part via the Service", () =>
    Effect.gen(function* () {
      const published: SessionV1.TextPart[] = []
      const sid = sessionID("acc_publish")
      yield* CodeFree.maybeShowAd(sid, SessionV1.MessageID.make("msg_acc_publish"), "toolgap", recordingPublisher(published))
      expect(published.length).toBe(1)
      const part = published[0]
      expect(part.type).toBe("text")
      expect(part.synthetic).toBe(true)
      expect(part.text.length).toBeGreaterThan(0)
      expect(part.sessionID).toBe(sid)
    }),
  )

  effEnabled.effect("maybeShowAd accessor credits the wallet +4 via the Service", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const sid = sessionID("acc_credit")
      yield* showAdAndComplete(sid, SessionV1.MessageID.make("msg_acc_credit"), "toolgap", (p) => Effect.succeed(p))
      const balance = yield* wallet.getBalance(TEST_USER_ID)
      expect(balance.balanceCredits).toBe(AD_VIEW_CREDIT_REWARD)
      expect(balance.lifetimeEarnedCredits).toBe(AD_VIEW_CREDIT_REWARD)
    }),
  )

  effEnabled.effect("applyUsage accessor debits the wallet and returns 0 on full coverage via the Service", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const sid = sessionID("acc_usage")
      yield* wallet.creditWallet(TEST_USER_ID, 50, "bonus", "seed for usage")
      const uncovered = yield* CodeFree.applyUsage(sid, 0.2)
      expect(uncovered).toBe(0)
      const balance = yield* wallet.getBalance(TEST_USER_ID)
      expect(balance.balanceCredits).toBe(30)
      expect(balance.lifetimeSpentCredits).toBe(20)
    }),
  )
})

// =====================================================================================
// VAL-SESSION-037: CodeFree layer provides all deps with external Database
// =====================================================================================

describe("CodeFree layer provides all deps with external Database (VAL-SESSION-037)", () => {
  effEnabled.effect("Wallet/Config/Account/EventV2 + CodeFree.Service all resolve from the layer", () =>
    Effect.gen(function* () {
      const codefree = yield* CodeFree.Service
      const wallet = yield* Wallet.Service
      const account = yield* Account.Service
      const config = yield* Config.Service
      expect(codefree).toBeDefined()
      expect(wallet).toBeDefined()
      expect(account).toBeDefined()
      expect(config).toBeDefined()
      const active = yield* account.active()
      expect(Option.isSome(active)).toBe(true)
    }),
  )

  effEnabled.effect("maybeShowAd runs end-to-end with only in-memory Database supplied externally", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const sid = sessionID("deps_maybe")
      yield* showAdAndComplete(sid, SessionV1.MessageID.make("msg_deps_maybe"), "toolgap", (p) => Effect.succeed(p))
      const balance = yield* wallet.getBalance(TEST_USER_ID)
      expect(balance.balanceCredits).toBe(AD_VIEW_CREDIT_REWARD)
    }),
  )
})

// =====================================================================================
// VAL-SESSION-001/002/003/006: maybeShowAd happy path — publish, impression, credit, events
// =====================================================================================

describe("maybeShowAd happy path (VAL-SESSION-001/002/003/006)", () => {
  effEnabled.effect("publishes exactly one synthetic markdown text part (VAL-SESSION-001)", () =>
    Effect.gen(function* () {
      const published: SessionV1.TextPart[] = []
      const sid = sessionID("hp_publish")
      const mid = SessionV1.MessageID.make("msg_hp_publish")
      yield* CodeFree.maybeShowAd(sid, mid, "toolgap", recordingPublisher(published))
      expect(published.length).toBe(1)
      const part = published[0]
      expect(part.type).toBe("text")
      expect(part.synthetic).toBe(true)
      expect(part.text.length).toBeGreaterThan(0)
      expect(part.messageID).toBe(mid)
      expect(part.sessionID).toBe(sid)
    }),
  )

  effEnabled.effect("records an ad impression attributed to the resolved user and session (VAL-SESSION-002)", () =>
    Effect.gen(function* () {
      const sid = sessionID("hp_impression")
      yield* CodeFree.maybeShowAd(sid, SessionV1.MessageID.make("msg_hp_imp"), "toolgap", (p) => Effect.succeed(p))
      const stats = yield* getImpressionStats(sid)
      expect(stats.total_ads).toBe(1)
    }),
  )

  effEnabled.effect("credits the wallet +4 with ad_view attribution (VAL-SESSION-003)", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const sid = sessionID("hp_credit")
      yield* showAdAndComplete(sid, SessionV1.MessageID.make("msg_hp_credit"), "toolgap", (p) => Effect.succeed(p))
      const balance = yield* wallet.getBalance(TEST_USER_ID)
      expect(balance.balanceCredits).toBe(AD_VIEW_CREDIT_REWARD)
      const history = yield* wallet.getTransactionHistory(TEST_USER_ID)
      const adView = history.find((t) => t.type === "ad_view")
      expect(adView).toBeDefined()
      expect(adView!.amountCredits).toBe(AD_VIEW_CREDIT_REWARD)
    }),
  )

  effEnabled.effect("emits impression on show and credit.updated after completion (VAL-SESSION-006)", () =>
    Effect.gen(function* () {
      const sid = sessionID("hp_events")
      const events = yield* showAdAndComplete(
        sid,
        SessionV1.MessageID.make("msg_hp_events"),
        "toolgap",
        (p) => Effect.succeed(p),
      )
      const impressions = events.filter((e) => e.type === "codefree.ad.impression")
      const credits = events.filter((e) => e.type === "codefree.credit.updated")
      expect(impressions.length).toBe(1)
      expect(credits.length).toBe(1)
    }),
  )
})

// =====================================================================================
// VAL-SESSION-026/027/028: event payload shapes + ephemeral (no sync)
// =====================================================================================

describe("event payloads and ephemerality (VAL-SESSION-026/027/028)", () => {
  effEnabled.effect("codefree.ad.impression payload has amount=4, ad_id, slot_type, session_id (VAL-SESSION-026)", () =>
    Effect.gen(function* () {
      const sid = sessionID("shape_imp")
      const events = yield* collectCodefreeEvents(
        CodeFree.maybeShowAd(sid, SessionV1.MessageID.make("msg_shape_imp"), "toolgap", (p) => Effect.succeed(p)),
      )
      const imp = events.find((e) => e.type === "codefree.ad.impression")!
      expect(imp.properties.amount).toBe(4)
      expect(typeof imp.properties.ad_id).toBe("string")
      expect(imp.properties.slot_type).toBe("toolgap")
      expect(imp.properties.session_id).toBe(sid)
    }),
  )

  effEnabled.effect("codefree.credit.updated payload has balance/earned/spent matching wallet (VAL-SESSION-027)", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const sid = sessionID("shape_cred")
      const events = yield* showAdAndComplete(
        sid,
        SessionV1.MessageID.make("msg_shape_cred"),
        "toolgap",
        (p) => Effect.succeed(p),
      )
      const cred = events.find((e) => e.type === "codefree.credit.updated")!
      const balance = yield* wallet.getBalance(TEST_USER_ID)
      expect(cred.properties.balance_credits).toBe(balance.balanceCredits)
      expect(cred.properties.lifetime_earned).toBe(balance.lifetimeEarnedCredits)
      expect(cred.properties.lifetime_spent).toBe(balance.lifetimeSpentCredits)
    }),
  )

  it("both codefree events are defined without sync (ephemeral, no durable rows) (VAL-SESSION-028)", () => {
    expect(EventV2.registry.get("codefree.ad.impression")?.sync).toBeUndefined()
    expect(EventV2.registry.get("codefree.credit.updated")?.sync).toBeUndefined()
  })
})

// =====================================================================================
// VAL-SESSION-040: events reach the GlobalBus via the EventV2 bridge
// =====================================================================================

describe("events reach the GlobalBus via the bridge (VAL-SESSION-040)", () => {
  effEnabled.effect("a bus subscriber receives both event types with correct properties", () =>
    Effect.gen(function* () {
      const sid = sessionID("bus")
      const events = yield* showAdAndComplete(sid, SessionV1.MessageID.make("msg_bus"), "toolgap", (p) => Effect.succeed(p))
      const imp = events.find((e) => e.type === "codefree.ad.impression")
      const cred = events.find((e) => e.type === "codefree.credit.updated")
      expect(imp).toBeDefined()
      expect(cred).toBeDefined()
      expect(imp!.properties.amount).toBe(AD_VIEW_CREDIT_REWARD)
      expect(typeof cred!.properties.balance_credits).toBe("number")
    }),
  )
})

// =====================================================================================
// VAL-SESSION-007/008: disabled config suppresses all side effects + real config drives behavior
// =====================================================================================

describe("real config drives behavior (VAL-SESSION-007/008)", () => {
  effDisabled.effect("disabled config suppresses publish/impression/credit/events (VAL-SESSION-007)", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const published: SessionV1.TextPart[] = []
      const sid = sessionID("disabled")
      const events = yield* collectCodefreeEvents(
        CodeFree.maybeShowAd(sid, SessionV1.MessageID.make("msg_disabled"), "toolgap", recordingPublisher(published)),
      )
      expect(published.length).toBe(0)
      expect((yield* getImpressionStats(sid)).total_ads).toBe(0)
      const balance = yield* wallet.getBalance(TEST_USER_ID).pipe(
        Effect.catchTag("WalletNotFoundError", () => Effect.succeed(null)),
      )
      expect(balance?.balanceCredits ?? 0).toBe(0)
      expect(events.length).toBe(0)
    }),
  )

  effDisabled.effect("reads the REAL config: AdConfig.defaults.enabled is true but config suppresses ads (VAL-SESSION-008)", () =>
    Effect.gen(function* () {
      // The hardcoded AdConfig.defaults.enabled === true, yet the provided Config has enabled:false.
      // Zero side effects proves the real Config.Service is consulted, not the hardcoded defaults.
      const published: SessionV1.TextPart[] = []
      const sid = sessionID("real_cfg")
      yield* CodeFree.maybeShowAd(sid, SessionV1.MessageID.make("msg_real_cfg"), "toolgap", recordingPublisher(published))
      expect(published.length).toBe(0)
      expect((yield* getImpressionStats(sid)).total_ads).toBe(0)
    }),
  )
})

// =====================================================================================
// VAL-SESSION-009/010/011/041: gating — interval, hourly cap, per-session isolation, config merge
// =====================================================================================

describe("gating honors the real config (VAL-SESSION-009/010/011/041)", () => {
  effGated.live("min_interval_ms gating suppresses a back-to-back ad (VAL-SESSION-009)", () =>
    Effect.gen(function* () {
      const sid = sessionID("interval")
      const published: SessionV1.TextPart[] = []
      const pub = recordingPublisher(published)
      yield* CodeFree.maybeShowAd(sid, SessionV1.MessageID.make("msg_i1"), "toolgap", pub)
      expect(published.length).toBe(1)
      // Second call immediately after — within min_interval_ms — is suppressed.
      yield* CodeFree.maybeShowAd(sid, SessionV1.MessageID.make("msg_i2"), "toolgap", pub)
      expect(published.length).toBe(1)
    }),
  )

  effCapped.live("max_ads_per_hour cap suppresses ads beyond the limit (VAL-SESSION-010/041)", () =>
    Effect.gen(function* () {
      const sid = sessionID("cap")
      const published: SessionV1.TextPart[] = []
      const pub = recordingPublisher(published)
      yield* CodeFree.maybeShowAd(sid, SessionV1.MessageID.make("msg_c1"), "toolgap", pub)
      yield* CodeFree.maybeShowAd(sid, SessionV1.MessageID.make("msg_c2"), "toolgap", pub)
      expect(published.length).toBe(2)
      // Third eligible call within the same hour is suppressed by the cap.
      yield* CodeFree.maybeShowAd(sid, SessionV1.MessageID.make("msg_c3"), "toolgap", pub)
      expect(published.length).toBe(2)
    }),
  )

  effIsolated.live("per-session gating is isolated across sessions (VAL-SESSION-011)", () =>
    Effect.gen(function* () {
      const sidA = sessionID("iso_a")
      const sidB = sessionID("iso_b")
      const pubA: SessionV1.TextPart[] = []
      const pubB: SessionV1.TextPart[] = []
      yield* CodeFree.maybeShowAd(sidA, SessionV1.MessageID.make("msg_ia1"), "toolgap", recordingPublisher(pubA))
      // Session A hit its cap of 1 — second call suppressed.
      yield* CodeFree.maybeShowAd(sidA, SessionV1.MessageID.make("msg_ia2"), "toolgap", recordingPublisher(pubA))
      expect(pubA.length).toBe(1)
      // Session B is independent — still eligible.
      yield* CodeFree.maybeShowAd(sidB, SessionV1.MessageID.make("msg_ib1"), "toolgap", recordingPublisher(pubB))
      expect(pubB.length).toBe(1)
    }),
  )

  effMerged.live("partial user config merges over defaults (VAL-SESSION-041)", () =>
    Effect.gen(function* () {
      const sid = sessionID("merge")
      const published: SessionV1.TextPart[] = []
      const pub = recordingPublisher(published)
      // First ad: default min_interval_ms (30000) is satisfied (lastAdTime 0).
      yield* CodeFree.maybeShowAd(sid, SessionV1.MessageID.make("msg_m1"), "toolgap", pub)
      expect(published.length).toBe(1)
      // Second ad within default min_interval_ms (30000) is suppressed by the default interval.
      yield* CodeFree.maybeShowAd(sid, SessionV1.MessageID.make("msg_m2"), "toolgap", pub)
      expect(published.length).toBe(1)
    }),
  )
})

// =====================================================================================
// VAL-SESSION-012/013/014: fire-and-forget, publishPart aborts, no eligible ad
// =====================================================================================

describe("fire-and-forget and abort semantics (VAL-SESSION-012/013/014)", () => {
  effFailing.effect("wallet failure is swallowed — maybeShowAd still publishes and succeeds (VAL-SESSION-012)", () =>
    Effect.gen(function* () {
      const published: SessionV1.TextPart[] = []
      const sid = sessionID("faf")
      // The part is published; the wallet credit fails but is swallowed — no throw.
      yield* CodeFree.maybeShowAd(sid, SessionV1.MessageID.make("msg_faf"), "toolgap", recordingPublisher(published))
      expect(published.length).toBe(1)
    }),
  )

  effEnabled.effect("publishPart failure aborts before credit/events and does not bump the cap (VAL-SESSION-013)", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const sid = sessionID("abort")
      // publishPart is declared non-failing (Effect<TextPart>); the test injects a failure to prove
      // maybeShowAd aborts before crediting/events. The assertion widens the error channel.
      const failPublish: (part: SessionV1.TextPart) => Effect.Effect<SessionV1.TextPart> = () =>
        Effect.fail(new Error("publish failed")) as unknown as Effect.Effect<SessionV1.TextPart>
      yield* CodeFree.maybeShowAd(sid, SessionV1.MessageID.make("msg_abort"), "toolgap", failPublish).pipe(
        Effect.catch(() => Effect.void),
      )
      // No credit, no impression.
      const balance = yield* wallet.getBalance(TEST_USER_ID).pipe(
        Effect.catchTag("WalletNotFoundError", () => Effect.succeed(null)),
      )
      expect(balance?.balanceCredits ?? 0).toBe(0)
      expect((yield* getImpressionStats(sid)).total_ads).toBe(0)
      // The failed ad did not count toward caps: a subsequent call with a working publish fires.
      const published: SessionV1.TextPart[] = []
      yield* CodeFree.maybeShowAd(sid, SessionV1.MessageID.make("msg_abort_ok"), "toolgap", recordingPublisher(published))
      expect(published.length).toBe(1)
    }),
  )

  effNoAd.effect("no eligible ad suppresses all side effects (VAL-SESSION-014)", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const published: SessionV1.TextPart[] = []
      const sid = sessionID("noad")
      const events = yield* collectCodefreeEvents(
        CodeFree.maybeShowAd(sid, SessionV1.MessageID.make("msg_noad"), "toolgap", recordingPublisher(published)),
      )
      expect(published.length).toBe(0)
      expect((yield* getImpressionStats(sid)).total_ads).toBe(0)
      const balance = yield* wallet.getBalance(TEST_USER_ID).pipe(
        Effect.catchTag("WalletNotFoundError", () => Effect.succeed(null)),
      )
      expect(balance?.balanceCredits ?? 0).toBe(0)
      expect(events.length).toBe(0)
    }),
  )
})

// =====================================================================================
// VAL-SESSION-022/023/024: stable local user id (no remote account)
// =====================================================================================

describe("stable local user id (VAL-SESSION-022/023/024)", () => {
  effLocal.live("no remote account still credits +4 to a stable local wallet (VAL-SESSION-022)", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const sid = sessionID("local_credit")
      yield* showAdAndComplete(sid, SessionV1.MessageID.make("msg_local_credit"), "toolgap", (p) => Effect.succeed(p))
      const localId = yield* Effect.promise(() => Bun.file(LOCAL_ID_FILE).text())
      expect(localId.startsWith("cfu_")).toBe(true)
      const balance = yield* wallet.getBalance(localId)
      expect(balance.balanceCredits).toBe(AD_VIEW_CREDIT_REWARD)
      expect(balance.lifetimeEarnedCredits).toBe(AD_VIEW_CREDIT_REWARD)
    }),
  )

  it("the stable local user id is reused across independent layer constructions (VAL-SESSION-023)", async () => {
    const runOnce = () => {
      const layer = buildLayer({ account: noAccount, config: enabledConfig, global: Global.layerWith({ data: localIdDir }) })
      return Effect.runPromise(
        Effect.gen(function* () {
          yield* CodeFree.maybeShowAd(
            sessionID("xrun"),
            SessionV1.MessageID.make("msg_xrun"),
            "toolgap",
            (p) => Effect.succeed(p),
          )
        }).pipe(Effect.provide(layer)),
      )
    }
    await runOnce()
    const id1 = await Bun.file(LOCAL_ID_FILE).text()
    await runOnce()
    const id2 = await Bun.file(LOCAL_ID_FILE).text()
    expect(id1).toBe(id2)
    expect(id1.startsWith("cfu_")).toBe(true)
  })

  effLocal.live("applyUsage debits the same stable local wallet that maybeShowAd credited (VAL-SESSION-024)", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const sid = sessionID("local_usage")
      yield* showAdAndComplete(sid, SessionV1.MessageID.make("msg_lu"), "toolgap", (p) => Effect.succeed(p))
      const localId = yield* Effect.promise(() => Bun.file(LOCAL_ID_FILE).text())
      const before = yield* wallet.getBalance(localId)
      expect(before.balanceCredits).toBe(AD_VIEW_CREDIT_REWARD)
      // applyUsage on a small cost ($0.01 = 1 credit) debits the same local wallet.
      const uncovered = yield* CodeFree.applyUsage(sid, 0.01)
      expect(uncovered).toBe(0)
      const after = yield* wallet.getBalance(localId)
      expect(after.balanceCredits).toBe(3)
      expect(after.lifetimeSpentCredits).toBe(1)
    }),
  )
})

// =====================================================================================
// VAL-SESSION-025: remote account id takes precedence over the local id
// =====================================================================================

describe("remote account precedence (VAL-SESSION-025)", () => {
  effRemote.live("an active remote account is credited, not the local id (VAL-SESSION-025)", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const sid = sessionID("remote")
      yield* showAdAndComplete(sid, SessionV1.MessageID.make("msg_remote"), "toolgap", (p) => Effect.succeed(p))
      const balance = yield* wallet.getBalance(REMOTE_USER_ID)
      expect(balance.balanceCredits).toBe(AD_VIEW_CREDIT_REWARD)
      expect(balance.lifetimeEarnedCredits).toBe(AD_VIEW_CREDIT_REWARD)
    }),
  )
})

// =====================================================================================
// VAL-SESSION-015/016/017/018/042: applyUsage coverage accounting
// =====================================================================================

// Seed the test user's wallet with `amount` credits before an applyUsage call.
function seedCredits(amount: number) {
  return Effect.gen(function* () {
    const wallet = yield* Wallet.Service
    yield* wallet.creditWallet(TEST_USER_ID, amount, "bonus", "test seed")
  })
}

describe("applyUsage coverage accounting (VAL-SESSION-015/016/017/018/042)", () => {
  effEnabled.live("full coverage: debits usdToCredits(cost) and returns 0 (VAL-SESSION-015)", () =>
    Effect.gen(function* () {
      yield* seedCredits(50)
      const uncovered = yield* CodeFree.applyUsage(sessionID("full"), 0.2)
      expect(uncovered).toBe(0)
      const wallet = yield* Wallet.Service
      const balance = yield* wallet.getBalance(TEST_USER_ID)
      expect(balance.balanceCredits).toBe(30)
      expect(balance.lifetimeSpentCredits).toBe(20)
    }),
  )

  effEnabled.live("no balance: returns the full costUSD, no debit (VAL-SESSION-016)", () =>
    Effect.gen(function* () {
      const uncovered = yield* CodeFree.applyUsage(sessionID("nobal"), 0.2)
      expect(uncovered).toBe(0.2)
      const wallet = yield* Wallet.Service
      // Wallet may not exist for this user yet (no prior credit) — treat as 0 balance.
      const balance = yield* wallet.getBalance(TEST_USER_ID).pipe(
        Effect.catchTag("WalletNotFoundError", () => Effect.succeed(null)),
      )
      expect(balance?.balanceCredits ?? 0).toBe(0)
    }),
  )

  effEnabled.live("partial coverage: debits available and returns the remainder (VAL-SESSION-017/042)", () =>
    Effect.gen(function* () {
      yield* seedCredits(10)
      const uncovered = yield* CodeFree.applyUsage(sessionID("partial"), 0.5)
      // Needs 50 credits, only 10 available → debits 10, returns creditsToUsd(40) = 0.4.
      expect(uncovered).toBe(0.4)
      const wallet = yield* Wallet.Service
      const balance = yield* wallet.getBalance(TEST_USER_ID)
      expect(balance.balanceCredits).toBe(0)
      expect(balance.lifetimeSpentCredits).toBe(10)
    }),
  )

  effEnabled.live("zero/negative cost is a no-op: returns 0, no debit, no events (VAL-SESSION-018)", () =>
    Effect.gen(function* () {
      yield* seedCredits(50)
      const events = yield* collectCodefreeEvents(
        Effect.gen(function* () {
          const u1 = yield* CodeFree.applyUsage(sessionID("zero"), 0)
          const u2 = yield* CodeFree.applyUsage(sessionID("neg"), -1)
          expect(u1).toBe(0)
          expect(u2).toBe(0)
        }),
      )
      expect(events.length).toBe(0)
      const wallet = yield* Wallet.Service
      const balance = yield* wallet.getBalance(TEST_USER_ID)
      expect(balance.balanceCredits).toBe(50)
      expect(balance.lifetimeSpentCredits).toBe(0)
    }),
  )

  effEnabled.live("no wallet at all returns full cost without throwing (VAL-SESSION-039)", () =>
    Effect.gen(function* () {
      // No prior creditWallet → wallet doesn't exist for this user. applyUsage must return the
      // full cost without debiting or emitting events (same behavior as the no-user-id guard).
      const events = yield* collectCodefreeEvents(
        Effect.gen(function* () {
          const uncovered = yield* CodeFree.applyUsage(sessionID("nowallet"), 0.3)
          expect(uncovered).toBe(0.3)
        }),
      )
      expect(events.length).toBe(0)
    }),
  )
})

// =====================================================================================
// VAL-SESSION-020: applyUsage emits credit.updated only after a nonzero debit
// =====================================================================================

describe("applyUsage credit.updated emission (VAL-SESSION-020)", () => {
  effEnabled.live("emits one credit.updated after a nonzero debit", () =>
    Effect.gen(function* () {
      yield* seedCredits(50)
      const events = yield* collectCodefreeEvents(
        Effect.gen(function* () {
          yield* CodeFree.applyUsage(sessionID("emit_debit"), 0.2)
        }),
      )
      const credits = events.filter((e) => e.type === "codefree.credit.updated")
      expect(credits.length).toBe(1)
      // The emitted balance reflects the post-debit state.
      expect(credits[0].properties.balance_credits).toBe(30)
      expect(credits[0].properties.lifetime_spent).toBe(20)
    }),
  )

  effEnabled.live("emits NO credit.updated when nothing is debited (zero balance)", () =>
    Effect.gen(function* () {
      const events = yield* collectCodefreeEvents(
        Effect.gen(function* () {
          yield* CodeFree.applyUsage(sessionID("emit_none"), 0.2)
        }),
      )
      const credits = events.filter((e) => e.type === "codefree.credit.updated")
      expect(credits.length).toBe(0)
    }),
  )
})

// =====================================================================================
// VAL-SESSION-035: ad credit then usage debit reconciles to the wallet
// =====================================================================================

describe("ad credit then usage debit reconciles (VAL-SESSION-035)", () => {
  effEnabled.live("balance == earned - spent after earning and spending", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const sid = sessionID("reconcile")
      yield* showAdAndComplete(sid, SessionV1.MessageID.make("msg_recon"), "toolgap", (p) => Effect.succeed(p))
      const uncovered = yield* CodeFree.applyUsage(sid, 0.01)
      expect(uncovered).toBe(0)
      const balance = yield* wallet.getBalance(TEST_USER_ID)
      expect(balance.balanceCredits).toBe(balance.lifetimeEarnedCredits - balance.lifetimeSpentCredits)
      expect(balance.balanceCredits).toBe(3)
      expect(balance.lifetimeEarnedCredits).toBe(AD_VIEW_CREDIT_REWARD)
      expect(balance.lifetimeSpentCredits).toBe(1)
    }),
  )
})

// =====================================================================================
// VAL-SESSION-030: costCoveredByCredits round-trips through the Assistant schema
// =====================================================================================

describe("Assistant schema costCoveredByCredits (VAL-SESSION-030)", () => {
  // A minimal valid Assistant object for schema round-trip tests. Branded ids are constructed via
  // their `.make()` statics; costCoveredByCredits is overlaid per-test.
  const assistantFixture: SessionV1.Assistant = {
    id: SessionV1.MessageID.make("msg_schema_test"),
    sessionID: SessionV2.ID.make("sess_schema_test"),
    role: "assistant",
    time: { created: Date.now() },
    parentID: SessionV1.MessageID.make("msg_parent"),
    modelID: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0.05,
    tokens: {
      input: 10,
      output: 5,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  }

  it("a present costCoveredByCredits value round-trips through encode/decode", () => {
    const encoded = Schema.encodeSync(SessionV1.Assistant)({ ...assistantFixture, costCoveredByCredits: 0.03 })
    const decoded = Schema.decodeSync(SessionV1.Assistant)(encoded)
    expect(decoded.costCoveredByCredits).toBe(0.03)
  })

  it("an absent costCoveredByCredits stays absent (not coerced to 0)", () => {
    const fixture = { ...assistantFixture }
    delete fixture.costCoveredByCredits
    const encoded = Schema.encodeSync(SessionV1.Assistant)(fixture)
    const decoded = Schema.decodeSync(SessionV1.Assistant)(encoded)
    expect(decoded.costCoveredByCredits).toBeUndefined()
  })
})

// =====================================================================================
// VAL-TUI-025 / VAL-CROSS-016: boot hydration emits credit.updated with persisted balance
// =====================================================================================
//
// hydrateWallet reads the resolved user's persisted wallet balance and emits a single
// codefree.credit.updated event so the TUI footer reconciles to the persisted balance on
// restart (not 0). This is the backend half of boot hydration; the TUI wallet store already
// subscribes to codefree.credit.updated and reconciles balance_credits/lifetime_*.

describe("CodeFree namespace exposes hydrateWallet (VAL-TUI-025)", () => {
  it("exposes hydrateWallet as a callable function, not undefined", () => {
    expect(CodeFree.hydrateWallet).toBeDefined()
    expect(typeof CodeFree.hydrateWallet).toBe("function")
  })
})

describe("CodeFree hydrateWallet emits credit.updated with the persisted balance (VAL-TUI-025 / VAL-CROSS-016)", () => {
  effEnabled.effect("emits one credit.updated with a persisted positive balance", () =>
    collectCodefreeEvents(
      Effect.gen(function* () {
        const wallet = yield* Wallet.Service
        // Seed a persisted balance so hydration has something real to report.
        yield* wallet.creditWallet(TEST_USER_ID, 8, "bonus", "seed before restart")
        yield* CodeFree.hydrateWallet(sessionID("hydrate_pos"))
      }),
    ).pipe(
      Effect.map((events) => {
        const creditEvents = events.filter((e) => e.type === "codefree.credit.updated")
        expect(creditEvents.length).toBe(1)
        const props = creditEvents[0].properties as {
          balance_credits: number
          lifetime_earned: number
          lifetime_spent: number
        }
        // The persisted balance (8 credits) is reflected, not 0.
        expect(props.balance_credits).toBe(8)
        expect(props.lifetime_earned).toBe(8)
        expect(props.lifetime_spent).toBe(0)
      }),
    ),
  )

  effEnabled.effect("emits credit.updated with zeros for a fresh wallet (no prior activity)", () =>
    collectCodefreeEvents(
      Effect.gen(function* () {
        yield* CodeFree.hydrateWallet(sessionID("hydrate_zero"))
      }),
    ).pipe(
      Effect.map((events) => {
        const creditEvents = events.filter((e) => e.type === "codefree.credit.updated")
        expect(creditEvents.length).toBe(1)
        const props = creditEvents[0].properties as { balance_credits: number }
        expect(props.balance_credits).toBe(0)
      }),
    ),
  )

  effEnabled.effect("hydrateWallet never throws — failures are swallowed (non-breaking)", () =>
    collectCodefreeEvents(
      Effect.gen(function* () {
        // hydrateWallet with a normal layer should always succeed (void) even if the wallet
        // is empty. The processor calls it fire-and-forget so it must never break the session.
        const result = yield* Effect.exit(CodeFree.hydrateWallet(sessionID("hydrate_safe")))
        expect(Exit.isSuccess(result)).toBe(true)
      }),
    ).pipe(
      Effect.map(() => {
        // Exit already asserted above; this map ensures the effect runs to completion.
      }),
    ),
  )
})

// =====================================================================================
// VAL-SESSION-026: clickAd credits the wallet +100 (affiliate_click) and persists the click
// =====================================================================================

describe("CodeFree clickAd credits the wallet +100 and emits events (VAL-SESSION-026)", () => {
  effEnabled.effect("clickAd credits the wallet +100 with type affiliate_click", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const adStore = yield* Store.Service
      const sid = sessionID("click_credit")

      // Record a manual impression directly via the AdStore so we have a known impression id.
      const impression = trackImpression(
        fetchAds(ConfigCodefree.toAdConfig(new ConfigCodefree.Info({ enabled: true })))[0],
        "toolgap",
        sid,
        TEST_USER_ID,
        1000,
      )
      yield* adStore.recordImpression(impression)

      // clickAd should credit +100 (affiliate_click).
      yield* CodeFree.clickAd(sid, impression.id, "https://example.com/click", "Test ad")

      const balance = yield* wallet.getBalance(TEST_USER_ID)
      expect(balance.balanceCredits).toBe(AFFILIATE_CLICK_CREDIT_REWARD)
      expect(balance.lifetimeEarnedCredits).toBe(AFFILIATE_CLICK_CREDIT_REWARD)
    }),
  )

  effEnabled.effect("view (+4) then click (+100) credits 104 total, and stats reflect the click", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const adStore = yield* Store.Service
      const sid = sessionID("click_full")

      yield* showAdAndComplete(sid, SessionV1.MessageID.make("msg_view"), "toolgap", (p) => Effect.succeed(p))

      const impression = trackImpression(
        fetchAds(ConfigCodefree.toAdConfig(new ConfigCodefree.Info({ enabled: true })))[0],
        "toolgap",
        sid,
        TEST_USER_ID,
        1000,
      )
      yield* adStore.recordImpression(impression)

      // Click it (credits +100).
      yield* CodeFree.clickAd(sid, impression.id, "https://example.com/click2", "Second ad")

      const balance = yield* wallet.getBalance(TEST_USER_ID)
      expect(balance.balanceCredits).toBe(AD_VIEW_CREDIT_REWARD + AFFILIATE_CLICK_CREDIT_REWARD)

      // Stats: 2 total impressions, 1 click. credits_earned = 2*4 + 1*100 = 108.
      const stats = yield* getImpressionStats(sid)
      expect(stats.total_ads).toBe(2)
      expect(stats.total_clicks).toBe(1)
      expect(stats.credits_earned).toBe(2 * AD_VIEW_CREDIT_REWARD + 1 * AFFILIATE_CLICK_CREDIT_REWARD)
    }),
  )

  effEnabled.effect("clickAd emits codefree.ad.click and codefree.credit.updated events", () =>
    collectCodefreeEvents(
      Effect.gen(function* () {
        const adStore = yield* Store.Service
        const sid = sessionID("click_events")

        const impression = trackImpression(
          fetchAds(ConfigCodefree.toAdConfig(new ConfigCodefree.Info({ enabled: true })))[0],
          "toolgap",
          sid,
          TEST_USER_ID,
          1000,
        )
        yield* adStore.recordImpression(impression)
        yield* CodeFree.clickAd(sid, impression.id, "https://example.com/click3", "Event ad")
      }),
    ).pipe(
      Effect.map((events) => {
        const clickEvents = events.filter((e) => e.type === "codefree.ad.click")
        const creditEvents = events.filter((e) => e.type === "codefree.credit.updated")
        expect(clickEvents.length).toBe(1)
        expect(clickEvents[0].properties.amount).toBe(AFFILIATE_CLICK_CREDIT_REWARD)
        expect(creditEvents.length).toBe(1)
        expect(creditEvents[0].properties.balance_credits).toBe(AFFILIATE_CLICK_CREDIT_REWARD)
      }),
    ),
  )

  effEnabled.effect("clickAd for an unknown impression id is a no-op (credits nothing)", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const sid = sessionID("click_unknown")

      yield* CodeFree.clickAd(sid, "nonexistent-impression", "https://example.com/nope", "Ghost ad")

      // No wallet exists yet for this user since no ad was shown and no click credited.
      const balance = yield* wallet.getBalance(TEST_USER_ID).pipe(
        Effect.catchTag("WalletNotFoundError", () => Effect.succeed(null)),
      )
      expect(balance).toBeNull()
    }),
  )
})

// =====================================================================================
// Dwell-verified impression loop (VAL-CF-030/031/032/033)
// =====================================================================================

describe("dwell-verified impressions (VAL-CF-030/031/032/033)", () => {
  effEnabled.effect("VAL-CF-033: maybeShowAd no longer credits directly", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const sid = sessionID("no_direct_credit")
      yield* CodeFree.maybeShowAd(sid, SessionV1.MessageID.make("msg_no_credit"), "toolgap", (p) => Effect.succeed(p))
      const balance = yield* wallet.getBalance(TEST_USER_ID).pipe(
        Effect.catchTag("WalletNotFoundError", () => Effect.succeed(null)),
      )
      expect(balance?.balanceCredits ?? 0).toBe(0)
    }),
  )

  effEnabled.effect("VAL-CF-030: completeImpression credits once, rejects duplicate", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const sid = sessionID("complete_once")
      const seen: Array<{ type: string; properties: Record<string, unknown> }> = []
      const handler = (evt: { payload?: { type?: string; properties?: Record<string, unknown> } }) => {
        const type = evt.payload?.type
        if (typeof type === "string" && type.startsWith("codefree.")) {
          seen.push({ type, properties: evt.payload!.properties! })
        }
      }
      GlobalBus.on("event", handler)
      yield* CodeFree.maybeShowAd(sid, SessionV1.MessageID.make("msg_complete_once"), "toolgap", (p) => Effect.succeed(p))
      GlobalBus.off("event", handler)
      const impressionId = seen.find((event) => event.type === "codefree.ad.impression")?.properties.impression_id
      expect(typeof impressionId).toBe("string")
      yield* backdateImpression(impressionId as string)
      const first = yield* CodeFree.completeImpression(sid, impressionId as string)
      const duplicate = yield* CodeFree.completeImpression(sid, impressionId as string)
      expect(first.credited).toBe(true)
      expect(duplicate.credited).toBe(false)
      expect(duplicate.reason).toBe("duplicate")
      const balance = yield* wallet.getBalance(TEST_USER_ID)
      expect(balance.balanceCredits).toBe(AD_VIEW_CREDIT_REWARD)
    }),
  )

  effEnabled.effect("VAL-CF-031: completeImpression rejects before slot_min_ms elapsed", () =>
    Effect.gen(function* () {
      const sid = sessionID("too_fast")
      const seen: Array<{ type: string; properties: Record<string, unknown> }> = []
      const handler = (evt: { payload?: { type?: string; properties?: Record<string, unknown> } }) => {
        const type = evt.payload?.type
        if (typeof type === "string" && type.startsWith("codefree.")) {
          seen.push({ type, properties: evt.payload!.properties! })
        }
      }
      GlobalBus.on("event", handler)
      yield* CodeFree.maybeShowAd(sid, SessionV1.MessageID.make("msg_fast"), "toolgap", (p) => Effect.succeed(p))
      GlobalBus.off("event", handler)
      const impressionId = seen.find((event) => event.type === "codefree.ad.impression")?.properties.impression_id
      expect(typeof impressionId).toBe("string")
      const result = yield* CodeFree.completeImpression(sid, impressionId as string)
      expect(result.credited).toBe(false)
      expect(result.reason).toBe("too_fast")
    }),
  )

  effEnabled.effect("VAL-CF-032: click credits 100 once and is blocked by daily cap", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const adStore = yield* Store.Service
      const sid = sessionID("click_cap")
      yield* wallet.creditWallet(TEST_USER_ID, MAX_DAILY_CREDITS - 50, "affiliate_click", "near cap")

      const impression = trackImpression(
        fetchAds(ConfigCodefree.toAdConfig(new ConfigCodefree.Info({ enabled: true })))[0],
        "toolgap",
        sid,
        TEST_USER_ID,
        1000,
      )
      yield* adStore.recordImpression(impression)
      yield* CodeFree.clickAd(sid, impression.id, "https://example.com/cap", "Cap ad")

      const balance = yield* wallet.getBalance(TEST_USER_ID)
      expect(balance.balanceCredits).toBe(MAX_DAILY_CREDITS - 50)
    }),
  )
})
