import { X } from 'lucide-react'
import { type ReactNode, useEffect } from 'react'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
}

/** Simple centered dialog for create/edit forms. */
export function Modal({ title, onClose, children }: ModalProps) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/30 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md rounded-lg border border-zinc-200 bg-white shadow-lg"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </div>
        <div className="px-4 py-4">{children}</div>
      </div>
    </div>
  )
}
