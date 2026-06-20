import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Wallet } from "@opencode-ai/core/wallet"
import { AD_VIEW_CREDIT_REWARD, AFFILIATE_CLICK_CREDIT_REWARD, CREDIT_USD_VALUE } from "@opencode-ai/core/wallet/config"
import { testEffect } from "./lib/effect"

// In-memory database provisioned with the wallet tables via the fresh-DB schema snapshot.
const database = Database.layerFromPath(":memory:")
const walletLayer = Wallet.layer.pipe(Layer.provide(database))
const eff = testEffect(walletLayer)

// Runs an effect expected to fail with a typed error and returns that error value. Effect.match's
// onFailure only handles the typed error channel, so a defect (non-typed die) propagates and fails
// the test loudly, which is exactly what we want when asserting a catchable typed failure.
function failureOf<E>(effect: Effect.Effect<unknown, E, never>): Effect.Effect<E, never> {
  return effect.pipe(
    Effect.match({
      onFailure: (e) => e,
      onSuccess: () => {
        throw new Error("Expected the effect to fail, but it succeeded")
      },
    }),
  )
}

describe("Wallet barrel resolution", () => {
  it("exposes Service, conversion helpers, layers, and errors (not undefined)", () => {
    // The barrel must export from ./wallet/index; the self-referencing barrel left these undefined.
    expect(Wallet.Service).toBeDefined()
    expect(Wallet.defaultLayer).toBeDefined()
    expect(Wallet.layer).toBeDefined()
    expect(typeof Wallet.usdToCredits).toBe("function")
    expect(typeof Wallet.creditsToUsd).toBe("function")
    expect(typeof Wallet.formatCredits).toBe("function")
    expect(Wallet.WalletNotFoundError).toBeDefined()
    expect(Wallet.InsufficientBalanceError).toBeDefined()
  })
})

describe("credit constants", () => {
  it("locks standardized credit economics (CREDIT_USD_VALUE / AD_VIEW / AFFILIATE)", () => {
    // Standardized everywhere: 1 credit = $0.01, 4 credits/view, 100 credits/click.
    expect(CREDIT_USD_VALUE).toBe(0.01)
    expect(AD_VIEW_CREDIT_REWARD).toBe(4)
    expect(AFFILIATE_CLICK_CREDIT_REWARD).toBe(100)
  })
})

describe("usdToCredits", () => {
  it("converts USD to credits at $0.01 per credit (VAL-WALLET-015)", () => {
    expect(Wallet.usdToCredits(1)).toBe(100)
    expect(Wallet.usdToCredits(0.04)).toBe(4)
    expect(Wallet.usdToCredits(0.5)).toBe(50)
  })

  it("rounds fractional credits to the nearest integer, round-half-up (VAL-WALLET-016)", () => {
    expect(Wallet.usdToCredits(0.005)).toBe(1)
    expect(Wallet.usdToCredits(0.014)).toBe(1)
    expect(Wallet.usdToCredits(0.015)).toBe(2)
    expect(Wallet.usdToCredits(0.045)).toBe(5)
  })
})

describe("creditsToUsd", () => {
  it("converts credits to USD at $0.01 per credit (VAL-WALLET-017)", () => {
    expect(Wallet.creditsToUsd(100)).toBe(1)
    expect(Wallet.creditsToUsd(4)).toBe(0.04)
  })
})

describe("usd/credit round-trip", () => {
  it("preserves whole-cent USD values through usdToCredits -> creditsToUsd (VAL-WALLET-018)", () => {
    for (const usd of [0.01, 0.02, 0.03, 0.04, 0.5, 1, 2.34, 10]) {
      expect(Wallet.creditsToUsd(Wallet.usdToCredits(usd))).toBe(usd)
    }
  })
})

describe("formatCredits", () => {
  it("renders the credit count with a 2-decimal USD equivalent (VAL-WALLET-019)", () => {
    const rendered = Wallet.formatCredits(100)
    expect(rendered).toContain("100")
    expect(rendered).toContain("$1.00")

    const small = Wallet.formatCredits(4)
    expect(small).toContain("4")
    expect(small).toContain("$0.04")
  })
})

describe("getOrCreateWallet", () => {
  eff.effect("creates a zeroed wallet for a new user with a valid branded id (VAL-WALLET-001)", () =>
    Effect.gen(function* () {
      const service = yield* Wallet.Service
      const wallet = yield* service.getOrCreateWallet("user-create-1")

      expect(wallet.balanceCredits).toBe(0)
      expect(wallet.lifetimeEarnedCredits).toBe(0)
      expect(wallet.lifetimeSpentCredits).toBe(0)
      expect(wallet.userId).toBe("user-create-1")
      expect(typeof wallet.id).toBe("string")
      expect(wallet.id.length).toBeGreaterThan(0)
    }),
  )

  eff.effect("is idempotent for an existing user: same id, no duplicate (VAL-WALLET-002)", () =>
    Effect.gen(function* () {
      const service = yield* Wallet.Service
      const first = yield* service.getOrCreateWallet("user-idem-1")
      const second = yield* service.getOrCreateWallet("user-idem-1")

      expect(second.id).toBe(first.id)
      expect(second.balanceCredits).toBe(0)
      expect(second.lifetimeEarnedCredits).toBe(0)

      // A subsequent credit applies to the single wallet exactly once (no duplicate row).
      const credited = yield* service.creditWallet("user-idem-1", 8, "bonus", "single")
      expect(credited.balanceCredits).toBe(8)
      const history = yield* service.getTransactionHistory("user-idem-1")
      expect(history.length).toBe(1)
    }),
  )
})

describe("creditWallet", () => {
  eff.effect("increases balance by exactly the credited amount (VAL-WALLET-003)", () =>
    Effect.gen(function* () {
      const service = yield* Wallet.Service
      const wallet = yield* service.getOrCreateWallet("user-credit-bal")
      expect(wallet.balanceCredits).toBe(0)

      const after = yield* service.creditWallet("user-credit-bal", 30, "bonus", "thirty")
      expect(after.balanceCredits).toBe(30)

      const more = yield* service.creditWallet("user-credit-bal", 7, "bonus", "seven")
      expect(more.balanceCredits).toBe(37)
    }),
  )

  eff.effect("increases lifetime_earned while leaving lifetime_spent unchanged (VAL-WALLET-004)", () =>
    Effect.gen(function* () {
      const service = yield* Wallet.Service
      yield* service.getOrCreateWallet("user-credit-le")
      const after = yield* service.creditWallet("user-credit-le", 25, "bonus", "twenty-five")

      expect(after.lifetimeEarnedCredits).toBe(25)
      expect(after.lifetimeSpentCredits).toBe(0)
    }),
  )

  eff.effect("records a positive transaction row with the given metadata (VAL-WALLET-005)", () =>
    Effect.gen(function* () {
      const service = yield* Wallet.Service
      yield* service.creditWallet("user-credit-row", 12, "ad_view", "view reward", "imp-123")
      const history = yield* service.getTransactionHistory("user-credit-row")

      expect(history.length).toBe(1)
      const row = history[0]
      expect(row.amountCredits).toBe(12)
      expect(row.type).toBe("ad_view")
      expect(row.description).toBe("view reward")
      expect(row.referenceId).toBe("imp-123")
    }),
  )

  eff.effect("auto-provisions a wallet for an unknown user (VAL-WALLET-006)", () =>
    Effect.gen(function* () {
      const service = yield* Wallet.Service
      const after = yield* service.creditWallet("user-auto-prov", 15, "bonus", "auto")

      expect(after.balanceCredits).toBe(15)
      expect(after.lifetimeEarnedCredits).toBe(15)

      // The wallet now exists and is readable via getBalance.
      const balance = yield* service.getBalance("user-auto-prov")
      expect(balance.balanceCredits).toBe(15)
    }),
  )

  eff.effect("an ad-view credit awards exactly 4 credits (VAL-WALLET-007)", () =>
    Effect.gen(function* () {
      const service = yield* Wallet.Service
      const before = yield* service.getOrCreateWallet("user-adview")
      expect(before.balanceCredits).toBe(0)

      const after = yield* service.creditWallet("user-adview", AD_VIEW_CREDIT_REWARD, "ad_view", "ad view")
      expect(after.balanceCredits).toBe(4)
    }),
  )
})

describe("debitWallet", () => {
  eff.effect("decreases balance by exactly the debited amount on the success path (VAL-WALLET-008)", () =>
    Effect.gen(function* () {
      const service = yield* Wallet.Service
      yield* service.creditWallet("user-debit-bal", 50, "bonus", "seed")
      const after = yield* service.debitWallet("user-debit-bal", 20, "usage")
      expect(after.balanceCredits).toBe(30)
    }),
  )

  eff.effect("increases lifetime_spent while leaving lifetime_earned unchanged (VAL-WALLET-009)", () =>
    Effect.gen(function* () {
      const service = yield* Wallet.Service
      yield* service.creditWallet("user-debit-ls", 50, "bonus", "seed")
      const after = yield* service.debitWallet("user-debit-ls", 20, "usage")

      expect(after.lifetimeSpentCredits).toBe(20)
      expect(after.lifetimeEarnedCredits).toBe(50)
    }),
  )

  eff.effect("records a negative transaction row with the given description (VAL-WALLET-010)", () =>
    Effect.gen(function* () {
      const service = yield* Wallet.Service
      yield* service.creditWallet("user-debit-row", 50, "bonus", "seed")
      yield* service.debitWallet("user-debit-row", 18, "step cost")
      const history = yield* service.getTransactionHistory("user-debit-row")

      const debitRow = history.find((r) => r.amountCredits < 0)
      expect(debitRow).toBeDefined()
      expect(debitRow!.amountCredits).toBe(-18)
      expect(debitRow!.description).toBe("step cost")
    }),
  )

  eff.effect(
    "fails with InsufficientBalanceError when underfunded and leaves balance/transactions unchanged (VAL-WALLET-011)",
    () =>
      Effect.gen(function* () {
        const service = yield* Wallet.Service
        yield* service.creditWallet("user-debit-insuf", 5, "bonus", "seed")

        const before = yield* service.getBalance("user-debit-insuf")
        expect(before.balanceCredits).toBe(5)

        const error = yield* failureOf(service.debitWallet("user-debit-insuf", 10, "too much"))
        expect(error).toBeInstanceOf(Wallet.InsufficientBalanceError)

        // Balance unchanged and no extra transaction row written.
        const after = yield* service.getBalance("user-debit-insuf")
        expect(after.balanceCredits).toBe(5)
        const history = yield* service.getTransactionHistory("user-debit-insuf")
        expect(history.length).toBe(1)
      }),
  )

  eff.effect("fails with WalletNotFoundError for an unknown user (VAL-WALLET-012)", () =>
    Effect.gen(function* () {
      const service = yield* Wallet.Service
      const error = yield* failureOf(service.debitWallet("user-debit-missing", 1, "x"))
      expect(error).toBeInstanceOf(Wallet.WalletNotFoundError)
    }),
  )
})

describe("getBalance", () => {
  eff.effect("returns the current wallet info matching persisted state (VAL-WALLET-013)", () =>
    Effect.gen(function* () {
      const service = yield* Wallet.Service
      yield* service.creditWallet("user-balance", 40, "bonus", "seed")
      yield* service.debitWallet("user-balance", 15, "usage")
      const info = yield* service.getBalance("user-balance")

      expect(info.balanceCredits).toBe(25)
      expect(info.lifetimeEarnedCredits).toBe(40)
      expect(info.lifetimeSpentCredits).toBe(15)
    }),
  )

  eff.effect("fails with WalletNotFoundError for an unknown user (VAL-WALLET-014)", () =>
    Effect.gen(function* () {
      const service = yield* Wallet.Service
      const error = yield* failureOf(service.getBalance("user-balance-missing"))
      expect(error).toBeInstanceOf(Wallet.WalletNotFoundError)
    }),
  )
})

describe("service Interface error channels (VAL-WALLET-020)", () => {
  it("declares typed error channels (not never) — validated by the package typecheck", () => {
    // The authoritative type-level proof is `bunx tsc --noEmit` for packages/core: if any
    // Service method's error channel were `never` while the implementation infers a tagged
    // error, the Service.of({...}) assignment fails to compile (Effect error channels are
    // covariant). The runtime cases below confirm the correct tagged error classes.
    expect(Wallet.WalletNotFoundError).toBeDefined()
    expect(Wallet.InsufficientBalanceError).toBeDefined()
  })

  eff.effect("debitWallet underfunded yields a catchable InsufficientBalanceError (not a defect)", () =>
    Effect.gen(function* () {
      const service = yield* Wallet.Service
      yield* service.creditWallet("user-errchan", 1, "bonus", "seed")

      // A defect would NOT be caught by Effect.catchTag; only a typed failure is.
      const caught = yield* service.debitWallet("user-errchan", 5, "over").pipe(
        Effect.catchTag("InsufficientBalanceError", (e) => Effect.succeed(`caught:${e._tag}`)),
      )
      expect(caught).toBe("caught:InsufficientBalanceError")
    }),
  )

  eff.effect("debitWallet unknown user and getBalance unknown user yield WalletNotFoundError", () =>
    Effect.gen(function* () {
      const service = yield* Wallet.Service
      const debitErr = yield* failureOf(service.debitWallet("user-errchan-missing", 1, "x"))
      expect(debitErr).toBeInstanceOf(Wallet.WalletNotFoundError)

      const balanceErr = yield* failureOf(service.getBalance("user-errchan-missing"))
      expect(balanceErr).toBeInstanceOf(Wallet.WalletNotFoundError)
    }),
  )
})
