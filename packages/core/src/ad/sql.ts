import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

// Table definitions mirror the 20260620120000_wallet_ad_tables migration verbatim.
// Unlike the wallet tables these use domain-specific time columns (shown_at / clicked_at)
// instead of the generic Timestamps helper, so no time_created/time_updated columns exist.

export const AdImpressionTable = sqliteTable(
  "ad_impression",
  {
    id: text().primaryKey(),
    ad_id: text().notNull(),
    slot_type: text().notNull(),
    session_id: text().notNull(),
    user_id: text().notNull(),
    shown_at: integer().notNull(),
    duration_ms: integer().notNull(),
    clicked: integer().notNull().default(0),
    click_url: text(),
    credited: integer().notNull().default(0),
    slot_min_ms: integer().notNull().default(8000),
  },
  (table) => [
    index("ad_impression_session_id_idx").on(table.session_id),
    index("ad_impression_user_id_idx").on(table.user_id),
    index("ad_impression_shown_at_idx").on(table.shown_at),
  ],
)

export const AdClickEventTable = sqliteTable(
  "ad_click_event",
  {
    id: text().primaryKey(),
    impression_id: text().notNull(),
    ad_id: text().notNull(),
    session_id: text().notNull(),
    user_id: text().notNull(),
    click_url: text().notNull(),
    clicked_at: integer().notNull(),
  },
  (table) => [
    index("ad_click_event_session_id_idx").on(table.session_id),
    index("ad_click_event_user_id_idx").on(table.user_id),
    index("ad_click_event_clicked_at_idx").on(table.clicked_at),
  ],
)

export const CodefreePreferenceTable = sqliteTable("codefree_preference", {
  user_id: text().primaryKey(),
  enabled: integer().notNull().default(0),
  categories: text().notNull().default("[]"),
  ...Timestamps,
})
