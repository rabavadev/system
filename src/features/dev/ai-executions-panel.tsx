import { useQuery } from '@tanstack/react-query'

import { type DevAiExecution, getDevAiExecutions } from './server'

/**
 * Development-only AI execution inspector: recent ai.execution.* events
 * (execution id, agent version, provider/model, latency, usage, status).
 * Rendered on /dev-context only; never part of the production UI.
 */
export function AiExecutionsPanel() {
  const executions = useQuery({
    queryKey: ['dev-ai-executions'],
    queryFn: () => getDevAiExecutions(),
    refetchInterval: 5000,
  })

  const rows = executions.data ?? []

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-zinc-900">AI executions (recent)</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-400">
          No AI executions recorded yet. Send a message in Chat to trigger Chief.
        </p>
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

function ExecutionRow({ row }: { row: DevAiExecution }) {
  const failed = row.eventType.endsWith('failed')
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-zinc-100 py-1 last:border-0">
      <span className={failed ? 'font-semibold text-red-500' : 'font-semibold text-emerald-600'}>
        {row.eventType.replace('ai.execution.', '')}
      </span>
      <span className="text-zinc-400">{row.occurredAt.slice(11, 19)}Z</span>
      {row.provider && <span className="text-zinc-500">{row.provider}</span>}
      {row.model && <span className="text-zinc-900">{row.model}</span>}
      {row.latencyMs !== null && <span className="text-zinc-500">{row.latencyMs}ms</span>}
      {row.attempts !== null && row.attempts > 1 && (
        <span className="text-amber-600">{row.attempts} attempts</span>
      )}
      {row.usage?.totalTokens != null && (
        <span className="text-zinc-500">{row.usage.totalTokens} tok</span>
      )}
      {row.scopeSource && <span className="text-zinc-400">scope:{row.scopeSource}</span>}
      {row.errorCode && <span className="text-red-500">{row.errorCode}</span>}
      {row.agentVersionId && (
        <span className="text-zinc-300">v:{row.agentVersionId.slice(0, 8)}</span>
      )}
    </li>
  )
}
