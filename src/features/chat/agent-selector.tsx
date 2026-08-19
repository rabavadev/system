import { Bot } from 'lucide-react'

import type { ChatAgentOption } from './server'

/**
 * Who answers the next message. The user picks WHO; the system decides HOW
 * (provider/model are never exposed here). Selection lives in the URL
 * (?agent=<id>) so refresh and sharing behave sensibly.
 *
 * Disabled, archived, external and router agents stay visible for context
 * but cannot be picked for a new execution.
 */
export function AgentSelector({
  agents,
  selectedId,
  onChange,
  disabled,
}: {
  agents: ChatAgentOption[]
  selectedId: string
  onChange: (agentId: string) => void
  disabled?: boolean
}) {
  const selectable = agents.filter((agent) => agent.status !== 'archived')
  return (
    <label className="flex items-center gap-1.5 text-xs text-zinc-500">
      <Bot className="size-3.5 text-zinc-400" strokeWidth={1.75} />
      <select
        value={selectedId}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-label="Choose who answers"
        className="rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-xs font-medium text-zinc-700 focus:border-zinc-400 focus:outline-none disabled:text-zinc-300"
      >
        {selectable.map((agent) => (
          <option key={agent.id} value={agent.id} disabled={!agent.selectable}>
            {agent.name}
            {agent.selectable
              ? ''
              : agent.status === 'disabled'
                ? ' (disabled)'
                : ' (not available yet)'}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * Resolve the selected agent from URL state. Unknown, disabled or otherwise
 * unselectable values fall back cleanly to Chief (then any selectable).
 */
export function resolveSelectedAgent(
  agents: ChatAgentOption[],
  requestedId: string | undefined,
): ChatAgentOption | null {
  const selectable = agents.filter((agent) => agent.selectable)
  if (requestedId) {
    const requested = selectable.find((agent) => agent.id === requestedId)
    if (requested) {
      return requested
    }
  }
  return (
    selectable.find((agent) => agent.name === 'Chief' && agent.origin === 'builtin') ??
    selectable[0] ??
    null
  )
}
