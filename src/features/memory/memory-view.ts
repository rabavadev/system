import type { MemoryListItem } from './server'

/** Client-only grouping/filtering for the Memory page. No ranking logic lives here. */

export type MemoryTab = 'all' | 'facts' | 'verified' | 'review' | 'temporary' | 'history'

export const MEMORY_TABS: { id: MemoryTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'facts', label: 'Important Facts' },
  { id: 'verified', label: 'Verified Learnings' },
  { id: 'review', label: 'Needs Review' },
  { id: 'temporary', label: 'Temporary' },
  { id: 'history', label: 'Archived' },
]

export function memoriesForTab(memories: MemoryListItem[], tab: MemoryTab): MemoryListItem[] {
  switch (tab) {
    case 'facts':
      return memories.filter(
        (memory) => memory.status === 'active' && memory.memoryClass === 'permanent_fact',
      )
    case 'verified':
      return memories.filter(
        (memory) => memory.status === 'active' && memory.memoryClass === 'verified_learning',
      )
    case 'review':
      return memories.filter(
        (memory) => memory.status === 'active' && memory.memoryClass === 'proposed_learning',
      )
    case 'temporary':
      return memories.filter(
        (memory) => memory.status === 'active' && memory.memoryClass === 'temporary_context',
      )
    case 'history':
      return memories.filter((memory) => memory.status !== 'active')
    default:
      return memories.filter((memory) => memory.status === 'active')
  }
}

export function filterMemories(
  memories: MemoryListItem[],
  filters: {
    query?: string | undefined
    scopeValue?: string | undefined
    freshness?: string | undefined
  },
): MemoryListItem[] {
  const query = filters.query?.trim().toLowerCase() ?? ''
  return memories.filter((memory) => {
    if (query && !memory.content.toLowerCase().includes(query)) return false
    if (filters.scopeValue) {
      const [scopeType, scopeId] = filters.scopeValue.split(':')
      if (scopeType === 'workspace') {
        if (memory.scopeType !== 'workspace') return false
      } else if (memory.scopeType !== scopeType || memory.scopeId !== scopeId) {
        return false
      }
    }
    if (filters.freshness === 'current' && memory.freshness !== 'current') return false
    if (filters.freshness === 'expired' && memory.freshness !== 'expired') return false
    return true
  })
}

export function formatMemoryDate(value: string | null): string {
  if (!value) return 'Not set'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value))
}

export function scopeValue(memory: Pick<MemoryListItem, 'scopeType' | 'scopeId'>): string {
  return memory.scopeType === 'workspace' ? 'workspace' : `${memory.scopeType}:${memory.scopeId}`
}
