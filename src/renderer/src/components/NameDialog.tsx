import { useState } from 'react'
import Modal from './Modal'

/** Small text prompt (window.prompt does not exist in Electron). onSubmit returns an error message or null. */
export default function NameDialog({ title, initial, onSubmit, onClose }: {
  title: string; initial: string; onSubmit: (name: string) => Promise<string | null>; onClose: () => void
}) {
  const [v, setV] = useState(initial)
  const [err, setErr] = useState('')
  const go = async () => { const e = await onSubmit(v); e ? setErr(e) : onClose() }
  return (
    <Modal title={title} onClose={onClose} actions={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={go}>Save</button></>}>
      <div className="field">
        <input autoFocus maxLength={40} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
      </div>
      {err && <p className="error">{err}</p>}
    </Modal>
  )
}
