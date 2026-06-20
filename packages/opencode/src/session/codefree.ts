import { Effect, Context, Layer, Option } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Wallet } from "@opencode-ai/core/wallet"
import { AdConfig } from "@opencode-ai/core/ad/types"
import { shouldShowAd, selectAd, formatAdAsMarkdown, trackImpression } from "@opencode-ai/core/ad/injector"
import { fetchAds, recordImpression } from "@opencode-ai/core/ad/service"
import { AD_VIEW_CREDIT_REWARD } from "@opencode-ai/core/wallet/config"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Account } from "@/account/account"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { PartID, SessionID } from "./schema"

type AdSlotType = "thinking" | "toolgap" | "idle"

// Per-session ad tracking state
const lastAdTimes: Record<string, number> = {}
const adCountsThisHour: Record<string, number> = {}
let hourlyResetTimer: ReturnType<typeof setInterval> | undefined

// Reset hourly counters at the top of each hour
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
// sessionID/messageID are the branded id types the processor already holds (ctx.sessionID and the
// assistant message id), which are exactly the branded fields on SessionV1.TextPart. Typing them as
// branded (not plain string) keeps the synthetic part construction type-safe without runtime
// coercion. applyUsage's error channel is declared honestly: debitWallet can fail with
// WalletNotFoundError | InsufficientBalanceError; the processor wraps the call so a failure never
// breaks the session.

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

    // Account lookup is best-effort: any AccountError (no account configured, DB unavailable) means
    // there is no resolvable user id. Recover to undefined rather than failing the session.
    const resolveUserID = Effect.fnUntraced(function* () {
      const opt = yield* account.active().pipe(
        Effect.catch(() => Effect.succeed(Option.none<Account.Info>())),
      )
      return Option.isSome(opt) ? opt.value.id : undefined
    })

    return Service.of({
      maybeShowAd: Effect.fn("CodeFree.maybeShowAd")(function* (
        sessionID: SessionID,
        messageID: SessionV1.MessageID,
        slotType: AdSlotType,
        publishPart: (part: SessionV1.TextPart) => Effect.Effect<SessionV1.TextPart>,
      ) {
        const adConfig = AdConfig.defaults

        // Ads must be enabled — skip entirely if disabled
        if (!adConfig.enabled) return

        const lastAdTime = getLastAdTime(sessionID)
        const countThisHour = getAdCountThisHour(sessionID)

        if (!shouldShowAd(slotType, lastAdTime, countThisHour, adConfig)) return

        const availableAds = fetchAds(adConfig)
        const ad = selectAd(slotType, adConfig.categories, availableAds, adConfig)
        if (!ad) return

        // Get user ID for impression tracking and wallet credit
        const userID = yield* resolveUserID()

        const markdown = formatAdAsMarkdown(ad)

        // Publish ad as a text part to the session stream
        yield* publishPart({
          id: PartID.ascending(),
          messageID,
          sessionID,
          type: "text",
          text: markdown,
          synthetic: true,
          time: { start: Date.now(), end: Date.now() },
        })

        // Record impression and credit wallet
        const impression = trackImpression(
          ad,
          slotType,
          sessionID,
          userID ?? "anonymous",
          Date.now() - lastAdTime,
        )
        recordImpression(impression)

        if (userID) {
          // Fire-and-forget the credit: a wallet failure is logged but never breaks the session.
          yield* wallet
            .creditWallet(
              userID,
              AD_VIEW_CREDIT_REWARD,
              "ad_view",
              `Ad view credit: ${ad.headline}`,
              impression.id,
            )
            .pipe(
              Effect.catch((err) =>
                Effect.logWarning("CodeFree: failed to credit wallet for ad view", err),
              ),
            )
        }

        lastAdTimes[sessionID] = Date.now()
        incrementAdCount(sessionID)
      }),

      applyUsage: Effect.fn("CodeFree.applyUsage")(function* (sessionID: SessionID, costUSD: number) {
        if (costUSD <= 0) return 0

        const creditsNeeded = Wallet.usdToCredits(costUSD)
        const userID = yield* resolveUserID()

        // If no account, user pays full price
        if (!userID) return costUSD

        // Try to debit — if insufficient balance, InsufficientBalanceError is thrown (the processor
        // wraps this call so a failure never breaks the session).
        yield* wallet.debitWallet(userID, creditsNeeded, `API usage for session ${sessionID}`, sessionID)

        // If debit succeeded, the wallet covered the full amount.
        return 0
      }),
    })
  }),
)

// The CodeFree dependency layer provides every service the codefree feature needs at runtime:
// Wallet (SQLite credit ledger), Config (real opencode.json codefree block), Account (user id
// resolution), and EventV2 (ephemeral ad/credit events) via EventV2Bridge. Provided into the
// SessionProcessor layer so `yield* CodeFree.maybeShowAd(...)` / `applyUsage(...)` resolve.
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Wallet.defaultLayer),
    Layer.provide(Account.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
  ),
)

export const node = LayerNode.make(layer, [
  Account.node,
  // Wallet lives in core and has no LayerNode of its own; it only needs the shared Database node.
  LayerNode.make(Wallet.layer, [Database.node]),
  Config.node,
  EventV2Bridge.node,
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
