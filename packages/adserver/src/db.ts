import { Database } from "bun:sqlite"

export function openDatabase(path = process.env.CODEFREE_ADSERVER_DB ?? "adserver.db") {
  const db = new Database(path)
  db.exec("PRAGMA journal_mode = WAL")
  initSchema(db)
  return db
}

function initSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ads (
      id TEXT PRIMARY KEY,
      advertiser_id TEXT NOT NULL,
      category TEXT NOT NULL,
      headline TEXT NOT NULL,
      body TEXT NOT NULL,
      cta_text TEXT NOT NULL,
      cta_url TEXT NOT NULL,
      display_url TEXT NOT NULL,
      frequency_cap INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      format TEXT,
      image_url TEXT
    );

    CREATE TABLE IF NOT EXISTS impressions (
      id TEXT PRIMARY KEY,
      ad_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      slot_type TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clicks (
      id TEXT PRIMARY KEY,
      impression_id TEXT NOT NULL,
      ad_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      click_url TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)
}

export type AdRow = {
  id: string
  advertiser_id: string
  category: string
  headline: string
  body: string
  cta_text: string
  cta_url: string
  display_url: string
  frequency_cap: number
  active: number
  format: string | null
  image_url: string | null
}
