import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
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

export const TransactionTypeValues = ["ad_view", "affiliate_click", "api_usage", "bonus", "adjustment"] as const
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
