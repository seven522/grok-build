'use client'

import {
  createContext,
  useContext,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { motion } from 'motion/react'

import { cn } from '@/lib/utils'

type SidebarContextValue = {
  open: boolean
  setOpen: (open: boolean) => void
  animate: boolean
}

const SidebarContext = createContext<SidebarContextValue | null>(null)

export const useSidebar = () => {
  const context = useContext(SidebarContext)
  if (!context) throw new Error('useSidebar must be used within a SidebarProvider')
  return context
}

type SidebarProviderProps = {
  children: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  animate?: boolean
}

/**
 * Local adaptation of Aceternity's Sidebar provider.
 *
 * The AppShell remains the owner of panel width, edge preview, and mobile
 * overlay. This context only makes that controlled state available to sidebar
 * primitives, so the component cannot override RunBuild's task navigation.
 */
export const SidebarProvider = ({
  children,
  open: openProp,
  onOpenChange,
  animate = true,
}: SidebarProviderProps) => {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = openProp ?? uncontrolledOpen
  const setOpen = onOpenChange ?? setUncontrolledOpen

  return (
    <SidebarContext.Provider value={{ open, setOpen, animate }}>
      {children}
    </SidebarContext.Provider>
  )
}

export const Sidebar = SidebarProvider

type DesktopSidebarProps = ComponentProps<typeof motion.div> & {
  mode: 'pinned' | 'peek'
}

/**
 * Aceternity-compatible desktop surface without the registry component's
 * fixed 300px width or hover-controlled open state.
 */
export const DesktopSidebar = ({
  className,
  children,
  mode,
  ...props
}: DesktopSidebarProps) => {
  const { open } = useSidebar()

  return (
    <motion.div
      {...props}
      initial={false}
      data-mode={mode}
      data-open={open ? 'true' : 'false'}
      className={cn('aceternity-sidebar-surface', className)}
    >
      {children}
    </motion.div>
  )
}

type SidebarNavButtonProps = ComponentProps<'button'> & {
  active?: boolean
  icon: ReactNode
}

/** A button-semantic counterpart to Aceternity's link-only SidebarLink. */
export const SidebarNavButton = ({
  active = false,
  className,
  children,
  icon,
  type = 'button',
  ...props
}: SidebarNavButtonProps) => (
  <button
    {...props}
    type={type}
    data-active={active ? 'true' : 'false'}
    className={cn('aceternity-sidebar-nav-button', active && 'is-active', className)}
  >
    <span className="aceternity-sidebar-nav-icon" aria-hidden="true">{icon}</span>
    <span className="aceternity-sidebar-nav-label">{children}</span>
  </button>
)
