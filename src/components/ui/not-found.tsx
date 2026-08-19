import { Link } from '@tanstack/react-router'

export function NotFound() {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <p className="text-sm font-medium text-zinc-900">Page not found</p>
      <p className="text-sm text-zinc-500">The page you are looking for does not exist.</p>
      <Link to="/" className="mt-2 text-sm font-medium text-zinc-900 underline underline-offset-4">
        Back to Home
      </Link>
    </div>
  )
}
