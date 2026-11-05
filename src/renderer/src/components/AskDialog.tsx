import type { ReactNode } from 'react'
import Modal from './Modal'

export default function AskDialog({ title, children, confirmLabel = 'Confirm', danger, onResult }: {
  title: string; children: ReactNode; confirmLabel?: string; danger?: boolean; onResult: (ok: boolean) => void
}) {
  return (
    <Modal title={title} onClose={() => onResult(false)} actions={<>
      <button autoFocus onClick={() => onResult(false)}>Cancel</button>
      <button className={danger ? 'danger' : 'primary'} onClick={() => onResult(true)}>{confirmLabel}</button>
    </>}>{children}</Modal>
  )
}
