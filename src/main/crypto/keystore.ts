import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'

/**
 * Two-key scheme: a random 32-byte DATA KEY encrypts the database.
 * The data key is stored wrapped twice (by password-KEK and by recovery-KEK) in keystore.json.
 * keystore.json holds no plaintext secrets, so it can sit beside the DB and travel with backups.
 */
interface Wrapped { salt: string; iv: string; tag: string; ct: string }
interface KeystoreFile { version: 1; password: Wrapped; recovery: Wrapped }

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

const kdf = (secret: string, salt: Buffer) => scryptSync(secret, salt, 32, SCRYPT)

function wrap(secret: string, dataKey: Buffer): Wrapped {
  const salt = randomBytes(16), iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', kdf(secret, salt), iv)
  const ct = Buffer.concat([c.update(dataKey), c.final()])
  return { salt: salt.toString('hex'), iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), ct: ct.toString('hex') }
}

function unwrap(secret: string, w: Wrapped): Buffer | null {
  try {
    const d = createDecipheriv('aes-256-gcm', kdf(secret, Buffer.from(w.salt, 'hex')), Buffer.from(w.iv, 'hex'))
    d.setAuthTag(Buffer.from(w.tag, 'hex'))
    return Buffer.concat([d.update(Buffer.from(w.ct, 'hex')), d.final()])
  } catch {
    return null // wrong secret -> GCM auth failure
  }
}

export function generateRecoveryKey(): string {
  const bytes = randomBytes(20) // 160 bits
  let bits = '', out = ''
  for (const b of bytes) bits += b.toString(2).padStart(8, '0')
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]
  return out.match(/.{4}/g)!.join('-') // XXXX-XXXX-...
}
export const normalizeRecoveryKey = (k: string) => k.replace(/[\s-]/g, '').toUpperCase()

export class Keystore {
  constructor(private path: string) {}
  exists = () => existsSync(this.path)
  private read(): KeystoreFile { return JSON.parse(readFileSync(this.path, 'utf8')) }
  private write(f: KeystoreFile) { writeFileSync(this.path, JSON.stringify(f, null, 2)) }

  /** First setup. Returns the data key plus the recovery key to show the user once. */
  create(password: string): { dataKey: Buffer; recoveryKey: string } {
    const dataKey = randomBytes(32)
    const recoveryKey = generateRecoveryKey()
    this.write({ version: 1, password: wrap(password, dataKey), recovery: wrap(normalizeRecoveryKey(recoveryKey), dataKey) })
    return { dataKey, recoveryKey }
  }
  unlockWithPassword = (password: string) => unwrap(password, this.read().password)
  unlockWithRecoveryKey = (key: string) => unwrap(normalizeRecoveryKey(key), this.read().recovery)

  /** Forgot password: recovery key opens data, new password re-wraps it. Data untouched. */
  resetPassword(recoveryKey: string, newPassword: string): Buffer | null {
    const dataKey = this.unlockWithRecoveryKey(recoveryKey)
    if (!dataKey) return null
    const f = this.read()
    f.password = wrap(newPassword, dataKey)
    this.write(f)
    return dataKey
  }
  /** Settings > Generate new recovery key (caller must have verified the password). Old key stops working. */
  rotateRecoveryKey(dataKey: Buffer): string {
    const f = this.read()
    const recoveryKey = generateRecoveryKey()
    f.recovery = wrap(normalizeRecoveryKey(recoveryKey), dataKey)
    this.write(f)
    return recoveryKey
  }
}

