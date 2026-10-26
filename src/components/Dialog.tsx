import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string
  children: ReactNode
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    dialog.dataset.motionInput =
      document.documentElement.dataset.motionInput || 'keyboard'
    if (!dialog.open) dialog.showModal()
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [])
  return (
    <dialog
      ref={ref}
      id="modal"
      aria-labelledby="modalTitle"
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect()
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose()
        }
      }}
    >
      <div className="modal-top">
        <h2 id="modalTitle">{title}</h2>
        <button id="closeModal" aria-label="Close dialog" onClick={onClose}>
          ×
        </button>
      </div>
      <div id="modalBody">{children}</div>
    </dialog>
  )
}
