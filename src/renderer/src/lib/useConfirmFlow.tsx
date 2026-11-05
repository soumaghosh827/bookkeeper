import { useState } from 'react'
import type { Account, Confirmations, Result } from '@shared/types'
import ConfirmDialog, { type DialogInfo } from '@/components/ConfirmDialog'

type Info = Omit<DialogInfo, 'kinds' | 'existing'>

/**
 * The backend says what it needs ("zero", "highValue", "duplicateAccount"...), we ask the user, then resend
 * with those confirmations set. Returns null when the user cancelled.
 */
export function useConfirmFlow() {
  const [dlg, setDlg] = useState<(DialogInfo & { res: (ok: boolean) => void }) | null>(null)

  async function withConfirm<T>(call: (c: Confirmations) => Promise<Result<T>>, info: Info): Promise<Result<T> | null> {
    let conf: Confirmations = {}
    for (let n = 0; n < 6; n++) {
      const r = await call(conf)
      if (!r.needs?.length) return r
      const ok = await new Promise<boolean>((res) => setDlg({ ...info, kinds: r.needs!, existing: r.existing as Account[] | undefined, res }))
      setDlg(null)
      if (!ok) return null
      for (const k of r.needs) conf = { ...conf, [k]: true }
    }
    return null
  }
  const element = dlg ? <ConfirmDialog info={dlg} onResult={dlg.res} /> : null
  return { withConfirm, element }
}
