import type { PropsWithChildren } from 'react'

import { cn } from '@/lib/utils'

type DotBackgroundProps = PropsWithChildren<{
  className?: string
}>

export const DotBackground = ({ children, className }: DotBackgroundProps) => (
  <div className={cn('dot-background', className)}>
    <div className="dot-background-pattern" aria-hidden="true" />
    <div className="dot-background-content">{children}</div>
  </div>
)
