import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

const stack: number[] = [] // only the top-most modal reacts to Esc
let nextId = 1

export default function Modal({ title, children, actions, onClose, wide, locked }: {
  title?: string; children: ReactNode; actions?: ReactNode; onClose?: () => void; wide?: boolean
  locked?: boolean // work is in progress: Esc does nothing and the cross is dimmed
}) {
  const id = useRef(nextId++).current
  const close = useRef(onClose)
  close.current = onClose
  const lock = useRef(locked)
  lock.current = locked
  useEffect(() => {
    stack.push(id)
    const f = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stack[stack.length - 1] === id) {
        e.preventDefault()
        if (!lock.current) close.current?.()
      }
    }
    window.addEventListener('keydown', f)
    return () => { window.removeEventListener('keydown', f); stack.splice(stack.indexOf(id), 1) }
  }, [id])
  return (
    <div className="overlay">
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        {(title || onClose) && (
          <div className="dlg-head">
            {title && <h3>{title}</h3>}
            {onClose && (
              <button type="button" className="dlg-x" aria-label="Close" title={locked ? 'Please wait…' : 'Close'} disabled={locked} onClick={() => close.current?.()}>
                <X size={20} strokeWidth={2.25} />
              </button>
            )}
          </div>
        )}
        <div className="dlg-body">{children}</div>
        {actions && <div className="dlg-actions">{actions}</div>}
      </div>
    </div>
  )
}