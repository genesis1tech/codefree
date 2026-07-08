import path from "path"
import { Effect, Context, Layer, Option, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Wallet } from "@opencode-ai/core/wallet"
import { shouldShowAd, selectAd, formatAdAsMarkdown, trackImpression, resetFrequencyCaps } from "@opencode-ai/core/ad/injector"
import { Store as AdStore, AdSource } from "@opencode-ai/core/ad/service"
import { AD_VIEW_CREDIT_REWARD, AFFILIATE_CLICK_CREDIT_REWARD } from "@opencode-ai/core/wallet/config"
import { AdConfig } from "@opencode-ai/core/ad/types"
import { ConfigCodefree } from "@opencode-ai/core/config/codefree"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { applyUsage as applyUsageCredits, completeImpression as completeImpressionCredits, creditAdClick } from "@opencode-ai/core/codefree"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/layer-node-platform"
import { Account } from "@/account/account"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { PartID, SessionID } from "./schema"

type AdSlotType = "thinking" | "toolgap" | "idle"

// --- Ephemeral EventV2 event definitions (no `sync` => no durable table rows) ---
//
// Both events are delivered only via listeners/streams and the EventV2Bridge forwards them to the
// GlobalBus so the TUI wallet store can react live. Payload shapes match what context/wallet.tsx
// reads (amount / balance_credits / lifetime_earned / lifetime_spent).
const AdImpressionEvent = EventV2.define({
  type: "codefree.ad.impression",
  schema: {
    amount: Schema.Number,
    ad_id: Schema.String,
    slot_type: Schema.Literals(["thinking", "toolgap", "idle"]),
    session_id: Schema.String,
    impression_id: Schema.String,
    slot_min_ms: Schema.Number,
    headline: Schema.String,
    body: Schema.String,
    cta_text: Schema.String,
    cta_url: Schema.String,
    display_url: Schema.String,
    advertiser_id: Schema.String,
    category: Schema.String,
  },
})

const AdClickEvent = EventV2.define({
  type: "codefree.ad.click",
  schema: {
    amount: Schema.Number,
    ad_id: Schema.String,
    impression_id: Schema.String,
    session_id: Schema.String,
  },
})

const CreditUpdatedEvent = EventV2.define({
  type: "codefree.credit.updated",
  schema: {
    balance_credits: Schema.Number,
    lifetime_earned: Schema.Number,
    lifetime_spent: Schema.Number,
  },
})

// --- Per-session ad tracking state (frequency / interval gating) ---

const lastAdTimes: Record<string, number> = {}
const adCountsThisHour: Record<string, number> = {}
let hourlyResetTimer: ReturnType<typeof setInterval> | undefined

// Reset hourly counters at the top of each hour so the max_ads_per_hour cap is per-hour, not lifetime.
if (!hourlyResetTimer) {
  const msUntilNextHour = (60 - new Date().getMinutes()) * 60 * 1000
  hourlyResetTimer = setInterval(() => {
    for (const key of Object.keys(adCountsThisHour)) {
      delete adCountsThisHour[key]
    }
    resetFrequencyCaps()
  }, msUntilNextHour)
  hourlyResetTimer.unref()
}

function getLastAdTime(sessionID: string): number {
  return lastAdTimes[sessionID] ?? 0
}

function getAdCountThisHour(sessionID: string): number {
  return adCountsThisHour[sessionID] ?? 0
}

function incrementAdCount(sessionID: string): void {
  adCountsThisHour[sessionID] = getAdCountThisHour(sessionID) + 1
}

// --- Interface ---
//
// sessionID/messageID are the branded id types the processor already holds. applyUsage's error
// channel is declared honestly (the core applyUsage only throws on a vanishingly rare wallet
// removal between balance-read and debit); the processor wraps the call so a failure never breaks
// the session.

export interface Interface {
  readonly maybeShowAd: (
    sessionID: SessionID,
    messageID: SessionV1.MessageID,
    slotType: AdSlotType,
    publishPart: (part: SessionV1.TextPart) => Effect.Effect<SessionV1.TextPart>,
  ) => Effect.Effect<void>
  readonly applyUsage: (
    sessionID: SessionID,
    costUSD: number,
  ) => Effect.Effect<number, Wallet.WalletNotFoundError | Wallet.InsufficientBalanceError>
  // Records an ad click: persists the click event to the AdStore and credits the resolved user's
  // wallet with AFFILIATE_CLICK_CREDIT_REWARD (affiliate_click type), then emits credit.updated.
  // Fire-and-forget from the TUI/caller — never breaks the session (VAL-SESSION-026).
  readonly clickAd: (
    sessionID: SessionID,
    impressionID: string,
    clickURL: string,
    adHeadline?: string,
  ) => Effect.Effect<void>
  readonly completeImpression: (
    sessionID: SessionID,
    impressionID: string,
    adHeadline?: string,
  ) => Effect.Effect<{ credited: boolean; reason?: string; balance_credits?: number }>
  // Boot/session-start hydration: reads the resolved user's persisted wallet balance and emits a
  // single codefree.credit.updated event so the TUI footer reconciles to the persisted balance on
  // restart (not 0). Fire-and-forget from the processor — never breaks the session (VAL-TUI-025).
  readonly hydrateWallet: (sessionID: SessionID) => Effect.Effect<void>
}

// --- Service ---

export class Service extends Context.Service<Service, Interface>()("@opencode/CodeFree") {}

// --- Layer ---

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Capture dependencies once in the layer scope; the service methods below use these closures,
    // so each method's environment stays `never` (deps are not re-yielded per call).
    const account = yield* Account.Service
    const wallet = yield* Wallet.Service
    const adStore = yield* AdStore.Service
    const adSource = yield* AdSource.Service
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service
    const global = yield* Global.Service

    // Read the REAL codefree config (from opencode.json via Config.Service) merged over the engine
    // defaults — never the hardcoded AdConfig.defaults, so toggling the config actually drives
    // behavior (VAL-SESSION-008/041).
    const readAdConfig = Effect.fnUntraced(function* () {
      const info = yield* config.get()
      const base = ConfigCodefree.toAdConfig(info.codefree)
      const userID = yield* resolveUserID()
      const pref = yield* adStore.getPreference(userID).pipe(Effect.catch(() => Effect.succeed(null)))
      if (!pref) return base
      return Schema.decodeUnknownSync(AdConfig)({
        enabled: pref.enabled,
        min_interval_ms: base.min_interval_ms,
        max_ads_per_hour: base.max_ads_per_hour,
        categories: pref.categories,
        frequency_cap: base.frequency_cap,
      })
    })

    // Read the ad server URL from the codefree config block. Unset => local placeholders (Phase 0).
    const readAdServerURL = Effect.fnUntraced(function* () {
      const info = yield* config.get()
      return info.codefree?.ad_server_url
    })

    const reportUpstream = (adServerUrl: string, path: string, body: Record<string, unknown>) =>
      Effect.tryPromise({
        try: () =>
          fetch(`${adServerUrl}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
          }),
        catch: () => new Error("upstream report failed"),
      }).pipe(Effect.catch(() => Effect.void))

    // Resolve the user id used for impression attribution and wallet crediting. A remote account
    // takes precedence; otherwise a stable local user id is persisted in the opencode global data
    // dir (generated once, reused across runs/sessions) so a purely local user still earns and
    // spends credits consistently (VAL-SESSION-022/023/025).
    const resolveLocalUserID = Effect.fnUntraced(function* () {
      const idPath = path.join(global.data, "codefree_local_user_id")
      const file = Bun.file(idPath)
      const exists = yield* Effect.promise(() => file.exists())
      if (exists) {
        const text = (yield* Effect.promise(() => file.text())).trim()
        if (text) return text
      }
      // Generate once and persist so the same id is returned on every subsequent run.
      const id = `cfu_${crypto.randomUUID()}`
      yield* Effect.promise(() => Bun.write(idPath, id))
      return id
    })

    const resolveUserID = Effect.fnUntraced(function* () {
      // Account lookup is best-effort: any AccountError (no account configured, DB unavailable)
      // means no remote account, so fall through to the stable local id.
      const opt = yield* account.active().pipe(
        Effect.catch(() => Effect.succeed(Option.none<Account.Info>())),
      )
      if (Option.isSome(opt)) return opt.value.id
      return yield* resolveLocalUserID()
    })

    return Service.of({
      maybeShowAd: Effect.fn("CodeFree.maybeShowAd")(function* (
        sessionID: SessionID,
        messageID: SessionV1.MessageID,
        slotType: AdSlotType,
        publishPart: (part: SessionV1.TextPart) => Effect.Effect<SessionV1.TextPart>,
      ) {
        const adConfig = yield* readAdConfig()

        // Ads must be enabled — skip entirely if disabled (no side effects at all).
        if (!adConfig.enabled) return

        const lastAdTime = getLastAdTime(sessionID)
        const countThisHour = getAdCountThisHour(sessionID)
        if (!shouldShowAd(slotType, lastAdTime, countThisHour, adConfig)) return

        const adServerUrl = yield* readAdServerURL()
        const availableAds = yield* adSource.fetchAds(adServerUrl, slotType, adConfig.categories)
        const ad = selectAd(slotType, adConfig.categories, availableAds, adConfig)
        // No eligible ad => no side effects (VAL-SESSION-014).
        if (!ad) return

        const userID = yield* resolveUserID()
        const markdown = formatAdAsMarkdown(ad)

        // Publish the ad part FIRST. A publishPart failure aborts before any side effect
        // (impression/credit/events) and the ad is not counted toward caps (VAL-SESSION-013).
        yield* publishPart({
          id: PartID.ascending(),
          messageID,
          sessionID,
          type: "text",
          text: markdown,
          synthetic: true,
          time: { start: Date.now(), end: Date.now() },
        })

        // publishPart succeeded — record, credit, and emit. Fire-and-forget: a wallet/event failure
        // is logged but never breaks the session (VAL-SESSION-012).
        yield* Effect.gen(function* () {
          const impression = trackImpression(
            ad,
            slotType,
            sessionID,
            userID ?? "anonymous",
            0,
          )
          yield* adStore.recordImpression(impression)

          if (adServerUrl) {
            yield* reportUpstream(adServerUrl, "/impressions", {
              impression_id: impression.id,
              ad_id: impression.ad_id,
              user_id: userID ?? "anonymous",
              slot_type: slotType,
              created_at: impression.shown_at,
            })
          }

          yield* events.publish(AdImpressionEvent, {
            amount: AD_VIEW_CREDIT_REWARD,
            ad_id: impression.ad_id,
            slot_type: slotType,
            session_id: sessionID,
            impression_id: impression.id,
            slot_min_ms: impression.slot_min_ms,
            headline: ad.headline,
            body: ad.body,
            cta_text: ad.cta_text,
            cta_url: ad.cta_url,
            display_url: ad.display_url,
            advertiser_id: ad.advertiser_id,
            category: ad.category,
          })
        }).pipe(
          Effect.catchDefect((defect) =>
            Effect.logWarning("CodeFree: ad side-effects defect (non-breaking)", defect),
          ),
          Effect.catch((err) =>
            Effect.logWarning("CodeFree: ad side-effects failed (impression/credit/event)", err),
          ),
        )

        // The ad was shown, so it counts toward the per-session interval/cap gating regardless of
        // whether the (fire-and-forget) credit/event side-effects landed.
        lastAdTimes[sessionID] = Date.now()
        incrementAdCount(sessionID)
      }),

      applyUsage: Effect.fn("CodeFree.applyUsage")(function* (sessionID: SessionID, costUSD: number) {
        if (costUSD <= 0) return 0

        const userID = yield* resolveUserID()
        // No resolvable user id (degenerate) => user pays the full cost (VAL-SESSION-039).
        if (!userID) return costUSD

        // Snapshot lifetime_spent before the debit so we can detect whether a nonzero debit
        // actually occurred (VAL-SESSION-020: emit credit.updated only after a debit).
        const before = yield* wallet.getBalance(userID).pipe(
          Effect.catchTag("WalletNotFoundError", () => Effect.succeed(null)),
        )

        // Delegate to the core applyUsage which handles full/partial/no coverage accounting and
        // debits only the covered portion without throwing on partial balance (VAL-SESSION-015/016/
        // 017/042). The core function yields Wallet.Service from context, so provide the wallet
        // instance captured in this layer closure to keep the method's environment `never`.
        const uncovered = yield* applyUsageCredits(userID, costUSD).pipe(Effect.provideService(Wallet.Service, wallet))

        // Emit credit.updated only after a nonzero debit so the TUI reconciles the lowered balance
        // (VAL-SESSION-020). No event when nothing is debited — zero cost and no-balance return
        // early above; this guards the edge case where positive cost rounds to 0 credits needed.
        yield* Effect.gen(function* () {
          if (!before) return
          const after = yield* wallet.getBalance(userID)
          if (after.lifetimeSpentCredits > before.lifetimeSpentCredits) {
            yield* events.publish(CreditUpdatedEvent, {
              balance_credits: after.balanceCredits,
              lifetime_earned: after.lifetimeEarnedCredits,
              lifetime_spent: after.lifetimeSpentCredits,
            })
          }
        }).pipe(
          Effect.catchDefect((defect) =>
            Effect.logWarning("CodeFree: credit.updated emit defect (non-breaking)", defect),
          ),
          Effect.catch((err) => Effect.logWarning("CodeFree: credit.updated emit skipped", err)),
        )

        return uncovered
      }),

      clickAd: Effect.fn("CodeFree.clickAd")(function* (
        sessionID: SessionID,
        impressionID: string,
        clickURL: string,
        adHeadline = "Ad click",
      ) {
        // Resolve the user id first so the click is attributed to the same wallet the view credited.
        const userID = yield* resolveUserID()

        // Persist the click to the AdStore (updates the impression row + inserts a click event row).
        // Fire-and-forget: a wallet/event failure is logged but never breaks the caller (VAL-SESSION-026).
        yield* Effect.gen(function* () {
          const recorded = yield* adStore.recordClick(impressionID, clickURL)
          // Unknown impression id: the click was not recorded, so do not credit or emit.
          if (!recorded) return

          const adServerUrl = yield* readAdServerURL()
          if (adServerUrl) {
            const impression = yield* adStore.getImpression(impressionID)
            if (impression) {
              yield* reportUpstream(adServerUrl, "/clicks", {
                impression_id: impressionID,
                ad_id: impression.ad_id,
                user_id: userID ?? "anonymous",
                click_url: clickURL,
              })
            }
          }

          yield* events.publish(AdClickEvent, {
            amount: AFFILIATE_CLICK_CREDIT_REWARD,
            ad_id: impressionID,
            impression_id: impressionID,
            session_id: sessionID,
          })

          if (userID) {
            const result = yield* creditAdClick(userID, impressionID, adHeadline).pipe(
              Effect.provideService(Wallet.Service, wallet),
            )
            if (!result.credited) return
            const credited = yield* wallet.getBalance(userID)
            yield* events.publish(CreditUpdatedEvent, {
              balance_credits: credited.balanceCredits,
              lifetime_earned: credited.lifetimeEarnedCredits,
              lifetime_spent: credited.lifetimeSpentCredits,
            })
          }
        }).pipe(
          Effect.catchDefect((defect) =>
            Effect.logWarning("CodeFree: click side-effects defect (non-breaking)", defect),
          ),
          Effect.catch((err) =>
            Effect.logWarning("CodeFree: click side-effects failed (persist/credit/event)", err),
          ),
        )
      }),

      completeImpression: Effect.fn("CodeFree.completeImpression")(function* (
        _sessionID: SessionID,
        impressionID: string,
        adHeadline = "Ad view",
      ) {
        const userID = yield* resolveUserID()
        if (!userID) return { credited: false, reason: "unknown" }

        const result = yield* Effect.gen(function* () {
          const completed = yield* completeImpressionCredits(userID, impressionID, adHeadline).pipe(
            Effect.provideService(Wallet.Service, wallet),
            Effect.provideService(AdStore.Service, adStore),
          )
          if (!completed.credited) return completed

          const balance = yield* wallet.getBalance(userID)
          yield* events.publish(CreditUpdatedEvent, {
            balance_credits: balance.balanceCredits,
            lifetime_earned: balance.lifetimeEarnedCredits,
            lifetime_spent: balance.lifetimeSpentCredits,
          })
          return completed
        }).pipe(
          Effect.catchDefect((defect) =>
            Effect.andThen(
              Effect.logWarning("CodeFree: complete impression defect (non-breaking)", defect),
              () => Effect.succeed({ credited: false, reason: "error" }),
            ),
          ),
          Effect.catch((err) =>
            Effect.andThen(
              Effect.logWarning("CodeFree: complete impression failed", err),
              () => Effect.succeed({ credited: false, reason: "error" }),
            ),
          ),
        )

        return {
          credited: result.credited,
          reason: result.reason,
          balance_credits: result.balance_credits,
        }
      }),

      hydrateWallet: Effect.fn("CodeFree.hydrateWallet")(function* (_sessionID: SessionID) {
        // Resolve the user id (remote account or stable local id) and read the persisted wallet
        // balance, then emit a single codefree.credit.updated so the TUI footer reconciles to the
        // persisted balance on restart — not 0 (VAL-TUI-025 / VAL-CROSS-016). getOrCreateWallet
        // auto-provisions a zeroed wallet for a fresh user so hydration always has a balance to
        // report. Both typed errors and defects (e.g. SQLite "no such table" during migration
        // races) are swallowed so the fire-and-forget call never breaks the session.
        yield* Effect.gen(function* () {
          const userID = yield* resolveUserID()
          if (!userID) return
          const info = yield* wallet.getOrCreateWallet(userID)
          yield* events.publish(CreditUpdatedEvent, {
            balance_credits: info.balanceCredits,
            lifetime_earned: info.lifetimeEarnedCredits,
            lifetime_spent: info.lifetimeSpentCredits,
          })
        }).pipe(
          Effect.catchDefect((defect) =>
            Effect.logWarning("CodeFree: wallet hydration defect (non-breaking)", defect),
          ),
          Effect.catch((err) => Effect.logWarning("CodeFree: wallet hydration failed", err)),
        )
      }),
    })
  }),
)

// The CodeFree dependency layer provides every service the codefree feature needs at runtime:
// Wallet (SQLite credit ledger), AdStore (durable impression/click persistence), Config (real
// opencode.json codefree block), Account (user id resolution), Global (stable local user id
// persistence), and EventV2 (ephemeral ad/credit events) via EventV2Bridge. Provided into the
// SessionProcessor layer so `yield* CodeFree.maybeShowAd(...)` / `applyUsage(...)` resolve.
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Wallet.defaultLayer),
    Layer.provide(AdStore.defaultLayer),
    Layer.provide(AdSource.defaultLayer),
    Layer.provide(Account.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Global.defaultLayer),
  ),
)

export const node = LayerNode.make(layer, [
  Account.node,
  // Wallet lives in core and has no LayerNode of its own; it only needs the shared Database node.
  LayerNode.make(Wallet.layer, [Database.node]),
  LayerNode.make(AdStore.layer, [Database.node]),
  LayerNode.make(AdSource.layer, [LayerNodePlatform.httpClient]),
  Config.node,
  EventV2Bridge.node,
  Global.node,
])

// --- Namespace accessors (callable Effects backed by CodeFree.Service) ---
//
// processor.ts calls `yield* CodeFree.maybeShowAd(...)` / `yield* CodeFree.applyUsage(...)`. These
// accessors yield the Service from the context and delegate, so the call-sites resolve to the real
// implementation (not undefined) as long as the SessionProcessor layer provides CodeFree.Service.

export const maybeShowAd = Effect.fn("CodeFree.maybeShowAd")(function* (
  sessionID: SessionID,
  messageID: SessionV1.MessageID,
  slotType: AdSlotType,
  publishPart: (part: SessionV1.TextPart) => Effect.Effect<SessionV1.TextPart>,
) {
  const svc = yield* Service
  yield* svc.maybeShowAd(sessionID, messageID, slotType, publishPart)
})

export const applyUsage = Effect.fn("CodeFree.applyUsage")(function* (sessionID: SessionID, costUSD: number) {
  const svc = yield* Service
  return yield* svc.applyUsage(sessionID, costUSD)
})

export const hydrateWallet = Effect.fn("CodeFree.hydrateWallet")(function* (sessionID: SessionID) {
  const svc = yield* Service
  yield* svc.hydrateWallet(sessionID)
})

export const clickAd = Effect.fn("CodeFree.clickAd")(function* (
  sessionID: SessionID,
  impressionID: string,
  clickURL: string,
  adHeadline?: string,
) {
  const svc = yield* Service
  yield* svc.clickAd(sessionID, impressionID, clickURL, adHeadline)
})

export const completeImpression = Effect.fn("CodeFree.completeImpression")(function* (
  sessionID: SessionID,
  impressionID: string,
  adHeadline?: string,
) {
  const svc = yield* Service
  return yield* svc.completeImpression(sessionID, impressionID, adHeadline)
})

export const resolveUserID = Effect.fn("CodeFree.resolveUserID")(function* () {
  const account = yield* Account.Service
  const global = yield* Global.Service
  const idPath = path.join(global.data, "codefree_local_user_id")
  const file = Bun.file(idPath)
  const exists = yield* Effect.promise(() => file.exists())
  const readLocal = Effect.gen(function* () {
    if (!exists) {
      const id = `cfu_${crypto.randomUUID()}`
      yield* Effect.promise(() => Bun.write(idPath, id))
      return id
    }
    const text = (yield* Effect.promise(() => file.text())).trim()
    if (text) return text
    const id = `cfu_${crypto.randomUUID()}`
    yield* Effect.promise(() => Bun.write(idPath, id))
    return id
  })
  const opt = yield* account.active().pipe(Effect.catch(() => Effect.succeed(Option.none<Account.Info>())))
  if (Option.isSome(opt)) return opt.value.id
  return yield* readLocal
})

export * as CodeFree from "./codefree"
