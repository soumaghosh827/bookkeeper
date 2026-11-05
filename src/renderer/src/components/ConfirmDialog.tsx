import { useState } from 'react'
import type { Account, ConfirmKind } from '@shared/types'
import { formatPaise, parseAmount, rupeesInWords } from '@shared/format'
import Modal from './Modal'

export interface DialogInfo {
  kinds: ConfirmKind[]
  title?: string
  payee?: string
  amountPaise?: number | null
  existing?: Account[]
  existingAction?: { label: string; run: (a: Account) => void } // e.g. "Use this record"
}

const TEXT: Record<ConfirmKind, string> = {
  zero: 'The amount is zero.',
  duplicate: 'A transaction with the same beneficiary, amount, date and reference no already exists.',
  highValue: 'This is a high-value payment.',
  duplicateAccount: 'A record with this account number already exists. You may want to edit that record instead of creating a near-duplicate.',
  similarAccount: 'A record with the same beneficiary and IFSC already exists.'
}

export default function ConfirmDialog({ info, onResult }: { info: DialogInfo; onResult: (ok: boolean) => void }) {
  const [typed, setTyped] = useState('')
  const high = info.kinds.includes('highValue')
  const p = parseAmount(typed)
  const typedOk = !high || (p.ok && p.paise === info.amountPaise)
  const saveLabel = info.kinds.some((k) => k === 'duplicateAccount' || k === 'similarAccount') ? 'Save anyway' : 'Confirm'

  return (
    <Modal
      title={info.title ?? 'Please confirm'}
      onClose={() => onResult(false)}
      actions={<>
        <button onClick={() => onResult(false)}>Cancel</button>
        <button className="primary" autoFocus={!high} disabled={!typedOk} onClick={() => onResult(true)}>{saveLabel}</button>
      </>}
    >
      {info.payee && <p><strong>{info.payee}</strong></p>}
      {info.kinds.map((k) => <div key={k} className="notice" style={{ marginBottom: 8 }}>{TEXT[k]}</div>)}
      {!!info.existing?.length && (
        <div className="existing">
          {info.existing.map((a) => (
            <div key={a.id}>
              <span className="grow"><strong>{a.payee}</strong> · {a.bank} {a.branch} · <span className="mono">{a.account_no} {a.ifsc}</span></span>
              {info.existingAction && <button className="small" onClick={() => { info.existingAction!.run(a); onResult(false) }}>{info.existingAction.label}</button>}
            </div>
          ))}
        </div>
      )}
      {high && (
        <>
          <p className="big">₹{formatPaise(info.amountPaise ?? 0)}<br /><small>{rupeesInWords(info.amountPaise ?? 0)}</small></p>
          <div className="field">
            <label>Type the amount again to confirm</label>
            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && typedOk && onResult(true)} />
          </div>
        </>
      )}
    </Modal>
  )
}
