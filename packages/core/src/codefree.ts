import { Effect } from "effect"
import { Wallet } from "./wallet"

/**
 * Applies a usage cost against the user's wallet, debiting the covered portion and
 * returning the uncovered USD remainder (always >= 0).
 *
 * Coverage accounting:
 * - Full coverage (balance >= creditsNeeded): debits creditsNeeded, returns 0.
 * - No balance: debits nothing, returns the full costUSD.
 * - Partial: debits min(creditsNeeded, available), returns creditsToUsd(creditsNeeded - debited).
 * - Zero/negative cost: returns 0 with no debit.
 *
 * Cost is converted to credits via usdToCredits (round-half-up at the $0.01 boundary), so
 * coverage decisions stay consistent with credit accounting everywhere.
 */
export const applyUsage = Effect.fn("CodeFree.applyUsage")(function* (userId: string, costUSD: number) {
  if (costUSD <= 0) return 0

  const creditsNeeded = Wallet.usdToCredits(costUSD)
  const svc = yield* Wallet.Service

  // Read the current balance; a missing wallet is treated as zero balance (full cost uncovered).
  const wallet = yield* svc.getBalance(userId).pipe(
    Effect.catchTag("WalletNotFoundError", () => Effect.succeed(null)),
  )
  const availableCredits = wallet?.balanceCredits ?? 0

  // Debit only the covered portion, never more than what is available or needed.
  const creditsDebited = Math.min(creditsNeeded, availableCredits)
  if (creditsDebited > 0) {
    yield* svc.debitWallet(userId, creditsDebited, `API usage coverage`, userId)
  }

  const uncoveredCredits = Math.max(0, creditsNeeded - creditsDebited)
  return Wallet.creditsToUsd(uncoveredCredits)
})
