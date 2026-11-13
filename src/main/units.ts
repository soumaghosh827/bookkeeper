import { app } from "electron";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";

/** One unit = one encrypted db file. The id is permanent, so renaming never touches a file name. */
export interface Unit {
  id: string;
  name: string;
  label: string;
  file: string;
}
interface RegistryFile {
  version: 1;
  lastUsed: string | null;
  nextId?: number;
  units: Unit[];
}

const NAME_MAX = 40;
const LABEL_MAX = 60;

/** "Unit 1" with no label, "Unit 1 - Label" with one. */
export const unitDisplayName = (u: Pick<Unit, "name" | "label">) =>
  u.label ? `${u.name} - ${u.label}` : u.name;

const clean = (s: unknown) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Plain-text list of units (names and labels only, no data) so the login screen can show
 * the picker before unlock. Every read hits the file; it is tiny and rarely used.
 */
class UnitRegistry {
  private dir = app.getPath("userData");
  readonly path = join(this.dir, "units.json");

  private read(): RegistryFile {
    if (!existsSync(this.path))
      return { version: 1, lastUsed: null, units: [] };
    let f: RegistryFile;
    try {
      f = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      throw new Error("The unit list is damaged");
    }
    if (!f || !Array.isArray(f.units))
      throw new Error("The unit list is damaged");
    return f;
  }
  /** Write to a temp file, then rename, so a crash never leaves a half-written list. */
  private write(f: RegistryFile) {
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(f, null, 2));
    renameSync(tmp, this.path);
  }

  cleanName(name: unknown, selfId?: string): string {
    const n = clean(name);
    if (!n) throw new Error("Unit name is required");
    if (n.length > NAME_MAX)
      throw new Error(`Unit name can be at most ${NAME_MAX} characters`);
    const taken = this.read().units.some(
      (u) => u.id !== selfId && u.name.toLowerCase() === n.toLowerCase(),
    );
    if (taken) throw new Error("A unit with this name already exists");
    return n;
  }
  private cleanLabel(label: unknown): string {
    const l = clean(label);
    if (l.length > LABEL_MAX)
      throw new Error(`Label can be at most ${LABEL_MAX} characters`);
    return l;
  }

  list = (): Unit[] => this.read().units;
  has = (): boolean => this.read().units.length > 0;
  get(id: string): Unit | undefined {
    return this.read().units.find((u) => u.id === id);
  }
  /** Last unit opened, falling back to the first one. */
  lastUsed(): Unit | undefined {
    const f = this.read();
    return f.units.find((u) => u.id === f.lastUsed) ?? f.units[0];
  }
  filePath = (u: Unit) => join(this.dir, u.file);

  add(name: unknown, label: unknown = ""): Unit {
    const n = this.cleanName(name);
    const l = this.cleanLabel(label);
    const f = this.read();
    const next = Math.max(
      f.nextId ?? 0,
      f.units.reduce((m, u) => Math.max(m, Number(u.id) || 0), 0) + 1,
    );
    const unit: Unit = {
      id: String(next),
      name: n,
      label: l,
      file: `unit-${next}.db`,
    };
    f.units.push(unit);
    f.nextId = next + 1; // ids are permanent, even after a delete
    if (!f.lastUsed) f.lastUsed = unit.id;
    this.write(f);
    return unit;
  }
  rename(id: string, name: unknown): Unit {
    const n = this.cleanName(name, id);
    return this.patch(id, (u) => {
      u.name = n;
    });
  }
  setLabel(id: string, label: unknown): Unit {
    const l = this.cleanLabel(label);
    return this.patch(id, (u) => {
      u.label = l;
    });
  }
  setLastUsed(id: string) {
    const f = this.read();
    if (!f.units.some((u) => u.id === id) || f.lastUsed === id) return;
    f.lastUsed = id;
    this.write(f);
  }

  /** Takes the unit out of the list and returns it (the caller deletes the file). The last unit cannot be removed. */
  remove(id: string): Unit {
    const f = this.read();
    const i = f.units.findIndex((u) => u.id === id);
    if (i < 0) throw new Error("Unit not found");
    if (f.units.length <= 1) throw new Error("The last unit cannot be deleted");
    const [u] = f.units.splice(i, 1);
    f.nextId = Math.max(f.nextId ?? 0, (Number(u.id) || 0) + 1);
    if (f.lastUsed === id) f.lastUsed = f.units[0]?.id ?? null;
    this.write(f);
    return u;
  }

  private patch(id: string, fn: (u: Unit) => void): Unit {
    const f = this.read();
    const u = f.units.find((x) => x.id === id);
    if (!u) throw new Error("Unit not found");
    fn(u);
    this.write(f);
    return u;
  }
}
export const units = new UnitRegistry();
