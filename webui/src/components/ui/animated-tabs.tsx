'use client'

import {
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { motion, useReducedMotion } from 'motion/react'

import { cn } from '@/lib/utils'

export type AnimatedTabOption<T extends string> = {
  value: T
  label: string
  controls?: string
  id?: string
}

type AnimatedTabsProps<T extends string> = {
  tabs: readonly AnimatedTabOption<T>[]
  value: T
  onValueChange: (value: T) => void
  ariaLabel: string
  className?: string
}

/**
 * Controlled RunBuild adaptation of Aceternity's shared-layout tab indicator.
 * Business state and panel content remain owned by the calling workspace.
 */
export const AnimatedTabs = <T extends string>({
  tabs,
  value,
  onValueChange,
  ariaLabel,
  className,
}: AnimatedTabsProps<T>) => {
  const reducedMotion = useReducedMotion()
  const instanceId = useId().replace(/:/g, '')
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const moveFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex = index
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = tabs.length - 1
    else return

    event.preventDefault()
    const nextTab = tabs[nextIndex]
    if (!nextTab) return
    onValueChange(nextTab.value)
    tabRefs.current[nextIndex]?.focus()
  }

  return (
    <div className={cn('aceternity-tabs', className)} role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab, index) => {
        const active = tab.value === value
        return (
          <button
            key={tab.value}
            ref={(node) => { tabRefs.current[index] = node }}
            id={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={tab.controls}
            tabIndex={active ? 0 : -1}
            className={cn('aceternity-tab', active && 'is-active')}
            onClick={() => onValueChange(tab.value)}
            onKeyDown={(event) => moveFocus(event, index)}
          >
            {active && (
              <motion.span
                layoutId={`aceternity-tab-indicator-${instanceId}`}
                initial={false}
                transition={reducedMotion
                  ? { duration: 0 }
                  : { type: 'spring', stiffness: 440, damping: 34, mass: 0.7 }}
                className="aceternity-tab-indicator"
                aria-hidden="true"
              />
            )}
            <span className="aceternity-tab-label">{tab.label}</span>
          </button>
        )
      })}
    </div>
  )
}
