import { ipcMain, dialog, BrowserWindow } from "electron";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { vault } from "./vault";
import type { Result } from "@shared/types";
import { FieldError } from "./services/errors";
import * as prefs from "./services/prefs";
import * as labels from "./services/labels";
import * as acc from "./services/accounts";
import * as imp from "./services/masterImport";
import * as txi from "./services/txImport";
import * as tx from "./services/transactions";
import * as cc from "./services/customColumns";
import * as prev from "./services/preview";
import * as tpl from "./services/templates";
import * as rep from "./services/reports";
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
const H = ipcMain.handle.bind(ipcMain);
const CANCELLED = { ok: false as const, error: "Cancelled" };

export function registerIpc() {
  // ---- vault ----
  H("vault:state", () => vault.state());
  H("vault:create", (_e, password: string) =>
    typeof password !== "string" || password.length < 8
      ? { ok: false, error: "Password must be at least 8 characters" }
      : run(() => ({
          ok: true,
          data: { recoveryKey: vault.create(password) },
        })),
  );
  H("vault:unlock", (_e, password: string) =>
    vault.unlock(String(password))
      ? { ok: true }
      : { ok: false, error: "Incorrect password" },
  );
  H("vault:unlockWithRecoveryKey", (_e, key: string, pw: string) =>
    String(pw).length < 8
      ? { ok: false, error: "Password must be at least 8 characters" }
      : vault.unlockWithRecoveryKey(String(key), String(pw))
        ? { ok: true }
        : { ok: false, error: "Invalid recovery key" },
  );
  H("vault:lock", () => {
    // never keep a loaded import in memory after locking
    imp.clearSession();
    txi.clearSession();
    return vault.lock();
  });

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
  H("tximp:undoInfo", () => txi.undoInfo(db()));
  H("tximp:undoLast", () =>
    run(() => ({ ok: true, data: txi.undoLastImport(db()) })),
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
  H("tpl:upload", (_e, id: number) =>
    runAsync(async () => {
      const r = await openDlg({
        title: "Select Word template",
        filters: [{ name: "Word", extensions: ["docx"] }],
        properties: ["openFile"],
      });
      if (r.canceled || !r.filePaths[0]) return CANCELLED;
      return tpl.setTemplateFile(db(), id, readFileSync(r.filePaths[0]));
    }),
  );
  H("tpl:remove", (_e, id) => run(() => tpl.removeTemplate(db(), id)));
  H("tpl:getTexts", (_e, id) => tpl.getTexts(db(), id));
  H("tpl:setTexts", (_e, id, t) => run(() => tpl.setTexts(db(), id, t)));
  H("tpl:getPlan", (_e, id: number) => tpl.getPlan(db(), id));
  H("tpl:setPlan", (_e, id: number, plan) =>
    run(() => tpl.setPlan(db(), id, plan)),
  );

  H("rep:prepare", (_e, id, uids, title) =>
    runAsync(() =>
      rep.prepare(
        db(),
        id,
        (uids as string[]).map(String),
        String(title ?? "").slice(0, 120),
      ),
    ),
  );
  H("rep:discard", () => rep.discard());
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
      if (record) rep.record(db(), recorded.join(", "));
      rep.discard();
      return { ok: true, data: { path: outPath } };
    }),
  );
}
