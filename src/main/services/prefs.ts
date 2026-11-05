import type { DB } from '../db'
import { PREF_KEYS, type Result } from '@shared/types'

const ok = (k: string) => (PREF_KEYS as readonly string[]).includes(k)

export function getPref(db: DB, key: string): string | null {
  if (!ok(key)) return null
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(`pref:${key}`) as { value: string } | undefined
  return r?.value ?? null
}
export function setPref(db: DB, key: string, value: string): Result {
  if (!ok(key)) return { ok: false, error: 'Unknown preference' }
  if (value.length > 4000) return { ok: false, error: 'Value too long' }
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`pref:${key}`, value)
  return { ok: true }
}
