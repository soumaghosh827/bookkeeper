import Database from 'better-sqlite3-multiple-ciphers'
import { migrations } from './migrations'
import { DEFAULT_LABELS } from '@shared/types'

export type DB = Database.Database

export function openEncrypted(file: string, dataKey: Buffer): DB {
  const db = new Database(file)
  db.pragma(`cipher='sqlcipher'`)
  db.pragma('legacy=4') // SQLCipher 4 compatible
  db.pragma(`key="x'${dataKey.toString('hex')}'"`) // raw 256-bit key, no extra KDF needed
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get() // throws if key is wrong
  } catch (e) {
    db.close()
    throw new Error('Unable to open database')
  }
  migrate(db)
  return db
}

function migrate(db: DB) {
  const current = db.pragma('user_version', { simple: true }) as number
  for (const m of migrations.filter((m) => m.version > current)) {
    db.transaction(() => {
      db.exec(m.sql)
      db.pragma(`user_version = ${m.version}`)
    })()
  }
  const seed = db.prepare('INSERT OR IGNORE INTO field_labels(key, label) VALUES (?, ?)')
  for (const [k, v] of Object.entries(DEFAULT_LABELS)) seed.run(k, v)
}

