import { useCallback, useEffect, useState } from "react";
import type { TxUndoInfo } from "@shared/types";
import AskDialog from "./AskDialog";
import { Toast, useToast } from "./Toast";

const n = (v: number) => v.toLocaleString("en-IN");

/** Undo for the latest import of either kind (one shared stack). Used on the Accounts and Transactions tabs. */
export default function UndoImportButton({
  refreshKey,
  accountsName,
  onUndone,
}: {
  refreshKey: number; // changes whenever imports or data change, so the button re-checks
  accountsName: string; // the user's own name for the accounts tab
  onUndone: () => void; // reload the screens after an undo
}) {
  const [info, setInfo] = useState<TxUndoInfo | null>(null);
  const [open, setOpen] = useState(false);
  const { toast, show, hide } = useToast();

  const load = useCallback(() => {
    window.api.txImport.undoInfo().then(setInfo);
  }, []);

  useEffect(() => {
    load();
  }, [refreshKey, load]);

  function click() {
    if (!info) return;
    if (!info.canUndo)
      return show(
        `${n(info.inReports)} imported transactions are already in saved reports, so this import can no longer be undone`,
        { tone: "error" },
      );
    setOpen(true);
  }

  async function doUndo() {
    setOpen(false);
    const r = await window.api.txImport.undoLast();
    if (!r.ok) return show(r.error ?? "Could not undo", { tone: "error" });
    const d = r.data!;
    const base =
      info?.kind === "master"
        ? `Import undone: ${n(d.accountsRemoved)} accounts removed`
        : `Import undone: ${n(d.transactions)} transactions removed`;
    show(
      base +
        (d.reverted
          ? ` · ${n(d.reverted)} ${accountsName} entries restored`
          : "") +
        (d.accountsKept
          ? ` · ${n(d.accountsKept)} kept because transactions use them`
          : "") +
        (d.revertSkipped
          ? ` · ${n(d.revertSkipped)} ${accountsName} edits kept because you changed them since`
          : ""),
    );
    onUndone();
    load();
  }

  return (
    <>
      {info && (
        <button
          onClick={click}
          title={`Imported ${new Date(info.created_at).toLocaleString("en-IN")} from ${info.file_name}`}
        >
          Undo last import
        </button>
      )}

      {open && info && (
        <AskDialog
          title="Undo the last import?"
          danger
          confirmLabel="Undo import"
          onResult={(ok) => (ok ? doUndo() : setOpen(false))}
        >
          <p>
            <strong>{info.file_name}</strong> · imported{" "}
            {new Date(info.created_at).toLocaleString("en-IN")}
          </p>
          {info.kind === "master" ? (
            <p>
              This removes the {n(info.newAccounts)} accounts it created (any
              that transactions use are kept) and restores the {accountsName}{" "}
              details it changed.
            </p>
          ) : (
            <>
              <p>
                This deletes <b>{n(info.transactions)}</b> imported transactions
                {info.newAccounts
                  ? ` and the ${n(info.newAccounts)} accounts it created`
                  : ""}
                , and restores any {accountsName} details the import changed.
              </p>
              {info.edited > 0 && (
                <div className="notice">
                  {info.edited} of these transactions were edited after the
                  import (for example a UTR was added). Those edits will be lost
                  too.
                </div>
              )}
            </>
          )}
        </AskDialog>
      )}
      <Toast t={toast} onClose={hide} />
    </>
  );
}
