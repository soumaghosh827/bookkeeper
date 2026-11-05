import type { Account, SearchKey } from '@shared/types'
import { fmtDate, formatPaise } from '@shared/format'

function Hl({ text, tok }: { text: string; tok: string }) {
  if (!tok || !text) return <>{text}</>
  const i = text.toLowerCase().indexOf(tok.toLowerCase())
  return i < 0 ? <>{text}</> : <>{text.slice(0, i)}<mark>{text.slice(i, i + tok.length)}</mark>{text.slice(i + tok.length)}</>
}

/** Horizontal suggestion rows. Only the column being searched is highlighted (per-field search). */
export default function SuggestPanel({ items, idx, field, text, anchor, onPick }: {
  items: Account[]; idx: number; field: SearchKey; text: string; anchor: DOMRect; onPick: (a: Account) => void
}) {
  const width = Math.min(1000, window.innerWidth - 24)
  const left = Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))
  const below = window.innerHeight - anchor.bottom > 300
  const pos = below ? { top: anchor.bottom + 3 } : { bottom: window.innerHeight - anchor.top + 3 }
  const hl = (k: SearchKey, v: string) => <Hl text={v} tok={field === k ? text.trim() : ''} />
  return (
    <div className="sug" style={{ left, width, ...pos }} onMouseDown={(e) => e.preventDefault()}>
      <div className="sug-row head"><div>Beneficiary</div><div>Bank</div><div>Branch</div><div>Account No</div><div>IFSC</div><div>Remarks</div><div>Last used</div></div>
      {items.length === 0 && <div className="sug-none">No match in master. Keep typing to add a new account.</div>}
      {items.map((a, i) => (
        <div key={a.id} className={`sug-row${i === idx ? ' sel' : ''}`} onClick={() => onPick(a)}>
          <div>{hl('payee', a.payee)}</div>
          <div>{hl('bank', a.bank)}</div>
          <div>{hl('branch', a.branch)}</div>
          <div className="mono">{hl('account_no', a.account_no)}</div>
          <div className="mono">{hl('ifsc', a.ifsc)}</div>
          <div className="muted">{a.remarks}</div>
          <div className="faint">{a.last_used_at ? `${fmtDate(a.last_used_at)} · ₹${formatPaise(a.last_amount_paise)}` : ''}{a.use_count ? ` · ${a.use_count}×` : ''}</div>
        </div>
      ))}
      <div className="sug-foot"><kbd>↑</kbd> <kbd>↓</kbd> move · <kbd>Enter</kbd> pick · <kbd>Esc</kbd> close · <kbd>Alt</kbd>+<kbd>↓</kbd> show all</div>
    </div>
  )
}
