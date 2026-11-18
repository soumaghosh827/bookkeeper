import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import type { DB } from "../db";
import {
  describePlan,
  normalizePlan,
  type MappedSaveResult,
  type OutputPlan,
  type Result,
  type Template,
  type TemplateText,
} from "@shared/types";
import { applyMapping } from "./docxMap";
import { validateMapping } from "./mappingRules";

const toTpl = (r: any): Template => ({
  id: r.id,
  name: r.name,
  description: r.description,
  has_file: !!r.has_file,
  updated_at: r.updated_at,
  format: describePlan(normalizePlan(r.output_plan)),
});

const SEL =
  "SELECT id, name, description, output_plan, (file IS NOT NULL) AS has_file, updated_at FROM templates";

const get = (db: DB, id: number) =>
  toTpl(db.prepare(`${SEL} WHERE id = ?`).get(id));

export const listTemplates = (db: DB) =>
  (db.prepare(`${SEL} ORDER BY name COLLATE NOCASE`).all() as any[]).map(toTpl);

export function saveTemplate(
  db: DB,
  t: { id?: number; name: string; description: string },
): Result<Template> {
  const name = String(t.name ?? "").trim();
  if (!name || name.length > 80)
    return { ok: false, error: "Name must be 1 to 80 characters" };
  const description = String(t.description ?? "")
    .trim()
    .slice(0, 300);
  const clash = db
    .prepare(
      "SELECT 1 FROM templates WHERE name = ? COLLATE NOCASE AND id != ?",
    )
    .get(name, t.id ?? 0);
  if (clash)
    return { ok: false, error: `A template named "${name}" already exists` };
  const now = new Date().toISOString();
  if (t.id) {
    db.prepare(
      "UPDATE templates SET name = ?, description = ?, updated_at = ? WHERE id = ?",
    ).run(name, description, now, t.id);
    return { ok: true, data: get(db, t.id) };
  }
  const r = db
    .prepare(
      "INSERT INTO templates (name, description, updated_at) VALUES (?, ?, ?)",
    )
    .run(name, description, now);
  return { ok: true, data: get(db, Number(r.lastInsertRowid)) };
}

/** Compiles the file once so that a broken placeholder is reported at upload time, not at report time. */
export function checkDocx(buf: Buffer) {
  try {
    new Docxtemplater(new PizZip(buf), {
      paragraphLoop: true,
      linebreaks: true,
    });
  } catch (e) {
    throw new Error("This is not a valid Word template: " + explain(e));
  }
}
/** Warnings (never errors) for a template that types text the app now adds itself. Reads the body, headers and footers. */
export function lintTemplate(buf: Buffer): string[] {
  let text = "";
  try {
    const zip = new PizZip(buf);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
    });
    for (const part of Object.keys(zip.files)) {
      if (!/^word\/(document|header\d*|footer\d*)\.xml$/.test(part)) continue;
      try {
        text += doc.getFullText(part) + "\n";
      } catch {
        /* a part docxtemplater did not compile: skip it */
      }
    }
  } catch {
    return []; // checkDocx reports a broken file; lint stays silent
  }
  const out: string[] = [];
  if (/\{\s*#\s*items\s*\}/.test(text))
    out.push(
      "Repeating rows ({#items} … {/items}) are no longer supported, so those rows will come out empty. Put {@table} in its own paragraph instead and delete the old table.",
    );
  if (/(?:\bRs\.?|₹)\s*\{\s*(?:amount|total)\s*\}/i.test(text))
    out.push(
      'A typed "Rs." or "₹" sits before {amount} or {total}. The app now adds "Rs." itself, so it would print twice. Delete the typed one.',
    );
  if (/\bRupees\s*\{\s*(?:amount_words|total_words)\s*\}/i.test(text))
    out.push(
      'A typed "Rupees" sits before {amount_words} or {total_words}. The app now adds "Rupees" itself, so it would print twice. Delete the typed one.',
    );
  return out;
}

/** Lint for the Word file stored on a template. */
export function lintStoredTemplate(db: DB, id: number): string[] {
  const f = getTemplateFile(db, id);
  return f?.file ? lintTemplate(f.file) : [];
}

export function setTemplateFile(
  db: DB,
  id: number,
  buf: Buffer,
): Result<Template> {
  if (buf.length > 20 * 1024 * 1024)
    return { ok: false, error: "File is larger than 20 MB" };
  checkDocx(buf);
  db.prepare(
    "UPDATE templates SET file = ?, source_file = NULL, mapping = NULL, updated_at = ? WHERE id = ?",
  ).run(buf, new Date().toISOString(), id);
  return { ok: true, data: get(db, id) };
}
export const removeTemplate = (db: DB, id: number): Result => (
  db.prepare("DELETE FROM templates WHERE id = ?").run(id),
  { ok: true }
);
export const getTemplateFile = (db: DB, id: number) =>
  db.prepare("SELECT name, file FROM templates WHERE id = ?").get(id) as
    | { name: string; file: Buffer | null }
    | undefined;

/** Stores the user's original Word file and the mapping chosen on it. Does not touch "file" (reports use that). */
export function saveSource(
  db: DB,
  id: number,
  source: Buffer,
  mapping: unknown,
): Result {
  if (source.length > 20 * 1024 * 1024)
    return { ok: false, error: "File is larger than 20 MB" };
  checkDocx(source);
  const json = JSON.stringify(mapping ?? []);
  if (json.length > 2_000_000)
    return { ok: false, error: "Too many mappings to store" };
  const r = db
    .prepare(
      "UPDATE templates SET source_file = ?, mapping = ?, updated_at = ? WHERE id = ?",
    )
    .run(source, json, new Date().toISOString(), id);
  return r.changes ? { ok: true } : { ok: false, error: "Template not found" };
}

/** The original Word file and mapping JSON; both null for templates built the old way. */
export const getSource = (db: DB, id: number) =>
  db
    .prepare("SELECT source_file, mapping FROM templates WHERE id = ?")
    .get(id) as
    | { source_file: Buffer | null; mapping: string | null }
    | undefined;

/**
 * Stores a template built by mapping the user's own Word file. Order: validate the mapping, rewrite the file with {tags},
 * check it compiles, try it on fake data, and only then save file + source + mapping + saved texts in ONE transaction.
 * Nothing is stored unless every step passes. A saved text with an existing key replaces the old value.
 * `trial` is passed in by the caller (ipc) because reports.ts imports this file, so importing it back would loop.
 */
export function saveMapped(
  db: DB,
  id: number,
  source: Buffer,
  mapping: unknown,
  trial: (file: Buffer, texts: Record<string, string>) => void,
): Result<MappedSaveResult> {
  if (source.length > 20 * 1024 * 1024)
    return { ok: false, error: "File is larger than 20 MB" };
  if (!db.prepare("SELECT 1 FROM templates WHERE id = ?").get(id))
    return { ok: false, error: "Template not found" };
  const v = validateMapping(mapping);
  if (!v.ok) return { ok: false, error: v.error };

  let file: Buffer;
  try {
    file = applyMapping(source, v.mapping);
    checkDocx(file);
  } catch (e) {
    return { ok: false, error: explain(e) };
  }

  const texts: Record<string, string> = Object.fromEntries(
    getTexts(db, id).map((t) => [t.key, t.value]),
  );
  for (const t of v.texts) texts[t.key] = t.value;
  try {
    trial(file, texts);
  } catch (e) {
    return {
      ok: false,
      error: "The template could not be filled: " + explain(e),
    };
  }

  const upsert = db.prepare(
    "INSERT INTO template_texts (template_id, key, value) VALUES (?, ?, ?) ON CONFLICT(template_id, key) DO UPDATE SET value = excluded.value",
  );
  db.transaction(() => {
    db.prepare(
      "UPDATE templates SET file = ?, source_file = ?, mapping = ?, updated_at = ? WHERE id = ?",
    ).run(
      file,
      source,
      JSON.stringify(v.mapping),
      new Date().toISOString(),
      id,
    );
    for (const t of v.texts) upsert.run(id, t.key, t.value);
  })();
  return { ok: true, data: { warnings: lintTemplate(file) } };
}

export const getTexts = (db: DB, id: number): TemplateText[] =>
  db
    .prepare(
      "SELECT key, value FROM template_texts WHERE template_id = ? ORDER BY key",
    )
    .all(id) as TemplateText[];
/** Copies every template (Word file, saved texts, output plan) from one unit's file into another's. */
export function copyTemplates(src: DB, dest: DB): number {
  const rows = src
    .prepare(
      "SELECT id, name, description, file, output_plan, source_file, mapping FROM templates ORDER BY id",
    )
    .all() as any[];
  const textsOf = src.prepare(
    "SELECT key, value FROM template_texts WHERE template_id = ?",
  );
  const insT = dest.prepare(
    "INSERT INTO templates (name, description, file, output_plan, source_file, mapping, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insX = dest.prepare(
    "INSERT INTO template_texts (template_id, key, value) VALUES (?, ?, ?)",
  );
  const now = new Date().toISOString();
  dest.transaction(() => {
    for (const t of rows) {
      const id = insT.run(
        t.name,
        t.description,
        t.file,
        t.output_plan,
        t.source_file,
        t.mapping,
        now,
      ).lastInsertRowid as number;
      for (const x of textsOf.all(t.id) as any[]) insX.run(id, x.key, x.value);
    }
  })();
  return rows.length;
}

export function setTexts(db: DB, id: number, texts: TemplateText[]): Result {
  const seen = new Set<string>();
  for (const t of texts) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(t.key))
      return {
        ok: false,
        error: `Invalid key "${t.key}": use lowercase letters, digits and _`,
      };
    if (seen.has(t.key))
      return { ok: false, error: `Duplicate key "${t.key}"` };
    seen.add(t.key);
  }
  const ins = db.prepare(
    "INSERT INTO template_texts (template_id, key, value) VALUES (?, ?, ?)",
  );
  db.transaction(() => {
    db.prepare("DELETE FROM template_texts WHERE template_id = ?").run(id);
    for (const t of texts) ins.run(id, t.key, String(t.value).slice(0, 2000));
  })();
  return { ok: true };
}

export function getPlan(db: DB, id: number): OutputPlan {
  const r = db
    .prepare("SELECT output_plan FROM templates WHERE id = ?")
    .get(id) as { output_plan: string } | undefined;
  return normalizePlan(r?.output_plan);
}

/** Whatever the screen sends is cleaned by normalizePlan before it is stored, so a bad plan can never be saved. */
export function setPlan(db: DB, id: number, plan: unknown): Result<OutputPlan> {
  if (!db.prepare("SELECT 1 FROM templates WHERE id = ?").get(id))
    return { ok: false, error: "Template not found" };
  const clean = normalizePlan(plan);
  db.prepare(
    "UPDATE templates SET output_plan = ?, updated_at = ? WHERE id = ?",
  ).run(JSON.stringify(clean), new Date().toISOString(), id);
  return { ok: true, data: clean };
}

export function explain(e: any): string {
  const errs = e?.properties?.errors;
  if (Array.isArray(errs) && errs.length)
    return errs
      .slice(0, 3)
      .map((x: any) => x?.properties?.explanation || x?.message)
      .join("; ");
  return e?.message ?? "Unknown error";
}
