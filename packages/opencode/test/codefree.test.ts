import { describe, expect, it } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Wallet } from "@opencode-ai/core/wallet"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionV2 } from "@opencode-ai/core/session"
import { Config } from "@/config/config"
import { Account } from "@/account/account"
import { CodeFree } from "@/session/codefree"
import { testEffect } from "./lib/effect"

// A stable test user id resolved via the fake Account service (active remote account path).
const TEST_USER_ID = "acct_codefree_test"

// --- Test layer: CodeFree.layer wired with real Wallet + EventV2 (which only need a Database)
// --- and fake Account + Config services. Only an in-memory Database is supplied externally,
// --- proving the CodeFree layer provides the Wallet/Config/Account/EventV2 deps (VAL-SESSION-037).
const database = Database.layerFromPath(":memory:")

const fakeAccount = Layer.mock(Account.Service)({
  active: () =>
    Effect.succeed(
      Option.some(
        new Account.Info({
          id: Account.AccountID.make(TEST_USER_ID),
          email: "codefree@test.local",
          url: "https://codefree.test",
          active_org_id: null,
        }),
      ),
    ),
})

// Config is not yet consumed by the Phase 0 service body, but the layer must still PROVIDE it so
// downstream/future codefree features can read the real config. Yielding the tag succeeds without
// invoking any method.
const fakeConfig = Layer.mock(Config.Service)({})

// Shared dependency layer (Database-provided). Built once, then both fed to CodeFree.layer (so the
// service resolves Wallet/Account/Config/EventV2) AND merged into the test environment so the tests
// can assert against the very same Wallet/Account instances (Effect memoizes the shared layer).
const sharedDeps = Layer.mergeAll(Wallet.layer, EventV2.layer, fakeAccount, fakeConfig).pipe(Layer.provide(database))

const codefreeLayer = Layer.mergeAll(CodeFree.layer.pipe(Layer.provide(sharedDeps)), sharedDeps)

const eff = testEffect(codefreeLayer)

// --- VAL-SESSION-043: the namespace barrel resolves to the real service file ---

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

// --- VAL-SESSION-036: namespace accessors resolve to the real Service (not undefined) ---

describe("CodeFree namespace accessors delegate to the Service (VAL-SESSION-036)", () => {
  eff.effect("maybeShowAd accessor publishes one synthetic markdown text part via the Service", () =>
    Effect.gen(function* () {
      const published: SessionV1.TextPart[] = []
      const sessionID = SessionV2.ID.make(`sess_accessor_publish_${Date.now()}`)
      const messageID = SessionV1.MessageID.make("msg_accessor_publish")

      yield* CodeFree.maybeShowAd(sessionID, messageID, "toolgap", (part) =>
        Effect.sync(() => {
          published.push(part)
          return part
        }),
      )

      // The accessor resolved to the Service and executed — not a TypeError on undefined.
      expect(published.length).toBe(1)
      const part = published[0]
      expect(part.type).toBe("text")
      expect(part.synthetic).toBe(true)
      expect(part.text.length).toBeGreaterThan(0)
      expect(part.sessionID).toBe(sessionID)
      expect(part.messageID).toBe(messageID)
    }),
  )

  eff.effect("maybeShowAd accessor credits the wallet +4 via the Service", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const sessionID = SessionV2.ID.make(`sess_accessor_credit_${Date.now()}`)

      yield* CodeFree.maybeShowAd(sessionID, SessionV1.MessageID.make("msg_accessor_credit"), "toolgap", (part) => Effect.succeed(part))

      const balance = yield* wallet.getBalance(TEST_USER_ID)
      expect(balance.balanceCredits).toBe(4)
      expect(balance.lifetimeEarnedCredits).toBe(4)
    }),
  )

  eff.effect("applyUsage accessor debits the wallet and returns 0 on full coverage via the Service", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const sessionID = SessionV2.ID.make(`sess_accessor_usage_${Date.now()}`)

      // Seed 50 credits ($0.50); cost $0.20 = 20 credits is fully covered.
      yield* wallet.creditWallet(TEST_USER_ID, 50, "bonus", "seed for usage")

      const uncovered = yield* CodeFree.applyUsage(sessionID, 0.2)

      // Accessor delegated to the Service which debited the covered credits.
      expect(uncovered).toBe(0)
      const balance = yield* wallet.getBalance(TEST_USER_ID)
      expect(balance.balanceCredits).toBe(30)
      expect(balance.lifetimeSpentCredits).toBe(20)
    }),
  )
})

// --- VAL-SESSION-037: CodeFree layer provides Wallet/Config/Account/EventV2 deps
// --- and maybeShowAd/applyUsage run with only an in-memory Database supplied externally ---

describe("CodeFree layer provides all deps with external Database (VAL-SESSION-037)", () => {
  eff.effect("Wallet/Config/Account/EventV2 + CodeFree.Service all resolve from the layer", () =>
    Effect.gen(function* () {
      const codefree = yield* CodeFree.Service
      const wallet = yield* Wallet.Service
      const account = yield* Account.Service
      const config = yield* Config.Service
      const events = yield* EventV2.Service

      expect(codefree).toBeDefined()
      expect(wallet).toBeDefined()
      expect(account).toBeDefined()
      expect(config).toBeDefined()
      expect(events).toBeDefined()

      // The active account resolves through the provided Account dep.
      const active = yield* account.active()
      expect(Option.isSome(active)).toBe(true)
    }),
  )

  eff.effect("maybeShowAd runs end-to-end with only in-memory Database supplied externally", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const sessionID = SessionV2.ID.make(`sess_deps_maybe_${Date.now()}`)

      yield* CodeFree.maybeShowAd(sessionID, SessionV1.MessageID.make("msg_deps_maybe"), "toolgap", (part) => Effect.succeed(part))

      // Wallet dep worked: balance credited +4 through the provided Wallet.Service.
      const balance = yield* wallet.getBalance(TEST_USER_ID)
      expect(balance.balanceCredits).toBe(4)
    }),
  )

  eff.effect("applyUsage runs end-to-end with only in-memory Database supplied externally", () =>
    Effect.gen(function* () {
      const wallet = yield* Wallet.Service
      const sessionID = SessionV2.ID.make(`sess_deps_usage_${Date.now()}`)

      yield* wallet.creditWallet(TEST_USER_ID, 50, "bonus", "seed")
      const uncovered = yield* CodeFree.applyUsage(sessionID, 0.25)

      // usdToCredits(0.25) = 25 credits; balance 50 fully covers it.
      expect(uncovered).toBe(0)
      const balance = yield* wallet.getBalance(TEST_USER_ID)
      expect(balance.balanceCredits).toBe(25)
    }),
  )
})
