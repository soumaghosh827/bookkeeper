import type { ReactNode } from "react";

/**
 * The frame of every import screen (Accounts and Transactions): title bar with Cancel/Close, content, error line.
 * `review` switches to the wide full-height layout used while the checked rows are shown.
 */
export default function ImportShell({
  title,
  closeLabel = "Cancel",
  onClose,
  busy = false,
  review = false,
  error = "",
  actions,
  children,
}: {
  title: string;
  closeLabel?: string;
  onClose: () => void;
  busy?: boolean;
  review?: boolean;
  error?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`import${review ? " is-review" : ""}`}>
      <div className="toolbar">
        <h2>{title}</h2>
        <span className="grow" />
        {actions}
        <button disabled={busy} onClick={onClose}>
          {closeLabel}
        </button>
      </div>
      {children}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
