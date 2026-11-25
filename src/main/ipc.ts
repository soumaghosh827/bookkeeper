import { ipcMain, dialog, BrowserWindow } from "electron";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { vault } from "./vault";
import { units, unitDisplayName, type Unit } from "./units";
import type {
  DocAnalysis,
  DocMapping,
  DocModel,
  MappedSaveResult,
  Result,
  UnitInfo,
} from "@shared/types";
import { FieldError } from "./services/errors";
import * as prefs from "./services/prefs";
import * as labels from "./services/labels";
import * as acc from "./services/accounts";
import * as imp from "./services/masterImport";
import * as batches from "./services/importBatches";
import * as txi from "./services/txImport";
import * as tx from "./services/transactions";
import * as cc from "./services/customColumns";
import * as prev from "./services/preview";
import * as tpl from "./services/templates";
import * as rep from "./services/reports";
import { listRefs } from "./services/txReferences";
import { readDocxModel } from "./services/docxModel";
import { applyMapping } from "./services/docxMap";
import { detectDocument } from "./services/docxDetectDoc";
import { validateMapping } from "./services/mappingRules";
import { buildTransactionsWorkbook } from "./services/exportXlsx";

// Handlers never leak stack traces: errors become {ok:false,error}. FieldError also tells the UI which column.
const run = <T>(fn: () => Result<T>): Result<T> => {
  try {
    return fn();
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).message,
      field: e instanceof FieldError ? e.field : undefined,
    };
  }
};
const runAsync = async <T>(
  fn: () => Promise<Result<T>>,
): Promise<Result<T>> => {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};
const win = () =>
  BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
const openDlg = (o: Electron.OpenDialogOptions) => {
  const w = win();
  return w ? dialog.showOpenDialog(w, o) : dialog.showOpenDialog(o);
};
const saveDlg = (o: Electron.SaveDialogOptions) => {
  const w = win();
  return w ? dialog.showSaveDialog(w, o) : dialog.showSaveDialog(o);
};
const db = () => vault.handle;
// The Word file to map: bytes picked on screen, or (given a template id) the source stored on that template.
function loadSource(
  src: Uint8Array | number,
): Result<{ buf: Buffer; storedMapping: string | null }> {
  let buf: Buffer;
  let storedMapping: string | null = null;
  if (typeof src === "number") {
    const s = tpl.getSource(db(), src);
    if (!s?.source_file)
      return {
        ok: false,
        error:
          "This template was uploaded the old way. Import its Word file again to map it.",
      };
    buf = s.source_file;
    storedMapping = s.mapping;
  } else {
    buf = Buffer.from(src);
  }
  if (buf.length > 20 * 1024 * 1024)
    return { ok: false, error: "File is larger than 20 MB" };
  // old binary .doc files start with the OLE signature D0 CF 11 E0
  if (
    buf.length > 4 &&
    buf[0] === 0xd0 &&
    buf[1] === 0xcf &&
    buf[2] === 0x11 &&
    buf[3] === 0xe0
  )
    return { ok: false, error: "Save as .docx in Word" };
  return { ok: true, data: { buf, storedMapping } };
}
const unitInfo = (u: Unit): UnitInfo => ({
  id: u.id,
  name: u.name,
  label: u.label,
  display: unitDisplayName(u),
});
const H = ipcMain.handle.bind(ipcMain);
const CANCELLED = { ok: false as const, error: "Cancelled" };

export function registerIpc() {
  // ---- vault ----
  H("vault:state", () => vault.state());
  H("vault:create", (_e, password: string, unitName: string) =>
    typeof password !== "string" || password.length < 8
      ? { ok: false, error: "Password must be at least 8 characters" }
      : run(() => ({
          ok: true,
          data: { recoveryKey: vault.create(password, String(unitName)) },
        })),
  );
  H("vault:unlock", (_e, unitId: string, password: string) =>
    run(() =>
      vault.unlock(String(unitId), String(password))
        ? { ok: true }
        : { ok: false, error: "Incorrect password" },
    ),
  );
  H(
    "vault:unlockWithRecoveryKey",
    (_e, unitId: string, key: string, pw: string) =>
      String(pw).length < 8
        ? { ok: false, error: "Password must be at least 8 characters" }
        : run(() =>
            vault.unlockWithRecoveryKey(String(unitId), String(key), String(pw))
              ? { ok: true }
              : { ok: false, error: "Invalid recovery key" },
          ),
  );
  H("vault:lock", () => {
    // never keep a loaded import in memory after locking
    imp.clearSession();
    txi.clearSession();
    return vault.lock();
  });

  // ---- units ----
  H("unit:list", () => ({
    units: units.list().map(unitInfo),
    lastUsedId: units.lastUsed()?.id ?? null,
  }));
  H("unit:current", () => {
    if (vault.state() !== "unlocked") return null;
    const u = units.get(vault.currentUnit.id);
    return u ? unitInfo(u) : null;
  });
  H("unit:create", (_e, name: string, label?: string, copyFrom?: string) =>
    run(() => ({
      ok: true,
      data: unitInfo(
        vault.createUnit(
          String(name),
          String(label ?? ""),
          copyFrom ? String(copyFrom) : undefined,
        ),
      ),
    })),
  );
  H("unit:rename", (_e, id: string, name: string) =>
    run(() => {
      db(); // must be unlocked
      return { ok: true, data: unitInfo(units.rename(String(id), name)) };
    }),
  );
  H("unit:summary", (_e, id: string) =>
    run(() => ({ ok: true, data: vault.unitSummary(String(id)) })),
  );
  H("unit:delete", (_e, id: string, password: string) =>
    run(() => {
      vault.deleteUnit(String(id), String(password));
      return { ok: true };
    }),
  );
  H("unit:label", (_e, id: string, label: string) =>
    run(() => {
      db();
      return { ok: true, data: unitInfo(units.setLabel(String(id), label)) };
    }),
  );

  // ---- settings ----
  H("labels:get", () => labels.getLabels(db()));
  H("labels:set", (_e, k, l) => run(() => labels.setLabel(db(), k, l)));
  H("prefs:get", (_e, k: string) => prefs.getPref(db(), k));
  H("prefs:set", (_e, k: string, v: string) =>
    prefs.setPref(db(), k, String(v)),
  );
  H("backup:create", async () => {
    const r = await openDlg({
      title: "Choose backup location",
      properties: ["openDirectory", "createDirectory"],
    });
    if (r.canceled || !r.filePaths[0]) return CANCELLED;
    return run(() => ({
      ok: true,
      data: { path: vault.backupTo(r.filePaths[0]) },
    }));
  });

  // ---- master ----
  H("acc:search", (_e, f, t) => acc.searchAccounts(db(), f, String(t)));
  H("acc:list", (_e, q) => acc.listAccounts(db(), q));
  H("acc:create", (_e, a, c) => run(() => acc.createAccount(db(), a, c)));
  H("acc:update", (_e, id, ch, c) =>
    run(() => acc.updateAccount(db(), String(id), ch, c)),
  );
  H("acc:correct", (_e, id, ch, c, auth) =>
    run(() =>
      acc.correctAccount(db(), String(id), ch, c ?? {}, auth ?? {}, (p) =>
        vault.verifyPassword(p),
      ),
    ),
  );
  H("acc:history", (_e, id) => acc.accountHistory(db(), String(id)));

  H("imp:pick", () =>
    runAsync(async () => {
      const r = await openDlg({
        title: "Select Excel file",
        filters: [{ name: "Excel", extensions: ["xlsx"] }],
        properties: ["openFile"],
      });
      if (r.canceled || !r.filePaths[0]) return CANCELLED;
      return { ok: true, data: await imp.loadFile(db(), r.filePaths[0]) };
    }),
  );
  H("imp:sheet", (_e, name: string) =>
    run(() => ({ ok: true, data: imp.selectSheet(db(), name) })),
  );
  H("imp:paste", (_e, text, mode) =>
    run(() => ({
      ok: true,
      data: imp.loadPaste(
        db(),
        text,
        mode === "yes" || mode === "no" ? mode : "auto",
      ),
    })),
  );
  H("imp:analyze", (_e, m) =>
    run(() => ({ ok: true, data: imp.analyze(db(), m) })),
  );
  H("imp:commitplan", (_e, m, o) =>
    run(() => ({ ok: true, data: imp.commitPlan(db(), m, o) })),
  );
  // ---- transactions import (Excel with transactions: fills accounts and transactions) ----
  H("tximp:pick", () =>
    runAsync(async () => {
      const r = await openDlg({
        title: "Select Excel file with transactions",
        filters: [{ name: "Excel", extensions: ["xlsx"] }],
        properties: ["openFile"],
      });
      if (r.canceled || !r.filePaths[0]) return CANCELLED;
      return { ok: true, data: await txi.loadFile(db(), r.filePaths[0]) };
    }),
  );
  H("tximp:sheet", (_e, name: string) =>
    run(() => ({ ok: true, data: txi.selectSheet(db(), name) })),
  );
  H("tximp:analyze", (_e, m) =>
    run(() => ({ ok: true, data: txi.analyze(db(), m) })),
  );
  H("tximp:commit", (_e, o) =>
    run(() => ({ ok: true, data: txi.commit(db(), o) })),
  );
  H("tximp:cancel", () => txi.clearSession());
  H("tximp:undoInfo", () => batches.undoInfo(db()));
  H("tximp:undoLast", () =>
    run(() => ({ ok: true, data: batches.undoLastImport(db()) })),
  );

  // ---- transactions ----
  H("tx:create", (_e, t, c) => run(() => tx.createTransaction(db(), t, c)));
  H("tx:update", (_e, uid, ch, c) =>
    run(() => tx.updateTransaction(db(), String(uid), ch, c)),
  );
  H("tx:correct", (_e, uid, ch, c, auth) =>
    run(() =>
      tx.correctTransaction(db(), String(uid), ch, c ?? {}, auth ?? {}, (p) =>
        vault.verifyPassword(p),
      ),
    ),
  );
  H("tx:history", (_e, uid) => tx.txHistory(db(), String(uid)));
  H("tx:remove", (_e, uid) =>
    run(() => tx.removeTransaction(db(), String(uid))),
  );
  H("tx:list", (_e, q) => tx.listTransactions(db(), q));
  H("tx:export", (_e, q) =>
    runAsync(async () => {
      const r = await saveDlg({
        title: "Export to Excel",
        defaultPath: `Transactions ${new Date().toISOString().slice(0, 10)}.xlsx`,
        filters: [{ name: "Excel", extensions: ["xlsx"] }],
      });
      if (r.canceled || !r.filePath) return CANCELLED;
      const { buffer, rows } = await buildTransactionsWorkbook(db(), q);
      writeFileSync(r.filePath, buffer);
      return { ok: true, data: { path: r.filePath, rows } };
    }),
  );

  H("cols:list", (_e, s, all) => cc.listCustomColumns(db(), s, !!all));
  H("cols:add", (_e, s, l) => run(() => cc.addCustomColumn(db(), s, l)));
  H("cols:rename", (_e, k, l) => run(() => cc.renameCustomColumn(db(), k, l)));
  H("cols:archive", (_e, k, a) =>
    run(() => cc.archiveCustomColumn(db(), k, !!a)),
  );
  H("cols:reorder", (_e, s, keys) =>
    run(() => cc.reorderCustomColumns(db(), s, keys)),
  );

  // ---- working list (preview) ----
  H("prev:list", () => prev.listPreview(db()));
  H("prev:add", (_e, uids: string[], at?: number) =>
    run(() => ({
      ok: true,
      data: { added: prev.addToPreview(db(), uids.map(String), at) },
    })),
  );
  H("prev:remove", (_e, uid) =>
    run(() => (prev.removeFromPreview(db(), String(uid)), { ok: true })),
  );
  H("prev:clear", () => run(() => (prev.clearPreview(db()), { ok: true })));

  // ---- templates & reports ----
  H("tpl:list", () => tpl.listTemplates(db()));
  H("tpl:save", (_e, t) => run(() => tpl.saveTemplate(db(), t)));
  // Picks and validates a .docx but stores nothing; the screen keeps it until Save.
  H("tpl:pickFile", () =>
    runAsync(async () => {
      const r = await openDlg({
        title: "Select Word template",
        filters: [{ name: "Word", extensions: ["docx"] }],
        properties: ["openFile"],
      });
      if (r.canceled || !r.filePaths[0]) return CANCELLED;
      const data = readFileSync(r.filePaths[0]);
      if (data.length > 20 * 1024 * 1024)
        return { ok: false as const, error: "File is larger than 20 MB" };
      tpl.checkDocx(data);
      return {
        ok: true as const,
        data: {
          name: basename(r.filePaths[0]),
          data,
          warnings: tpl.lintTemplate(data),
        },
      };
    }),
  );
  // Stores a previously picked file against a saved template.
  H("tpl:setFile", (_e, id: number, data: Uint8Array) =>
    run(() => tpl.setTemplateFile(db(), id, Buffer.from(data))),
  );
  H("tpl:remove", (_e, id) => run(() => tpl.removeTemplate(db(), id)));
  H("tpl:lint", (_e, id: number) => tpl.lintStoredTemplate(db(), id));
  H("tpl:usesCheque", (_e, id: number) =>
    tpl.templateUsesCheque(db(), Math.trunc(Number(id)) || 0),
  );
  // Read-only view of a Word file for the preview: pass the bytes (picked file) or a template id (stored file).
  H("tpl:inspect", (_e, src: Uint8Array | number) =>
    run<DocModel>(() => {
      let buf: Buffer;
      if (typeof src === "number") {
        const f = tpl.getTemplateFile(db(), src);
        if (!f?.file)
          return { ok: false, error: "This template has no Word file yet" };
        buf = f.file;
      } else {
        buf = Buffer.from(src);
      }
      if (buf.length > 20 * 1024 * 1024)
        return { ok: false, error: "File is larger than 20 MB" };
      // old binary .doc files start with the OLE signature D0 CF 11 E0
      if (
        buf.length > 4 &&
        buf[0] === 0xd0 &&
        buf[1] === 0xcf &&
        buf[2] === 0x11 &&
        buf[3] === 0xe0
      )
        return { ok: false, error: "Save as .docx in Word" };
      return { ok: true, data: readDocxModel(buf) };
    }),
  );
  // ---- map the user's own Word file (step 7) ----
  // Picks the user's finished Word file. Not checked as a template: it is only a source to map.
  H("tpl:pickSource", () =>
    runAsync(async () => {
      const r = await openDlg({
        title: "Select your Word file",
        filters: [{ name: "Word", extensions: ["docx"] }],
        properties: ["openFile"],
      });
      if (r.canceled || !r.filePaths[0]) return CANCELLED;
      const data = readFileSync(r.filePaths[0]);
      const s = loadSource(data);
      if (!s.ok) return { ok: false as const, error: s.error };
      return {
        ok: true as const,
        data: { name: basename(r.filePaths[0]), data },
      };
    }),
  );
  // Model + possibilities (+ the saved choices when given a template id) for the mapping screen.
  H("tpl:analyze", (_e, src: Uint8Array | number) =>
    run<DocAnalysis>(() => {
      const s = loadSource(src);
      if (!s.ok || !s.data) return { ok: false, error: s.error };
      const model = readDocxModel(s.data.buf);
      let mapping: DocMapping[] = [];
      try {
        const v = validateMapping(JSON.parse(s.data.storedMapping ?? "[]"));
        if (v.ok) mapping = v.mapping;
      } catch {
        /* unreadable stored mapping: start with no choices */
      }
      return {
        ok: true,
        data: { model, suggestions: detectDocument(model), mapping },
      };
    }),
  );
  // The letter as the saved template will hold it: choices applied, {tags} and the {@table} marker in place. Stores nothing.
  H("tpl:inspectMapped", (_e, src: Uint8Array | number, mapping: unknown) =>
    run<DocModel>(() => {
      const s = loadSource(src);
      if (!s.ok || !s.data) return { ok: false, error: s.error };
      const v = validateMapping(mapping);
      if (!v.ok) return { ok: false, error: v.error };
      const buf = v.mapping.length
        ? applyMapping(s.data.buf, v.mapping)
        : s.data.buf;
      return { ok: true, data: readDocxModel(buf) };
    }),
  );
  // The result of the choices on fake data, for a "see it filled" preview. Stores nothing.
  H("tpl:testFill", (_e, src: Uint8Array | number, mapping: unknown) =>
    run<DocModel>(() => {
      const s = loadSource(src);
      if (!s.ok || !s.data) return { ok: false, error: s.error };
      const v = validateMapping(mapping);
      if (!v.ok) return { ok: false, error: v.error };
      const file = applyMapping(s.data.buf, v.mapping);
      tpl.checkDocx(file);
      const texts = Object.fromEntries(v.texts.map((t) => [t.key, t.value]));
      return { ok: true, data: readDocxModel(rep.renderSample(file, texts)) };
    }),
  );
  // Stores the mapped template: file, source and choices together, or nothing.
  H(
    "tpl:saveMapped",
    (_e, id: number, src: Uint8Array | number, mapping: unknown) =>
      run<MappedSaveResult>(() => {
        const s = loadSource(src);
        if (!s.ok || !s.data) return { ok: false, error: s.error };
        return tpl.saveMapped(db(), id, s.data.buf, mapping, (file, texts) => {
          rep.renderSample(file, texts);
        });
      }),
  );
  H("tpl:getTexts", (_e, id) => tpl.getTexts(db(), id));
  H("tpl:setTexts", (_e, id, t) => run(() => tpl.setTexts(db(), id, t)));
  H("tpl:getPlan", (_e, id: number) => tpl.getPlan(db(), id));
  H("tpl:setPlan", (_e, id: number, plan) =>
    run(() => tpl.setPlan(db(), id, plan)),
  );
  H(
    "rep:prepare",
    (_e, id, uids, title, refNo, reportDate, extraExcel, chequeNo) =>
      runAsync(() =>
        rep.prepare(
          db(),
          id,
          (uids as string[]).map(String),
          String(title ?? "").slice(0, 120),
          String(refNo ?? ""),
          String(reportDate ?? ""),
          extraExcel === true,
          String(chequeNo ?? ""),
        ),
      ),
  );
  H("rep:discard", () => rep.discard());
  // references of the latest saved reports (for the Entry screen's "Last / Next / Recent")
  H("rep:recentRefs", (_e, limit?: number) =>
    rep.recentRefs(
      db(),
      Math.min(Math.max(Math.trunc(Number(limit)) || 8, 1), 50),
    ),
  );
  // cheque numbers: "already used?" check and the last one used (for the Entry screen)
  H("rep:chequeUsed", (_e, chequeNo?: string) =>
    rep.chequeUsed(db(), String(chequeNo ?? "").slice(0, 100)),
  );
  H("rep:lastCheque", () => rep.lastCheque(db()));
  // saved reports for the Reports tab
  H(
    "rep:list",
    (
      _e,
      q?: {
        search?: string;
        from?: string;
        to?: string;
        limit?: number;
        offset?: number;
      },
    ) =>
      rep.listReports(db(), {
        search: String(q?.search ?? ""),
        from: String(q?.from ?? ""),
        to: String(q?.to ?? ""),
        limit: Number(q?.limit),
        offset: Number(q?.offset),
      }),
  );
  H("rep:items", (_e, id: number) =>
    rep.reportItems(db(), Math.trunc(Number(id)) || 0),
  );
  // references on existing transactions, highest number first (for the Entry screen's "Past transaction refs")
  H("rep:pastRefs", (_e, search?: string) =>
    listRefs(db(), String(search ?? "").slice(0, 100)),
  );
  // Word model of a generated (not yet saved) file, for the report preview
  H("rep:preview", (_e, fileId: string) =>
    run<DocModel>(() => {
      const f = rep
        .getPending()
        ?.files.find((x) => x.id === String(fileId) && x.kind === "docx");
      if (!f)
        return {
          ok: false,
          error: "Nothing prepared. Generate the report again.",
        };
      return { ok: true, data: readDocxModel(f.buffer) };
    }),
  );
  // Prints the app window (the renderer has mounted a print-only copy of the active tab and hidden the rest).
  // Records the report once, only after the print job succeeds.
  H(
    "rep:print",
    (e, fileId: string, record: boolean, page?: DocModel["page"]) =>
      runAsync<{ recorded: boolean }>(async () => {
        const p = rep.getPending();
        if (!p)
          return {
            ok: false,
            error: "Nothing prepared. Generate the report again.",
          };
        const dim = (v: unknown, d: number) =>
          typeof v === "number" && v >= 100 && v <= 3000 ? v : d; // points; falls back to A4
        const um = 25400 / 72; // microns per point
        const MARGIN_UNIT = 1; // custom margins are taken as points; if a test print shows them off by a third, try 96 / 72
        const mg = (v: unknown) =>
          Math.round(
            (typeof v === "number" && v >= 0 && v <= 300 ? v : 36) *
              MARGIN_UNIT,
          );
        const res = await new Promise<{ success: boolean; reason: string }>(
          (resolve) => {
            e.sender.print(
              {
                silent: false,
                printBackground: true,
                margins: {
                  marginType: "custom", // the document's own margins, applied to every printed page
                  top: mg(page?.margin?.top),
                  right: mg(page?.margin?.right),
                  bottom: mg(page?.margin?.bottom),
                  left: mg(page?.margin?.left),
                },
                pageSize: {
                  width: Math.round(dim(page?.width, 595.3) * um),
                  height: Math.round(dim(page?.height, 841.9) * um),
                },
              },
              (success, reason) =>
                resolve({ success, reason: String(reason ?? "") }),
            );
          },
        );
        if (!res.success)
          return /cancel/i.test(res.reason)
            ? CANCELLED
            : {
                ok: false,
                error: `Could not print: ${res.reason || "unknown error"}`,
              };
        const was = p.recorded;
        if (record) {
          const f = p.files.find((x) => x.id === String(fileId));
          rep.record(db(), `${f?.fileName ?? "Report"} (printed)`);
        }
        return { ok: true, data: { recorded: !was && p.recorded } };
      }),
  );
  H("rep:save", (_e, record: boolean, names?: Record<string, string>) =>
    runAsync(async () => {
      const p = rep.getPending();
      if (!p)
        return {
          ok: false,
          error: "Nothing prepared. Generate the report again.",
        };

      // edited names win; strip path characters and keep the right extension
      const files = p.files.map((f) => {
        const stem =
          String(names?.[f.id] ?? f.fileName)
            .replace(/[\\/:*?"<>|]+/g, "_")
            .replace(/\.(docx|xlsx)$/i, "")
            .trim()
            .slice(0, 100) || "Report";
        return { ...f, fileName: `${stem}.${f.kind}` };
      });
      const lower = files.map((f) => f.fileName.toLowerCase());
      if (new Set(lower).size !== lower.length)
        return {
          ok: false,
          error:
            "Two files have the same name. Give each file a different name.",
        };

      let outPath: string;
      let recorded: string[];
      if (files.length === 1) {
        const f = files[0];
        const r = await saveDlg({
          title: "Save report",
          defaultPath: f.fileName,
          filters: [
            f.kind === "xlsx"
              ? { name: "Excel workbook", extensions: ["xlsx"] }
              : { name: "Word document", extensions: ["docx"] },
          ],
        });
        if (r.canceled || !r.filePath) return CANCELLED; // nothing is written; the prepared report stays so the user can retry
        writeFileSync(r.filePath, f.buffer);
        outPath = r.filePath;
        recorded = [r.filePath.split(/[\\/]/).pop()!];
      } else {
        const r = await openDlg({
          title: "Choose a folder for the report files",
          properties: ["openDirectory", "createDirectory"],
        });
        if (r.canceled || !r.filePaths[0]) return CANCELLED;
        const dir = r.filePaths[0];
        const existing = files
          .filter((f) => existsSync(join(dir, f.fileName)))
          .map((f) => f.fileName);
        if (existing.length) {
          const w = win();
          const opts = {
            type: "warning" as const,
            buttons: ["Replace", "Cancel"],
            defaultId: 1,
            cancelId: 1,
            title: "Files already exist",
            message: `These files already exist in the folder:\n${existing.join("\n")}`,
            detail: "Replace them?",
          };
          const { response } = await (w
            ? dialog.showMessageBox(w, opts)
            : dialog.showMessageBox(opts));
          if (response !== 0) return CANCELLED;
        }
        for (const f of files) writeFileSync(join(dir, f.fileName), f.buffer);
        outPath = dir;
        recorded = files.map((f) => f.fileName);
      }
      if (record) rep.record(db(), recorded.join(", ")); // no-op if this prepared report was already recorded
      // the prepared report stays until the dialog closes (reports.discard), so Print can still use it
      return { ok: true, data: { path: outPath } };
    }),
  );
}
