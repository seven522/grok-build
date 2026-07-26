import type { ReactNode } from 'react'
import { IconChevronDown } from '@tabler/icons-react'

import { cn } from '@/lib/utils'

type SidebarGroupHeaderProps = {
  actions?: ReactNode
  className?: string
  controlsId: string
  expanded: boolean
  icon: ReactNode
  label: string
  onToggle: () => void
}

export const SidebarGroupHeader = ({
  actions,
  className,
  controlsId,
  expanded,
  icon,
  label,
  onToggle,
}: SidebarGroupHeaderProps) => (
  <div className={cn('sidebar-group-heading', className)}>
    <button
      type="button"
      className="sidebar-group-toggle"
      aria-expanded={expanded}
      aria-controls={controlsId}
      onClick={onToggle}
    >
      <span className="sidebar-group-label">
        <span className="sidebar-group-icon" aria-hidden="true">{icon}</span>
        <span>{label}</span>
        <IconChevronDown
          className={cn('sidebar-group-chevron', expanded && 'is-expanded')}
          size={15}
          stroke={1.8}
          aria-hidden="true"
        />
      </span>
    </button>
    {actions && <div className="sidebar-group-actions">{actions}</div>}
  </div>
)
