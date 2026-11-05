import { useState } from 'react'
import type { AppState } from '@shared/types'

type Mode = 'main' | 'recover' | 'show-key'

export default function AuthScreen({ state, onDone }: { state: AppState; onDone: () => void }) {
  const [mode, setMode] = useState<Mode>('main')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [rk, setRk] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [recoveryKey, setRecoveryKey] = useState('')
  const [saved, setSaved] = useState(false)
  const creating = state === 'no-vault'

  async function submit() {
    if (busy) return
    setErr(''); setBusy(true)
    try {
      if (creating) {
        if (pw !== pw2) return setErr('Passwords do not match')
        const r = await window.api.vault.create(pw)
        if (!r.ok) return setErr(r.error ?? 'Could not create')
        setRecoveryKey(r.data!.recoveryKey); setMode('show-key')
      } else if (mode === 'recover') {
        if (pw !== pw2) return setErr('Passwords do not match')
        const r = await window.api.vault.unlockWithRecoveryKey(rk, pw)
        r.ok ? onDone() : setErr(r.error ?? 'Failed')
      } else {
        const r = await window.api.vault.unlock(pw)
        r.ok ? onDone() : setErr(r.error ?? 'Failed')
      }
    } finally { setBusy(false) }
  }

  // Shown once after setup. TODO: "skip" path (keep an encrypted copy in the DB, max 2 views, reminder banner).
  if (mode === 'show-key') {
    return (
      <div className="center"><div className="card auth">
        <h3>Save your recovery key</h3>
        <p className="muted">This is the only way back in if you forget your password. Write it down or print it and keep it somewhere safe.</p>
        <p className="rk">{recoveryKey}</p>
        <p style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <button onClick={() => window.print()}>Print</button>
          <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved my recovery key</label>
        </p>
        <button className="primary" disabled={!saved} onClick={onDone}>Continue</button>
      </div></div>
    )
  }

  return (
    <div className="center"><div className="card auth">
      <h3>{creating ? 'Create master password' : mode === 'recover' ? 'Reset with recovery key' : 'Unlock BookKeeper'}</h3>
      {creating && <p className="muted">Minimum 8 characters. Your data is encrypted with it and never leaves this computer.</p>}
      {mode === 'recover' && <div className="field"><label>Recovery key</label><input value={rk} onChange={(e) => setRk(e.target.value)} className="mono" /></div>}
      <div className="field"><label>{mode === 'recover' ? 'New password' : 'Password'}</label>
        <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !creating && mode === 'main' && submit()} /></div>
      {(creating || mode === 'recover') && <div className="field"><label>Confirm password</label><input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} /></div>}
      {err && <p className="error">{err}</p>}
      <button className="primary" disabled={busy} onClick={submit}>{creating ? 'Create' : mode === 'recover' ? 'Reset & unlock' : 'Unlock'}</button>
      {!creating && <p style={{ marginTop: 12 }}><a href="#" onClick={(e) => { e.preventDefault(); setErr(''); setMode(mode === 'recover' ? 'main' : 'recover') }}>{mode === 'recover' ? 'Back' : 'Forgot password?'}</a></p>}
    </div></div>
  )
}
