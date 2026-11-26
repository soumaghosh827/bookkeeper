import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Account,
  CustomColumn,
  Labels,
  PreviewRow,
  RecentRef,
  ReportPrepared,
  SearchKey,
  Template,
  TxCreate,
} from "@shared/types";
import { canDelete } from "@shared/rules";
import {
  fmtDate,
  formatPaise,
  parseAmount,
  nextRef,
  nextChequeNo,
  chequeIsSixDigit,
  parseDate,
  todayIso,
} from "@shared/format";
import SuggestPanel from "@/components/SuggestPanel";
import Modal from "@/components/Modal";
import ReportDialog from "@/components/ReportDialog";
import PastRefsDialog from "@/components/PastRefsDialog";
import AskDialog from "@/components/AskDialog";
import NameDialog from "@/components/NameDialog";
import Icon from "@/components/Icon";
import { Toast, useToast } from "@/components/Toast";
import { useConfirmFlow } from "@/lib/useConfirmFlow";
import TransactionsScreen from "./TransactionsScreen";

const ACC: SearchKey[] = ["payee", "bank", "branch", "account_no", "ifsc"]; // form order; each box searches only its own column
const blank = (date?: string): Record<string, string> => ({
  payee: "",
  bank: "",
  branch: "",
  account_no: "",
  ifsc: "",
  amount: "",
  entry_date: date ?? "", // blank = today (set under More fields)
  utr: "",
  notes: "",
});
type Sug = {
  field: SearchKey;
  items: Account[];
  idx: number;
  text: string;
  rect: DOMRect;
};
const PAYEE_COLLATOR = new Intl.Collator(undefined, {
  numeric: true, // 105 sorts after 99
  sensitivity: "base", // ignore case
});
type Sort = { key: "payee" | "amount"; dir: "asc" | "desc" } | null;
type Report = {
  prepared: ReportPrepared;
  already: number;
  warnings: string[]; // template lint (never blocks)
  uids: string[]; // frozen when Generate was pressed
  refNo: string;
  chequeNo: string; // "" when the cheque switch is off or the box was empty
  reportDate: string; // ISO
};

export default function EntryScreen({
  labels,
  active,
  refreshKey,
  onTxChanged,
  onMasterChanged,
  onCount,
  useCheque,
  onUseCheque,
}: {
  labels: Labels;
  active: boolean;
  refreshKey: number;
  onTxChanged: () => void;
  onMasterChanged: () => void;
  onCount: (n: number) => void;
  useCheque: boolean;
  onUseCheque: (on: boolean) => void;
}) {
  const [d, setD] = useState(blank());
  const [accountId, setAccountId] = useState<string | null>(null);
  const [saveToMaster, setSaveToMaster] = useState(true);
  const [sug, setSug] = useState<Sug | null>(null);
  const [flash, setFlash] = useState(false);
  const [more, setMore] = useState(false);
  const [custom, setCustom] = useState<CustomColumn[]>([]);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [newUid, setNewUid] = useState<string | null>(null);
  const [tpls, setTpls] = useState<Template[]>([]);
  const [tplId, setTplId] = useState<number | "">("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [askClear, setAskClear] = useState(false);
  const [delRow, setDelRow] = useState<PreviewRow | null>(null);
  const [fieldDlg, setFieldDlg] = useState(false);
  const [refNo, setRefNo] = useState(""); // belongs to the report, not to a transaction
  const [repDate, setRepDate] = useState(fmtDate(todayIso()));
  const [recent, setRecent] = useState<RecentRef[]>([]); // references of the latest saved reports, newest first
  const [recentOpen, setRecentOpen] = useState(false);
  const [pastOpen, setPastOpen] = useState(false); // "Past refs" dialog
  const [sort, setSort] = useState<Sort>(null); // view-only sort of the right panel; null = entry order
  const refBox = useRef<HTMLDivElement>(null);
  const chqBox = useRef<HTMLDivElement>(null);
  const [chequeNo, setChequeNo] = useState(""); // belongs to the report, like the reference no
  const [chqOpen, setChqOpen] = useState(false);
  const [askChq, setAskChq] = useState(false); // "This template uses a cheque number. Turn it on?"
  const [lastChq, setLastChq] = useState(""); // cheque no of the latest report that has one

  const tplGroups = useMemo(() => {
    const m = new Map<string, Template[]>();
    for (const t of tpls)
      m.set(t.entry_group, [...(m.get(t.entry_group) ?? []), t]);
    return [...m.entries()];
  }, [tpls]);
  const tplSel = tpls.find((t) => t.id === tplId);

  const loadRecent = useCallback(async () => {
    setRecent(await window.api.reports.recentRefs(8));
    setLastChq((await window.api.reports.lastCheque())?.cheque_no ?? "");
  }, []);
  useEffect(() => {
    loadRecent();
  }, [loadRecent, active, refreshKey]);
  const lastRef = recent[0]?.ref_no ?? "";
  const nextOne = lastRef ? nextRef(lastRef) : null;
  useEffect(() => {
    if (!recentOpen) return;
    const away = (e: MouseEvent) => {
      if (!refBox.current?.contains(e.target as Node)) setRecentOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRecentOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [recentOpen]);
  const nextChq = lastChq ? nextChequeNo(lastChq) : null;
  const [chqUsed, setChqUsed] = useState<
    { cheque: string; ref_no: string; report_date: string }[]
  >([]);
  const [tplUsesChq, setTplUsesChq] = useState(false); // the chosen template has {cheque_no}
  // already used on another report (waits a moment after typing)
  useEffect(() => {
    if (!useCheque || !chequeNo.trim()) {
      setChqUsed([]);
      return;
    }
    let stale = false;
    const h = setTimeout(async () => {
      const r = await window.api.reports.chequeUsed(chequeNo.trim());
      if (!stale) setChqUsed(r);
    }, 300);
    return () => {
      stale = true;
      clearTimeout(h);
    };
  }, [useCheque, chequeNo, refreshKey]);
  // does the chosen template need a cheque number?
  useEffect(() => {
    if (!useCheque || tplId === "") {
      setTplUsesChq(false);
      return;
    }
    let stale = false;
    window.api.templates.usesCheque(tplId).then((v) => {
      if (!stale) setTplUsesChq(v);
    });
    return () => {
      stale = true;
    };
  }, [useCheque, tplId, active]);
  const chqWarn: string[] = [];
  if (useCheque) {
    if (chequeNo.trim() && !chequeIsSixDigit(chequeNo))
      chqWarn.push("This cheque number is not 6 digits.");
    for (const u of chqUsed)
      chqWarn.push(
        `Cheque ${u.cheque} is already used on report dated ${fmtDate(u.report_date)}${u.ref_no ? ` (${u.ref_no})` : ""}.`,
      );
    if (tplUsesChq && !chequeNo.trim())
      chqWarn.push("This template needs a cheque number, but the box is empty.");
  }
  useEffect(() => {
    if (!chqOpen) return;
    const away = (e: MouseEvent) => {
      if (!chqBox.current?.contains(e.target as Node)) setChqOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setChqOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [chqOpen]);
  const fillChq = (v: string) => {
    setChequeNo(v);
    setChqOpen(false);
    document.getElementById("rep-chq")?.focus();
  };
  const fillRef = (v: string) => {
    setRefNo(v);
    setRecentOpen(false);
    setPastOpen(false);
    document.getElementById("rep-ref")?.focus();
  };

  const refs = useRef<Record<string, HTMLInputElement | null>>({});
  const seq = useRef(0);
  const sugTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (sugTimer.current) clearTimeout(sugTimer.current);
    },
    [],
  );
  const saving = useRef(false);
  const { toast, show, hide } = useToast();
  const { withConfirm, element } = useConfirmFlow();
  const locked = !!accountId;
  const total = rows.reduce((n, r) => n + r.amount_paise, 0);
  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const d = sort.dir === "asc" ? 1 : -1;
    // Array.sort is stable, so rows that tie keep their entry order
    return [...rows].sort(
      (a, b) =>
        d *
        (sort.key === "amount"
          ? a.amount_paise - b.amount_paise
          : PAYEE_COLLATOR.compare(a.payee, b.payee)),
    );
  }, [rows, sort]);
  // payees whose first two words match another row: they get a second line (bank, branch, account end)
  const alike = useMemo(() => {
    const key = (p: string) =>
      p.trim().toLowerCase().split(/\s+/).slice(0, 2).join(" ");
    const n = new Map<string, number>();
    for (const r of rows) n.set(key(r.payee), (n.get(key(r.payee)) ?? 0) + 1);
    return new Set([...n].filter(([, c]) => c > 1).map(([k]) => k));
  }, [rows]);
  const detailLine = (r: PreviewRow) => {
    const key = r.payee.trim().toLowerCase().split(/\s+/).slice(0, 2).join(" ");
    if (!alike.has(key)) return "";
    const acc = r.account_no.trim();
    return [r.bank.trim(), r.branch.trim(), acc ? `····${acc.slice(-4)}` : ""]
      .filter(Boolean)
      .join(" · ");
  };
  // click cycle: first click = natural order (Amount: biggest first, Beneficiary: A to Z),
  // second click = the other way, third click = off
  const toggleSort = (key: "payee" | "amount") =>
    setSort((s) => {
      const first = key === "amount" ? "desc" : "asc";
      if (!s || s.key !== key) return { key, dir: first };
      return s.dir === first ? { key, dir: first === "asc" ? "desc" : "asc" } : null;
    });
  const sortBtn = (key: "payee" | "amount", text: string) => {
    const dir = sort?.key === key ? sort.dir : null;
    return (
      <button
        type="button"
        className={`pvsort${dir ? " on" : ""}`}
        title={`Sort by ${text}`}
        onClick={() => toggleSort(key)}
      >
        <span>{text}</span>
        {dir && (
          <span className="ind">
            <Icon name={dir === "asc" ? "up" : "down"} />
          </span>
        )}
      </button>
    );
  };

  const reloadRows = useCallback(async () => {
    const r = await window.api.preview.list();
    setRows(r);
    onCount(r.length);
  }, [onCount]);
  useEffect(() => {
    reloadRows();
  }, [reloadRows, refreshKey]);
  useEffect(() => {
    window.api.customColumns.list("transaction").then(setCustom);
  }, [refreshKey]);
  useEffect(() => {
    window.api.templates.list().then(setTpls);
    window.api.prefs.get("last_template").then((v) => {
      if (v) setTplId((cur) => cur || Number(v));
    });
  }, [active, refreshKey]);
  useEffect(() => {
    if (active) setTimeout(() => refs.current.payee?.focus(), 40);
  }, [active]);
  useEffect(() => {
    if (!newUid) return;
    const t = setTimeout(() => setNewUid(null), 1500);
    return () => clearTimeout(t);
  }, [newUid]);
  useEffect(() => {
    if (tplId && !tpls.some((t) => t.id === tplId) && tpls.length) setTplId("");
  }, [tpls, tplId]);

  const fail = (m: string, key: string) => {
    show(m, { tone: "error" });
    refs.current[key]?.focus();
  };

  // ---------- suggestions: each box searches ONLY its own column ----------
  const SUGGEST_MIN_CHARS = 2; // one letter matches half of a big master
  const SUGGEST_DELAY_MS = 150; // fast typing runs one search, not one per key
  async function runSuggest(field: SearchKey, text: string) {
    const el = refs.current[field];
    const id = ++seq.current;
    if (!el || document.activeElement !== el) return; // moved on to another field
    const items = await window.api.accounts.search(field, text);
    if (id !== seq.current || document.activeElement !== el) return; // stale reply
    setSug({ field, items, idx: 0, text, rect: el.getBoundingClientRect() });
  }
  function openSuggest(field: SearchKey, text: string) {
    if (sugTimer.current) clearTimeout(sugTimer.current);
    seq.current++; // drops any reply still on its way
    if (text.trim().length < SUGGEST_MIN_CHARS) return setSug(null);
    sugTimer.current = setTimeout(
      () => runSuggest(field, text),
      SUGGEST_DELAY_MS,
    );
  }
  function pick(a: Account) {
    setD((x) => ({
      ...x,
      payee: a.payee,
      bank: a.bank,
      branch: a.branch,
      account_no: a.account_no,
      ifsc: a.ifsc,
    }));
    setAccountId(a.id);
    setSug(null);
    setFlash(true);
    setTimeout(() => setFlash(false), 1300);
    refs.current.amount?.focus();
    refs.current.amount?.select();
  }
  function changeAccount() {
    setD((x) => ({
      ...x,
      payee: "",
      bank: "",
      branch: "",
      account_no: "",
      ifsc: "",
    }));
    setAccountId(null);
    setSug(null);
    refs.current.payee?.focus();
  }
  function setField(key: string, value: string) {
    setD((x) => ({
      ...x,
      [key]: key === "ifsc" ? value.toUpperCase() : value,
    }));
    if ((ACC as string[]).includes(key)) openSuggest(key as SearchKey, value);
  }

  const order = [
    "payee",
    "bank",
    "branch",
    "account_no",
    "ifsc",
    "amount",
    ...(more
      ? ["entry_date", "utr", "notes", ...custom.map((c) => c.key)]
      : []),
  ];
  function onKey(e: React.KeyboardEvent<HTMLInputElement>, key: string) {
    if (e.nativeEvent.isComposing) return;
    const isAcc = (ACC as string[]).includes(key);
    if (isAcc && !locked) {
      if (sug && sug.field === key) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSug({ ...sug, idx: Math.min(sug.idx + 1, sug.items.length - 1) });
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSug({ ...sug, idx: Math.max(sug.idx - 1, 0) });
          return;
        }
        if (e.key === "Enter" && sug.items.length) {
          e.preventDefault();
          pick(sug.items[sug.idx]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSug(null);
          return;
        }
      }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.ctrlKey || key === "amount") return void save();
      const next = refs.current[order[order.indexOf(key) + 1]];
      if (next) {
        next.focus();
        next.select();
      } else save();
    }
  }
  function onBlur(key: string) {
    setSug((s) => (s && s.field === key ? null : s));
    if (key === "amount")
      setD((x) => {
        const a = parseAmount(x.amount);
        return a.ok && a.paise != null && x.amount.trim()
          ? { ...x, amount: formatPaise(a.paise) }
          : x;
      });
    if (key === "entry_date")
      setD((x) => {
        const iso = parseDate(x.entry_date);
        return iso ? { ...x, entry_date: fmtDate(iso) } : x;
      });
  }

  // ---------- save a transaction -> saved in DB and shown in the list on the right ----------
  async function save() {
    if (saving.current) return;
    saving.current = true;
    try {
      const payee = d.payee.trim();
      if (!accountId && !payee)
        return fail("Choose or type a beneficiary", "payee");
      const amt = parseAmount(d.amount);
      if (!amt.ok) return fail("Amount is not valid", "amount");
      const date = d.entry_date.trim() ? parseDate(d.entry_date) : todayIso();
      if (!date) {
        setMore(true); // the Date field lives under More fields
        return fail("Date is not valid (use dd/mm/yyyy)", "entry_date");
      }
      const extra: Record<string, string> = {};
      for (const c of custom)
        if (d[c.key]?.trim()) extra[c.key] = d[c.key].trim();
      const input: TxCreate = {
        account_id: accountId,
        account: accountId
          ? undefined
          : {
              payee,
              bank: d.bank,
              branch: d.branch,
              account_no: d.account_no,
              ifsc: d.ifsc,
              remarks: "",
              save_to_master: saveToMaster,
            },
        amount_paise: amt.paise ?? 0,
        reference_no: "", // references now come from reports and imports
        entry_date: date,
        utr: d.utr,
        notes: d.notes,
        extra,
        add_to_preview: true,
      };
      const newAccount = !accountId && saveToMaster;
      const r = await withConfirm(
        (c) => window.api.transactions.create(input, c),
        {
          payee,
          amountPaise: amt.paise ?? 0,
          existingAction: { label: "Use this account", run: pick },
        },
      );
      if (!r) {
        refs.current.amount?.focus();
        return;
      } // cancelled in the dialog
      if (!r.ok)
        return fail(
          r.error ?? "Could not save",
          r.field === "amount_paise" ? "amount" : (r.field ?? "payee"),
        );
      setNewUid(r.data!.uid);
      await reloadRows();
      onTxChanged();
      if (newAccount) onMasterChanged();
      show(`Saved ₹${formatPaise(r.data!.amount_paise)} · ${r.data!.payee}`);
      setD(blank()); // the Date goes back to its default (today) after every saved transaction
      setAccountId(null);
      refs.current.payee?.focus();
    } finally {
      saving.current = false;
    }
  }

  // ---------- list on the right ----------
  async function removeRow(r: PreviewRow) {
    await window.api.preview.remove(r.uid);
    await reloadRows();
    onTxChanged();
    show(`Removed ${r.payee} from the list`, {
      actions: [
        {
          label: "Undo",
          run: async () => {
            await window.api.preview.add([r.uid], r.position);
            await reloadRows();
            onTxChanged();
          },
        },
        ...(canDelete(r.created_at)
          ? [{ label: "Delete transaction…", run: () => setDelRow(r) }]
          : []),
      ],
    });
  }
  async function deleteTx() {
    const r = delRow!;
    setDelRow(null);
    const res = await window.api.transactions.remove(r.uid);
    if (!res.ok)
      return show(res.error ?? "Could not delete", { tone: "error" });
    await reloadRows();
    onTxChanged();
    show("Transaction deleted");
  }
  async function addExisting(uids: string[]) {
    const r = await window.api.preview.add(uids);
    setPickerOpen(false);
    await reloadRows();
    onTxChanged();
    show(
      r.ok && r.data!.added < uids.length
        ? `${r.data!.added} added (${uids.length - r.data!.added} already in the list)`
        : `${uids.length} added to the list`,
    );
  }

  // ---------- report ----------
  async function generate(skipAsk = false) {
    if (!tplId) return show("Choose a template first", { tone: "error" });
    const iso = parseDate(repDate);
    if (!iso)
      return show("Enter the report date as dd/mm/yyyy", { tone: "error" });
    const chq = useCheque ? chequeNo.trim() : "";
    // the template needs a cheque number but the switch is off: ask first
    if (
      !useCheque &&
      !skipAsk &&
      (await window.api.templates.usesCheque(Number(tplId)))
    ) {
      setAskChq(true);
      return;
    }
    const r = await window.api.reports.prepare(
      tplId,
      sortedRows.map((x) => x.uid),
      "",
      refNo.trim(),
      iso,
      false,
      chq,
    );
    if (!r.ok) return show(r.error ?? "Could not generate", { tone: "error" });
    window.api.prefs.set("last_template", String(tplId));
    const warnings = await window.api.templates.lint(tplId);
    setReport({
      prepared: r.data!,
      warnings,
      already: rows.filter((x) => x.report_count > 0).length,
      uids: sortedRows.map((x) => x.uid),
      refNo: refNo.trim(),
      chequeNo: chq,
      reportDate: iso,
    });
  }
  const closeReport = () => {
    window.api.reports.discard();
    setReport(null);
  };

  const field = (
    key: string,
    label: string,
    o: { span2?: boolean; right?: boolean; placeholder?: string } = {},
  ) => {
    const isAcc = (ACC as string[]).includes(key);
    return (
      <div className={`field${o.span2 ? " span2" : ""}`} key={key}>
        <label htmlFor={`f-${key}`}>{label}</label>
        <input
          id={`f-${key}`}
          ref={(el) => {
            refs.current[key] = el;
          }}
          value={d[key] ?? ""}
          autoComplete="off"
          spellCheck={false}
          readOnly={isAcc && locked}
          placeholder={o.placeholder}
          className={o.right ? "num" : ""}
          onChange={(e) => setField(key, e.target.value)}
          onKeyDown={(e) => onKey(e, key)}
          onBlur={() => onBlur(key)}
        />
      </div>
    );
  };

  return (
    <>
      <div className="entry">
        {/* ---------- left: the form ---------- */}
        <section className="panel">
          <header>
            <h3>New transaction</h3>
            <span className="grow" style={{ flex: 1 }} />
            <small>Each box searches its own column</small>
          </header>
          <div className="body">
            {locked && (
              <div className="picked">
                <span>
                  <Icon name="check" className="ic-inline" /> Account from
                  master
                </span>
                <span className="grow" />
                <button className="small" onClick={changeAccount}>
                  Change account
                </button>
              </div>
            )}
            <div className={`fgrid${flash ? " flash" : ""}`}>
              {field("payee", labels.payee + " *", {
                span2: true,
                placeholder: "Type a name to search master…",
              })}
              {field("bank", labels.bank)}
              {field("branch", labels.branch)}
              {field("account_no", labels.account_no)}
              {field("ifsc", labels.ifsc)}
            </div>
            {!locked && d.payee.trim() && (
              <label className="check" style={{ marginBottom: 12 }}>
                <input
                  type="checkbox"
                  checked={saveToMaster}
                  onChange={(e) => setSaveToMaster(e.target.checked)}
                />
                Save this account to master{" "}
                {saveToMaster ? (
                  ""
                ) : (
                  <small>(one-off: not offered in suggestions)</small>
                )}
              </label>
            )}
            <hr className="sep" />
            <div className="fgrid">
              {field("amount", labels.amount_paise + " (₹) *", { right: true })}
            </div>
            <button className="moretoggle" onClick={() => setMore((m) => !m)}>
              <Icon name={more ? "minus" : "add"} className="ic-inline" />{" "}
              {more
                ? "Fewer fields"
                : `More fields (${labels.entry_date}, ${labels.utr}, ${labels.notes}${custom.length ? ", custom" : ""})${d.entry_date.trim() ? ` · ${labels.entry_date}: ${d.entry_date.trim()}` : ""}`}
            </button>
            {more && (
              <div className="fgrid">
                {field("entry_date", labels.entry_date, {
                  placeholder: "dd/mm/yyyy · blank = today",
                })}
                {field("utr", labels.utr)}
                {field("notes", labels.notes)}
                {custom.map((c) => field(c.key, c.label))}
                <div className="span2" style={{ marginBottom: 12 }}>
                  <button className="small" onClick={() => setFieldDlg(true)}>
                    <Icon name="add" className="ic-inline" /> New field
                  </button>{" "}
                  <small>It will appear as a column in Transactions.</small>
                </div>
              </div>
            )}
          </div>
          <footer>
            <div className="savebar">
              <div className="savehint">
                <span>
                  <kbd>Enter</kbd> next box
                </span>
                <span>
                  <kbd>Ctrl</kbd>+<kbd>Enter</kbd> or <kbd>Enter</kbd> on Amount
                  saves
                </span>
              </div>
              <button className="primary" onClick={save}>
                Save transaction
              </button>
            </div>
          </footer>
        </section>

        {/* ---------- right: working list + report ---------- */}
        <section className="panel">
          <header>
            <h3>Report list</h3>
            <span className="badge" style={{ margin: 0 }}>
              {rows.length}
            </span>
            <span style={{ flex: 1 }} />
            <button className="small" onClick={() => setPickerOpen(true)}>
              Add existing…
            </button>
            <button
              className="small danger"
              disabled={!rows.length}
              onClick={() => setAskClear(true)}
            >
              Clear list
            </button>
          </header>
          <div className="pvwrap">
            {rows.length === 0 ? (
              <div className="pvempty">
                Transactions you save appear here.
                <br />
                Use <b>Add existing…</b> to put earlier transactions in the
                list.
              </div>
            ) : (
              <table className="pv">
                <thead>
                  <tr>
                    <th>S.No</th>
                    <th
                      aria-sort={
                        sort?.key === "payee"
                          ? sort.dir === "asc"
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                    >
                      {sortBtn("payee", labels.payee)}
                    </th>
                    <th
                      className="r"
                      aria-sort={
                        sort?.key === "amount"
                          ? sort.dir === "asc"
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                    >
                      {sortBtn("amount", labels.amount_paise)}
                    </th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((r, i) => (
                    <tr
                      key={r.uid}
                      className={r.uid === newUid ? "newrow" : ""}
                    >
                      <td>{i + 1}</td>
                      <td>
                        {r.payee}
                        {detailLine(r) && (
                          <div className="pvsub">{detailLine(r)}</div>
                        )}
                        {r.report_count > 0 && (
                          <span
                            className="tag"
                            title="A report was already generated for this transaction"
                          >
                            <Icon name="check" className="ic-inline" /> report
                          </span>
                        )}
                      </td>
                      <td className="r">{formatPaise(r.amount_paise)}</td>
                      <td>
                        <button
                          className="ghost small icon"
                          title="Remove from list"
                          aria-label="Remove from list"
                          onClick={() => removeRow(r)}
                        >
                          <Icon name="close" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <footer>
            <div className="pvtotal">
              <span className="muted">
                {rows.length} transaction{rows.length === 1 ? "" : "s"} · total
              </span>
              <span className="big">₹{formatPaise(total)}</span>
            </div>
            <div className={`pvform${useCheque ? " has-cheque" : ""}`}>
              <div className="field">
                <div className="pvlabrow">
                  <label className="pvlab" htmlFor="rep-ref">
                    Reference no
                  </label>
                  {lastRef && (
                    <span className="pvchips">
                      <span className="pvlast">
                        Last:{" "}
                        <button
                          type="button"
                          className="linkbtn mono"
                          title="Use the last reference"
                          onClick={() => fillRef(lastRef)}
                        >
                          {lastRef}
                        </button>
                      </span>
                      {nextOne && (
                        <span className="pvnext">
                          Next:{" "}
                          <button
                            type="button"
                            className="linkbtn mono"
                            title="Use the next reference"
                            onClick={() => fillRef(nextOne)}
                          >
                            {nextOne}
                          </button>
                        </span>
                      )}
                    </span>
                  )}
                </div>
                <div className="pvrefbox" ref={refBox}>
                  <input
                    id="rep-ref"
                    value={refNo}
                    maxLength={100}
                    placeholder="e.g. REF-101"
                    onChange={(e) => setRefNo(e.target.value)}
                  />
                  <button
                    type="button"
                    className="ghost pvclock"
                    aria-label="Recent and past references"
                    aria-expanded={recentOpen}
                    title="Recent and past references"
                    onClick={() => setRecentOpen((o) => !o)}
                  >
                    <Icon name="history" />
                  </button>
                  {recentOpen && (
                    <div className="pvmenu" aria-label="References">
                      {nextOne && (
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => fillRef(nextOne)}
                        >
                          <span>Suggested next</span>
                          <span className="mono">{nextOne}</span>
                        </button>
                      )}
                      {lastRef && (
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => fillRef(lastRef)}
                        >
                          <span>Last</span>
                          <span className="mono">{lastRef}</span>
                        </button>
                      )}
                      {recent.length > 1 && (
                        <>
                          <div className="pvmenuhead muted">Recently used</div>
                          {recent.slice(1).map((r) => (
                            <button
                              key={r.ref_no}
                              type="button"
                              className="ghost"
                              onClick={() => fillRef(r.ref_no)}
                            >
                              <span className="mono">{r.ref_no}</span>
                              <span className="muted">
                                {fmtDate(r.report_date)} · {r.item_count} txn
                                {r.item_count === 1 ? "" : "s"}
                              </span>
                            </button>
                          ))}
                        </>
                      )}
                      <button
                        type="button"
                        className="ghost pvmenuall"
                        onClick={() => {
                          setRecentOpen(false);
                          setPastOpen(true);
                        }}
                      >
                        All past references…
                      </button>
                    </div>
                  )}
                  {pastOpen && (
                    <PastRefsDialog
                      onPick={fillRef}
                      onClose={() => setPastOpen(false)}
                    />
                  )}
                </div>
              </div>
              {useCheque && (
                <div className="field">
                  <div className="pvlabrow">
                    <label className="pvlab" htmlFor="rep-chq">
                      Cheque no
                    </label>
                  </div>
                  <div className="pvrefbox" ref={chqBox}>
                    <input
                      id="rep-chq"
                      value={chequeNo}
                      maxLength={100}
                      placeholder="Optional"
                      onChange={(e) => setChequeNo(e.target.value)}
                    />
                    <button
                      type="button"
                      className="ghost pvclock"
                      aria-label="Last cheque numbers"
                      aria-expanded={chqOpen}
                      disabled={!lastChq}
                      title={
                        lastChq
                          ? "Last cheque number"
                          : "Appears after your first saved report with a cheque number"
                      }
                      onClick={() => setChqOpen((o) => !o)}
                    >
                      <Icon name="history" />
                    </button>
                    {chqOpen && (
                      <div className="pvmenu" aria-label="Cheque numbers">
                        {nextChq && (
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => fillChq(nextChq)}
                          >
                            <span>Suggested next</span>
                            <span className="mono">{nextChq}</span>
                          </button>
                        )}
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => fillChq(lastChq)}
                        >
                          <span>Last</span>
                          <span className="mono">{lastChq}</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="field">
                <div className="pvlabrow">
                  <label className="pvlab" htmlFor="rep-date">
                    Date
                  </label>
                </div>
                <input
                  id="rep-date"
                  value={repDate}
                  placeholder="dd/mm/yyyy"
                  onChange={(e) => setRepDate(e.target.value)}
                />
              </div>
            </div>
            {chqWarn.length > 0 && (
              <div className="pvwarn" role="status">
                {chqWarn.join(" ")}
              </div>
            )}
            <div className="pvtpl">
              <div className="pvtplhead">
                <label className="pvlab" htmlFor="rep-tpl">
                  Choose template
                </label>
                {tplSel && (
                  <span className="pvout" title={tplSel.name}>
                    {tplSel.entry_makes}
                  </span>
                )}
              </div>
              <select
                id="rep-tpl"
                value={tplId}
                onChange={(e) =>
                  setTplId(e.target.value ? Number(e.target.value) : "")
                }
              >
                <option value="">Select…</option>
                {tplGroups.map(([format, list]) => (
                  <optgroup key={format} label={format}>
                    {list.map((t) => (
                      <option key={t.id} value={t.id} disabled={!t.has_file}>
                        {t.name}
                        {t.has_file ? "" : " (no file)"}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div className="pvactions">
              <button
                className="primary"
                disabled={!rows.length}
                onClick={() => generate()}
              >
                Generate report
              </button>
            </div>
          </footer>
        </section>
      </div>

      {sug && (
        <SuggestPanel
          items={sug.items}
          idx={sug.idx}
          field={sug.field}
          text={sug.text}
          anchor={sug.rect}
          onPick={pick}
        />
      )}
      {element}
      <Toast t={toast} onClose={hide} />

      {pickerOpen && (
        <Modal
          wide
          title="Add existing transactions to the list"
          onClose={() => setPickerOpen(false)}
          actions={<button onClick={() => setPickerOpen(false)}>Close</button>}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              height: "100%",
            }}
          >
            <TransactionsScreen
              labels={labels}
              refreshKey={0}
              mode="picker"
              onAddToList={addExisting}
            />
          </div>
        </Modal>
      )}
      {askChq && (
        <Modal
          title="Turn on cheque number?"
          onClose={() => setAskChq(false)}
          actions={
            <>
              <button onClick={() => setAskChq(false)}>Cancel</button>
              <button
                onClick={() => {
                  setAskChq(false);
                  generate(true);
                }}
              >
                Generate without it
              </button>
              <button
                autoFocus
                className="primary"
                onClick={() => {
                  setAskChq(false);
                  onUseCheque(true);
                }}
              >
                Turn on
              </button>
            </>
          }
        >
          <p>This template uses a cheque number. Turn it on?</p>
          <p className="muted">
            After you turn it on, type the cheque number in the Cheque no box
            and press Generate report again.
          </p>
        </Modal>
      )}
      {askClear && (
        <AskDialog
          title="Clear the list?"
          danger
          confirmLabel="Clear list"
          onResult={async (ok) => {
            setAskClear(false);
            if (ok) {
              await window.api.preview.clear();
              await reloadRows();
              onTxChanged();
              setRefNo("");
              setChequeNo("");
              setRepDate(fmtDate(todayIso()));
            }
          }}
        >
          <p className="muted">
            The transactions stay saved. Only this list is emptied.
          </p>
        </AskDialog>
      )}
      {delRow && (
        <AskDialog
          title="Delete this transaction?"
          danger
          confirmLabel="Delete"
          onResult={(ok) => (ok ? deleteTx() : setDelRow(null))}
        >
          <p>
            <strong>{delRow.payee}</strong> · ₹
            {formatPaise(delRow.amount_paise)}
          </p>
        </AskDialog>
      )}
      {fieldDlg && (
        <NameDialog
          title="New field"
          initial=""
          onClose={() => setFieldDlg(false)}
          onSubmit={async (n) => {
            const r = await window.api.customColumns.add("transaction", n);
            if (!r.ok) return r.error ?? "Failed";
            setCustom(await window.api.customColumns.list("transaction"));
            return null;
          }}
        />
      )}
      {report && (
        <ReportDialog
          templateId={Number(tplId)}
          uids={report.uids}
          refNo={report.refNo}
          chequeNo={report.chequeNo}
          reportDate={report.reportDate}
          initial={report.prepared}
          warnings={report.warnings}
          already={report.already}
          onSaved={() => {
            onTxChanged();
            loadRecent();
            setChequeNo("");
          }}
          onClose={closeReport}
          onClearList={async () => {
            await window.api.preview.clear();
            await reloadRows();
            onTxChanged();
            setRefNo("");
            setChequeNo("");
            setRepDate(fmtDate(todayIso()));
            closeReport();
          }}
        />
      )}
    </>
  );
}
