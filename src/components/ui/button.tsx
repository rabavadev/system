import type { ButtonHTMLAttributes } from 'react'

import { cn } from '~/lib/utils'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-zinc-900 text-white hover:bg-zinc-700 disabled:bg-zinc-300',
  secondary:
    'border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 hover:text-zinc-900 disabled:text-zinc-300',
  ghost: 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:text-zinc-300',
  danger: 'border border-red-200 bg-white text-red-600 hover:bg-red-50 disabled:text-red-300',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
}

/** The one button. Variants cover every action style used in the app. */
export function Button({ variant = 'primary', className, type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed',
        VARIANT_CLASSES[variant],
        className,
      )}
      {...props}
    />
  )
}
