import { app } from "electron";
import { join } from "path";
import { copyFileSync, rmSync } from "fs";
import { Keystore } from "./crypto/keystore";
import { openEncrypted, type DB } from "./db";
import { units, type Unit } from "./units";
import { copyTemplates } from "./services/templates";
import type { AppState } from "@shared/types";

/** Holds the unlocked DB + data key in main-process memory only. */
class Vault {
  private dir = app.getPath("userData"); // %APPDATA%\BookKeeper on Windows
  readonly keystorePath = join(this.dir, "keystore.json");
  private keystore = new Keystore(this.keystorePath);
  private db: DB | null = null;
  private dataKey: Buffer | null = null;
  private unit: Unit | null = null;

  state(): AppState {
    if (this.db) return "unlocked";
    return this.keystore.exists() ? "locked" : "no-vault";
  }
  get handle(): DB {
    if (!this.db) throw new Error("Vault is locked");
    return this.db;
  }
  /** First setup: creates the keys and the first unit, then opens it. Returns the recovery key. */
  create(password: string, unitName: string) {
    if (this.keystore.exists()) throw new Error("Already set up");
    units.cleanName(unitName); // validate before anything is written
    const { dataKey, recoveryKey } = this.keystore.create(password);
    this.open(dataKey, units.add(unitName));
    return recoveryKey;
  }
  /** Opens only the chosen unit's file. All units share one password. */
  unlock(unitId: string, password: string): boolean {
    const unit = this.unitOrThrow(unitId);
    const key = this.keystore.unlockWithPassword(password);
    if (!key) return false;
    this.open(key, unit);
    return true;
  }
  /** Re-check the master password while already unlocked (for sensitive actions). Opens nothing. */
  verifyPassword(password: string): boolean {
    if (!this.db) return false;
    const key = this.keystore.unlockWithPassword(String(password));
    if (!key) return false;
    key.fill(0);
    return true;
  }
  unlockWithRecoveryKey(
    unitId: string,
    recoveryKey: string,
    newPassword: string,
  ): boolean {
    const unit = this.unitOrThrow(unitId);
    const key = this.keystore.resetPassword(recoveryKey, newPassword);
    if (!key) return false;
    this.open(key, unit);
    return true;
  }
  lock() {
    this.db?.close();
    this.db = null;
    this.unit = null;
    this.dataKey?.fill(0);
    this.dataKey = null;
  }
  /** Backup = encrypted DB + keystore (same two-key setup, so recovery key still works). */
  backupTo(destDir: string): string {
    const db = this.handle;
    db.pragma("wal_checkpoint(TRUNCATE)");
    const stamp = new Date().toISOString().slice(0, 10);
    // Fresh name (it may have been renamed since opening), made safe for a file name.
    const cur = units.get(this.currentUnit.id) ?? this.currentUnit;
    const slug =
      cur.name
        .replace(/[^\p{L}\p{N}_-]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "unit";
    const base = `bookkeeper-${slug}-backup-${stamp}`;
    const dbOut = join(destDir, `${base}.db`);
    copyFileSync(units.filePath(cur), dbOut);
    copyFileSync(this.keystorePath, join(destDir, `${base}.keystore.json`));
    return dbOut;
  }
  /** The unit that is open right now. */
  get currentUnit(): Unit {
    if (!this.unit) throw new Error("Vault is locked");
    return this.unit;
  }
  /** Registers a new unit and creates its empty file with the same data key. Does not open it. */
  createUnit(name: string, label = "", copyTemplatesFrom?: string): Unit {
    const key = this.dataKey;
    const cur = this.db;
    if (!cur || !key) throw new Error("Vault is locked");
    const src = copyTemplatesFrom ? this.unitOrThrow(copyTemplatesFrom) : null; // check before registering
    const unit = units.add(name, label);
    const dest = openEncrypted(units.filePath(unit), key);
    try {
      if (src) {
        try {
          if (src.id === this.unit?.id) copyTemplates(cur, dest);
          else {
            const from = openEncrypted(units.filePath(src), key);
            try {
              copyTemplates(from, dest);
            } finally {
              from.close();
            }
          }
        } catch (e) {
          throw new Error(
            "The unit was created, but templates could not be copied: " +
              (e as Error).message,
          );
        }
      }
    } finally {
      dest.close();
    }
    return unit;
  }
  /** What a unit holds, for the delete confirmation. */
  unitSummary(id: string): {
    accounts: number;
    transactions: number;
    reports: number;
  } {
    const key = this.dataKey;
    const cur = this.db;
    if (!cur || !key) throw new Error("Vault is locked");
    const unit = this.unitOrThrow(id);
    const count = (d: DB) =>
      d
        .prepare(
          "SELECT (SELECT count(*) FROM accounts) AS accounts, (SELECT count(*) FROM transactions) AS transactions, (SELECT count(*) FROM reports) AS reports",
        )
        .get() as { accounts: number; transactions: number; reports: number };
    if (unit.id === this.unit?.id) return count(cur);
    const d = openEncrypted(units.filePath(unit), key);
    try {
      return count(d);
    } finally {
      d.close();
    }
  }
  /** Permanently deletes another unit. Needs the password. The open unit cannot be deleted. */
  deleteUnit(id: string, password: string): void {
    if (!this.db || !this.dataKey) throw new Error("Vault is locked");
    const unit = this.unitOrThrow(id);
    if (unit.id === this.unit?.id)
      throw new Error("Open another unit to delete this one");
    if (!this.verifyPassword(password)) throw new Error("Incorrect password");
    units.remove(unit.id); // out of the list first; a leftover file is harmless
    const file = units.filePath(unit);
    try {
      for (const f of [file, `${file}-wal`, `${file}-shm`])
        rmSync(f, { force: true });
    } catch {
      throw new Error(
        `The unit was removed, but its file could not be deleted: ${file}`,
      );
    }
  }
  private unitOrThrow(id: string): Unit {
    const u = units.get(String(id));
    if (!u) throw new Error("Unit not found");
    return u;
  }
  private open(key: Buffer, unit: Unit) {
    this.lock(); // never hold two units open
    let db: DB;
    try {
      db = openEncrypted(units.filePath(unit), key);
    } catch (e) {
      key.fill(0);
      throw e;
    }
    this.dataKey = key;
    this.db = db;
    this.unit = unit;
    units.setLastUsed(unit.id);
  }
}
export const vault = new Vault();
