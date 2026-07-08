import { Database } from "bun:sqlite"

export function openDatabase(path: string) {
  const db = new Database(path)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      user_id TEXT PRIMARY KEY,
      api_key TEXT UNIQUE NOT NULL,
      balance_usd REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deposits (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      usd REAL NOT NULL,
      reference TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
  `)
  return db
}

export type GatewayDatabase = ReturnType<typeof openDatabase>
