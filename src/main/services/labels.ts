import type { DB } from '../db'
import { DEFAULT_LABELS, FIELD_KEYS, type FieldKey, type Labels, type Result } from '@shared/types'

export function getLabels(db: DB): Labels {
  const out = { ...DEFAULT_LABELS }
  for (const r of db.prepare('SELECT key, label FROM field_labels').all() as { key: FieldKey; label: string }[]) out[r.key] = r.label
  return out
}
export function setLabel(db: DB, key: FieldKey, raw: string): Result {
  const label = String(raw).trim()
  if (!(FIELD_KEYS as readonly string[]).includes(key)) return { ok: false, error: 'Unknown field' }
  if (!label || label.length > 40) return { ok: false, error: 'Name must be 1 to 40 characters' }
  const clash = Object.entries(getLabels(db)).some(([k, l]) => k !== key && l.toLowerCase() === label.toLowerCase())
  if (clash) return { ok: false, error: 'Another field already has this name' }
  db.prepare('INSERT INTO field_labels(key,label) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET label=excluded.label').run(key, label)
  return { ok: true }
}
