import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

export const WalletTable = sqliteTable(
  "wallet",
  {
    id: text().primaryKey(),
    user_id: text().notNull(),
    balance_credits: integer().notNull().default(0),
    lifetime_earned_credits: integer().notNull().default(0),
    lifetime_spent_credits: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [
    index("wallet_user_id_idx").on(table.user_id),
  ],
)

export const TransactionTypeValues = [
  "ad_view",
  "affiliate_click",
  "api_usage",
  "bonus",
  "adjustment",
  "withdrawal",
  "withdrawal_refund",
] as const
export type TransactionType = typeof TransactionTypeValues[number]

export const WalletTransactionTable = sqliteTable(
  "wallet_transaction",
  {
    id: text().primaryKey(),
    wallet_id: text()
      .notNull()
      .references(() => WalletTable.id, { onDelete: "cascade" }),
    type: text().notNull(),
    amount_credits: integer().notNull(),
    description: text().notNull(),
    reference_id: text(),
    ...Timestamps,
  },
  (table) => [
    index("wallet_transaction_wallet_id_idx").on(table.wallet_id),
    index("wallet_transaction_type_idx").on(table.type),
    index("wallet_transaction_time_created_idx").on(table.time_created),
  ],
)

// --- Phase 2: withdrawal / payout tables ---
//
// withdrawal_requests is the durable audit trail of every cash-out attempt. status drives a state
// machine: pending -> processing -> completed | failed | cancelled. amount_credits is the source of
// truth; amount_usd is a denormalized display value derived at request time so historical amounts
// stay correct even if CREDIT_USD_VALUE changes later.
export const WithdrawalStatusValues = ["pending", "processing", "completed", "failed", "cancelled"] as const
export type WithdrawalStatus = typeof WithdrawalStatusValues[number]

export const WithdrawalRequestTable = sqliteTable(
  "withdrawal_request",
  {
    id: text().primaryKey(),
    wallet_id: text()
      .notNull()
      .references(() => WalletTable.id, { onDelete: "cascade" }),
    user_id: text().notNull(),
    amount_credits: integer().notNull(),
    amount_usd: real().notNull(),
    status: text().notNull(),
    payout_method: text().notNull(),
    payout_reference: text(),
    failure_reason: text(),
    requested_at: integer().notNull(),
    processed_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("withdrawal_request_wallet_id_idx").on(table.wallet_id),
    index("withdrawal_request_user_id_idx").on(table.user_id),
    index("withdrawal_request_status_idx").on(table.status),
  ],
)

// payout_accounts holds the user's linked payout destination per provider. For the Phase 2 mock
// provider, provider_account_id is null and details holds free-form metadata. A real provider
// (Stripe Connect, PayPal) stores its external account id in provider_account_id.
export const PayoutAccountTable = sqliteTable(
  "payout_account",
  {
    id: text().primaryKey(),
    user_id: text().notNull(),
    provider: text().notNull(),
    provider_account_id: text(),
    status: text().notNull(),
    details: text(),
    ...Timestamps,
  },
  (table) => [
    index("payout_account_user_id_idx").on(table.user_id),
    index("payout_account_provider_idx").on(table.provider),
  ],
)
