import { contextBridge, ipcRenderer } from "electron";
import type { BookkeeperApi } from "@shared/types";

const inv = (ch: string, ...a: unknown[]) => ipcRenderer.invoke(ch, ...a);

const api: BookkeeperApi = {
  vault: {
    state: () => inv("vault:state"),
    create: (p, n) => inv("vault:create", p, n),
    unlock: (u, p) => inv("vault:unlock", u, p),
    unlockWithRecoveryKey: (u, k, p) =>
      inv("vault:unlockWithRecoveryKey", u, k, p),
    lock: () => inv("vault:lock"),
  },
  units: {
    list: () => inv("unit:list"),
    current: () => inv("unit:current"),
    create: (n, l, c) => inv("unit:create", n, l, c),
    rename: (id, n) => inv("unit:rename", id, n),
    setLabel: (id, l) => inv("unit:label", id, l),
    summary: (id) => inv("unit:summary", id),
    remove: (id, p) => inv("unit:delete", id, p),
  },
  labels: {
    get: () => inv("labels:get"),
    set: (k, l) => inv("labels:set", k, l),
  },
  prefs: {
    get: (k) => inv("prefs:get", k),
    set: (k, v) => inv("prefs:set", k, v),
  },
  backup: { create: () => inv("backup:create") },
  accounts: {
    search: (f, t) => inv("acc:search", f, t),
    list: (q) => inv("acc:list", q),
    create: (a, c) => inv("acc:create", a, c),
    update: (id, ch, c) => inv("acc:update", id, ch, c),
    correct: (id, ch, c, auth) => inv("acc:correct", id, ch, c, auth),
    history: (id) => inv("acc:history", id),
  },
  masterImport: {
    pickFile: () => inv("imp:pick"),
    selectSheet: (n) => inv("imp:sheet", n),
    loadPaste: (t, h) => inv("imp:paste", t, h),
    analyze: (m) => inv("imp:analyze", m),
    commitPlan: (m, o) => inv("imp:commitplan", m, o),
  },
  txImport: {
    pickFile: () => inv("tximp:pick"),
    selectSheet: (n) => inv("tximp:sheet", n),
    analyze: (m) => inv("tximp:analyze", m),
    commit: (o) => inv("tximp:commit", o),
    cancel: () => inv("tximp:cancel"),
    undoInfo: () => inv("tximp:undoInfo"),
    undoLast: () => inv("tximp:undoLast"),
  },
  transactions: {
    create: (t, c) => inv("tx:create", t, c),
    update: (uid, ch, c) => inv("tx:update", uid, ch, c),
    correct: (uid, ch, c, auth) => inv("tx:correct", uid, ch, c, auth),
    history: (uid) => inv("tx:history", uid),
    remove: (uid) => inv("tx:remove", uid),
    list: (q) => inv("tx:list", q),
    exportXlsx: (q) => inv("tx:export", q),
  },
  customColumns: {
    list: (s, all) => inv("cols:list", s, all),
    add: (s, l) => inv("cols:add", s, l),
    rename: (k, l) => inv("cols:rename", k, l),
    archive: (k, a) => inv("cols:archive", k, a),
    reorder: (s, keys) => inv("cols:reorder", s, keys),
  },
  preview: {
    list: () => inv("prev:list"),
    add: (uids, at) => inv("prev:add", uids, at),
    remove: (uid) => inv("prev:remove", uid),
    clear: () => inv("prev:clear"),
  },
  templates: {
    list: () => inv("tpl:list"),
    save: (t) => inv("tpl:save", t),
    uploadFile: (id) => inv("tpl:upload", id),
    remove: (id) => inv("tpl:remove", id),
    getTexts: (id) => inv("tpl:getTexts", id),
    setTexts: (id, t) => inv("tpl:setTexts", id, t),
    getPlan: (id) => inv("tpl:getPlan", id),
    setPlan: (id, plan) => inv("tpl:setPlan", id, plan),
  },
  reports: {
    prepare: (id, uids, title, refNo, reportDate) =>
      inv("rep:prepare", id, uids, title, refNo, reportDate),
    save: (r, names) => inv("rep:save", r, names),
    discard: () => inv("rep:discard"),
  },
};
contextBridge.exposeInMainWorld("api", api);
