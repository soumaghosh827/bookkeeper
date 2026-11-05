import { useCallback, useEffect, useState } from 'react'
import { FIELD_KEYS, type CustomColumn, type Labels, type Scope } from '@shared/types'
import { DENSITIES, THEMES } from '@/lib/theme'
import NameDialog from '@/components/NameDialog'
import { Toast, useToast } from '@/components/Toast'

function Columns({ scope, title, onChanged }: { scope: Scope; title: string; onChanged: () => void }) {
  const [cols, setCols] = useState<CustomColumn[]>([])
  const [ren, setRen] = useState<CustomColumn | null>(null)
  const load = useCallback(() => window.api.customColumns.list(scope, true).then(setCols), [scope])
  useEffect(() => { load() }, [load])
  const act = async (p: Promise<unknown>) => { await p; await load(); onChanged() }
  const move = (i: number, dir: -1 | 1) => {
    const live = cols.filter((c) => !c.archived).map((c) => c.key), k = cols[i].key, a = live.indexOf(k), b = a + dir
    if (a < 0 || b < 0 || b >= live.length) return
    ;[live[a], live[b]] = [live[b], live[a]]
    act(window.api.customColumns.reorder(scope, live))
  }
  return (
    <div style={{ marginBottom: 16 }}>
      <strong>{title}</strong>
      {cols.length === 0 && <p className="muted">No custom columns. Add one from the ＋ in the table header.</p>}
      {cols.map((c, i) => (
        <div key={c.key} className={`colrow${c.archived ? ' arch' : ''}`}>
          <span className="grow">{c.label}{c.archived ? ' (hidden)' : ''}</span>
          {!c.archived && <><button className="small" onClick={() => move(i, -1)}>↑</button><button className="small" onClick={() => move(i, 1)}>↓</button><button className="small" onClick={() => setRen(c)}>Rename</button></>}
          <button className="small" onClick={() => act(window.api.customColumns.archive(c.key, !c.archived))}>{c.archived ? 'Show again' : 'Hide'}</button>
        </div>
      ))}
      {ren && <NameDialog title="Rename column" initial={ren.label} onClose={() => setRen(null)} onSubmit={async (n) => { const r = await window.api.customColumns.rename(ren.key, n); if (!r.ok) return r.error ?? 'Failed'; await load(); onChanged(); return null }} />}
    </div>
  )
}

export default function SettingsScreen({ labels, masterName, theme, density, onLabels, onMasterName, onTheme, onColumnsChanged }: {
  labels: Labels; masterName: string; theme: string; density: string
  onLabels: () => void; onMasterName: (n: string) => void; onTheme: (theme: string, density: string) => void; onColumnsChanged: () => void
}) {
  const [mname, setMname] = useState(masterName)
  const [backup, setBackup] = useState('')
  const { toast, show, hide } = useToast()

  async function saveLabel(k: (typeof FIELD_KEYS)[number], v: string, el: HTMLInputElement) {
    if (v.trim() === labels[k]) return
    const r = await window.api.labels.set(k, v)
    if (!r.ok) { show(r.error ?? 'Failed', { tone: 'error' }); el.value = labels[k] } else { onLabels(); show('Name saved') }
  }
  async function doBackup() {
    const r = await window.api.backup.create()
    if (r.ok) setBackup(`Backup saved: ${r.data!.path}`); else if (r.error !== 'Cancelled') show(r.error ?? 'Backup failed', { tone: 'error' })
  }

  return (
    <>
      <div className="toolbar"><h2>Settings</h2></div>
      <div className="settings">
        <div className="card">
          <h3>Appearance</h3>
          <div className="row" style={{ maxWidth: 520 }}>
            <div className="field"><label>Theme</label><select value={theme} onChange={(e) => onTheme(e.target.value, density)}>{THEMES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></div>
            <div className="field"><label>Row density</label><select value={density} onChange={(e) => onTheme(theme, e.target.value)}>{DENSITIES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></div>
          </div>
        </div>

        <div className="card">
          <h3>Names</h3>
          <div className="field" style={{ maxWidth: 320 }}>
            <label>Name of the master tab (you can also double-click the tab)</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={mname} maxLength={40} onChange={(e) => setMname(e.target.value)} />
              <button onClick={() => mname.trim() && onMasterName(mname.trim())}>Save</button>
            </div>
          </div>
          <p className="muted">Column names. Renaming never breaks Word placeholders.</p>
          <div className="labelgrid">
            {FIELD_KEYS.map((k) => (
              <div className="field" key={k}>
                <label>{k.replace(/_paise$/, '').replace(/_/g, ' ')}</label>
                <input key={labels[k]} defaultValue={labels[k]} maxLength={40} onBlur={(e) => saveLabel(k, e.target.value, e.currentTarget)} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h3>Custom columns</h3>
          <Columns scope="account" title={`${masterName} columns`} onChanged={onColumnsChanged} />
          <Columns scope="transaction" title="Transaction columns" onChanged={onColumnsChanged} />
        </div>

        <div className="card">
          <h3>Backup</h3>
          <p className="muted">Saves an encrypted copy of your data (and its key file) to a place you choose, e.g. a pen drive. Use it to move to a new PC; your recovery key opens it too.</p>
          <button className="primary" onClick={doBackup}>Back up now…</button>
          {backup && <p className="notice ok" style={{ marginTop: 8 }}>{backup}</p>}
        </div>
      </div>
      <Toast t={toast} onClose={hide} />
    </>
  )
}
