import path from "path"
import { Effect, Context, Layer, Option, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Wallet } from "@opencode-ai/core/wallet"
import { shouldShowAd, selectAd, formatAdAsMarkdown, trackImpression } from "@opencode-ai/core/ad/injector"
import { fetchAds, recordImpression } from "@opencode-ai/core/ad/service"
import { AD_VIEW_CREDIT_REWARD } from "@opencode-ai/core/wallet/config"
import { ConfigCodefree } from "@opencode-ai/core/config/codefree"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { applyUsage as applyUsageCredits } from "@opencode-ai/core/codefree"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
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
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service
    const global = yield* Global.Service

    // Read the REAL codefree config (from opencode.json via Config.Service) merged over the engine
    // defaults — never the hardcoded AdConfig.defaults, so toggling the config actually drives
    // behavior (VAL-SESSION-008/041).
    const readAdConfig = Effect.fnUntraced(function* () {
      const info = yield* config.get()
      return ConfigCodefree.toAdConfig(info.codefree)
    })

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

    // Publish the credit.updated event reflecting the wallet's current state. Best-effort: a
    // failure is logged, never propagated (fire-and-forget).
    const emitCreditUpdated = (userID: string) =>
      Effect.gen(function* () {
        const balance = yield* wallet.getBalance(userID).pipe(
          Effect.catchTag("WalletNotFoundError", () => Effect.succeed(null)),
        )
        if (!balance) return
        yield* events.publish(CreditUpdatedEvent, {
          balance_credits: balance.balanceCredits,
          lifetime_earned: balance.lifetimeEarnedCredits,
          lifetime_spent: balance.lifetimeSpentCredits,
        })
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

        const availableAds = fetchAds(adConfig)
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
            Date.now() - lastAdTime,
          )
          recordImpression(impression)

          // The ad was shown: emit the impression event (amount is the standardized view reward).
          yield* events.publish(AdImpressionEvent, {
            amount: AD_VIEW_CREDIT_REWARD,
            ad_id: impression.ad_id,
            slot_type: slotType,
            session_id: sessionID,
          })

          // Credit the resolved user's wallet (remote account or stable local id) and emit the
          // credit.updated event reflecting the new balance.
          if (userID) {
            const credited = yield* wallet.creditWallet(
              userID,
              AD_VIEW_CREDIT_REWARD,
              "ad_view",
              `Ad view credit: ${ad.headline}`,
              impression.id,
            )
            yield* events.publish(CreditUpdatedEvent, {
              balance_credits: credited.balanceCredits,
              lifetime_earned: credited.lifetimeEarnedCredits,
              lifetime_spent: credited.lifetimeSpentCredits,
            })
          }
        }).pipe(
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

        // Delegate to the core applyUsage which handles full/partial/no coverage accounting and
        // debits only the covered portion without throwing on partial balance (VAL-SESSION-024).
        // The core function yields Wallet.Service from context, so provide the wallet instance
        // captured in this layer closure to keep the method's environment `never`.
        const uncovered = yield* applyUsageCredits(userID, costUSD).pipe(Effect.provideService(Wallet.Service, wallet))

        // Emit credit.updated after a debit so the TUI reconciles the lowered balance. Best-effort.
        yield* emitCreditUpdated(userID).pipe(
          Effect.catch((err) => Effect.logWarning("CodeFree: credit.updated emit skipped", err)),
        )

        return uncovered
      }),
    })
  }),
)

// The CodeFree dependency layer provides every service the codefree feature needs at runtime:
// Wallet (SQLite credit ledger), Config (real opencode.json codefree block), Account (user id
// resolution), Global (stable local user id persistence), and EventV2 (ephemeral ad/credit events)
// via EventV2Bridge. Provided into the SessionProcessor layer so `yield* CodeFree.maybeShowAd(...)`
// / `applyUsage(...)` resolve.
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Wallet.defaultLayer),
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

export * as CodeFree from "./codefree"
