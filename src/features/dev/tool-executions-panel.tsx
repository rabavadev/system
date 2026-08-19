import { useQuery } from '@tanstack/react-query'

import { type DevToolExecution, getDevToolExecutions } from './server'

/**
 * Development-only tool trace: recent tool.execution.* events with the
 * requesting agent version, capability/risk metadata, safe argument
 * summaries, duration and status. Rendered on /dev-context only.
 */
export function ToolExecutionsPanel() {
  const executions = useQuery({
    queryKey: ['dev-tool-executions'],
    queryFn: () => getDevToolExecutions(),
    refetchInterval: 5000,
  })

  const rows = executions.data ?? []

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-zinc-900">Tool executions (recent)</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-400">No tool executions recorded yet.</p>
      ) : (
        <ul className="flex flex-col gap-1 font-mono text-xs">
          {rows.map((row) => (
            <ExecutionRow key={row.id} row={row} />
          ))}
        </ul>
      )}
    </section>
  )
}

function ExecutionRow({ row }: { row: DevToolExecution }) {
  const failed = row.eventType.endsWith('failed')
  const args = Object.entries(row.argsSummary)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-zinc-100 py-1 last:border-0">
      <span className={failed ? 'font-semibold text-red-500' : 'font-semibold text-emerald-600'}>
        {row.eventType.replace('tool.execution.', '')}
      </span>
      <span className="text-zinc-400">{row.occurredAt.slice(11, 19)}Z</span>
      {row.toolKey && <span className="text-zinc-900">{row.toolKey}</span>}
      {row.category && <span className="text-zinc-500">{row.category}</span>}
      {row.risk.length > 0 && <span className="text-zinc-400">risk:{row.risk.join('+')}</span>}
      {row.requiredCapability && (
        <span className="text-zinc-400">cap:{row.requiredCapability}</span>
      )}
      {args && <span className="text-zinc-500">{args}</span>}
      {row.durationMs !== null && <span className="text-zinc-500">{row.durationMs}ms</span>}
      {row.errorCode && <span className="text-red-500">{row.errorCode}</span>}
      {row.executionId && <span className="text-zinc-300">id:{row.executionId.slice(0, 8)}</span>}
    </li>
  )
}
