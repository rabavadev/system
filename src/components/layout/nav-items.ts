import type { LucideIcon } from 'lucide-react'
import {
  AtSign,
  BarChart3,
  Brain,
  CircleCheck,
  Files,
  FlaskConical,
  Home,
  Megaphone,
  MessageSquare,
  Package,
  Settings,
  Tag,
  Workflow,
} from 'lucide-react'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

export const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/brands', label: 'Brands', icon: Tag },
  { to: '/chat', label: 'Chat', icon: MessageSquare },
  { to: '/products', label: 'Products', icon: Package },
  { to: '/accounts', label: 'Accounts', icon: AtSign },
  { to: '/campaigns', label: 'Campaigns', icon: Megaphone },
  { to: '/research', label: 'Research', icon: FlaskConical },
  { to: '/memory', label: 'Memory', icon: Brain },
  { to: '/workflows', label: 'Workflows', icon: Workflow },
  { to: '/approvals', label: 'Approvals', icon: CircleCheck },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/files', label: 'Files', icon: Files },
  { to: '/settings', label: 'Settings', icon: Settings },
]
