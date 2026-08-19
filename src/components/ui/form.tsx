import type { ReactNode } from 'react'

/** Shared input styling so every form looks the same. */
export const inputClass =
  'w-full rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none'

interface FieldProps {
  label: string
  htmlFor?: string
  hint?: string
  children: ReactNode
}

/** Labelled form field wrapper. */
export function Field({ label, htmlFor, hint, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-zinc-700">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-zinc-400">{hint}</p> : null}
    </div>
  )
}

/** Inline form error, shown under the fields. */
export function FormError({ message }: { message: string | null }) {
  if (!message) {
    return null
  }
  return <p className="rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-600">{message}</p>
}
