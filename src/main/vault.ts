import { app } from 'electron'
import { join } from 'path'
import { copyFileSync } from 'fs'
import { Keystore } from './crypto/keystore'
import { openEncrypted, type DB } from './db'
import type { AppState } from '@shared/types'

/** Holds the unlocked DB + data key in main-process memory only. */
class Vault {
  private dir = app.getPath('userData') // %APPDATA%\BookKeeper on Windows
  readonly dbPath = join(this.dir, 'bookkeeper.db')
  readonly keystorePath = join(this.dir, 'keystore.json')
  private keystore = new Keystore(this.keystorePath)
  private db: DB | null = null
  private dataKey: Buffer | null = null

  state(): AppState {
    if (this.db) return 'unlocked'
    return this.keystore.exists() ? 'locked' : 'no-vault'
  }
  get handle(): DB {
    if (!this.db) throw new Error('Vault is locked')
    return this.db
  }
  create(password: string) {
    const { dataKey, recoveryKey } = this.keystore.create(password)
    this.open(dataKey)
    return recoveryKey
  }
  unlock(password: string): boolean {
    const key = this.keystore.unlockWithPassword(password)
    if (!key) return false
    this.open(key)
    return true
  }
  unlockWithRecoveryKey(recoveryKey: string, newPassword: string): boolean {
    const key = this.keystore.resetPassword(recoveryKey, newPassword)
    if (!key) return false
    this.open(key)
    return true
  }
  lock() {
    this.db?.close()
    this.db = null
    this.dataKey?.fill(0)
    this.dataKey = null
  }
  /** Backup = encrypted DB + keystore (same two-key setup, so recovery key still works). */
  backupTo(destDir: string): string {
    const db = this.handle
    db.pragma('wal_checkpoint(TRUNCATE)')
    const stamp = new Date().toISOString().slice(0, 10)
    const dbOut = join(destDir, `bookkeeper-backup-${stamp}.db`)
    copyFileSync(this.dbPath, dbOut)
    copyFileSync(this.keystorePath, join(destDir, `bookkeeper-backup-${stamp}.keystore.json`))
    return dbOut
  }
  private open(key: Buffer) {
    this.dataKey = key
    this.db = openEncrypted(this.dbPath, key)
  }
}
export const vault = new Vault()

