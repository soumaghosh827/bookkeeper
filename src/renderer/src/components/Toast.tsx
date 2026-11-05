import { useCallback, useEffect, useRef, useState } from 'react'

export interface ToastData { text: string; tone?: 'error'; actions?: { label: string; run: () => void }[] }

export function useToast() {
  const [toast, setToast] = useState<ToastData | null>(null)
  const timer = useRef<number>()
  const hide = useCallback(() => setToast(null), [])
  const show = useCallback((text: string, o: Partial<ToastData> & { ms?: number } = {}) => {
    window.clearTimeout(timer.current)
    setToast({ text, tone: o.tone, actions: o.actions })
    timer.current = window.setTimeout(() => setToast(null), o.ms ?? (o.actions ? 7000 : o.tone === 'error' ? 5000 : 2600))
  }, [])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return { toast, show, hide }
}

export function Toast({ t, onClose }: { t: ToastData | null; onClose: () => void }) {
  if (!t) return null
  return (
    <div className={`toast${t.tone === 'error' ? ' error' : ''}`} role="status">
      <span>{t.text}</span>
      {t.actions?.map((a) => <button key={a.label} onClick={() => { a.run(); onClose() }}>{a.label}</button>)}
    </div>
  )
}
