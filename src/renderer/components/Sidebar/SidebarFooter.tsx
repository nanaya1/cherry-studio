import { Columns2, Settings } from 'lucide-react'
import React from 'react'

import { UserAvatar } from './primitives'
import { SidebarTooltip } from './Tooltip'
import type { SidebarUser, SidebarVisibleLayout } from './types'

export type SidebarFooterActions =
  | React.ReactNode
  | ((layout: SidebarVisibleLayout, onOverlayOpenChange?: (open: boolean) => void) => React.ReactNode)

export interface SidebarFooterProps {
  layout: SidebarVisibleLayout
  user?: SidebarUser
  actions?: SidebarFooterActions
  extensionsLabel?: string
  onExtensionsClick?: () => void
  onOverlayOpenChange?: (open: boolean) => void
}

export function SidebarFooter({ layout, actions, onOverlayOpenChange, ...props }: SidebarFooterProps) {
  const resolvedActions = typeof actions === 'function' ? actions(layout, onOverlayOpenChange) : actions

  if (layout === 'icon') return <IconFooter actions={resolvedActions} {...props} />
  return <FullFooter actions={resolvedActions} {...props} />
}

type FooterProps = Omit<SidebarFooterProps, 'layout' | 'actions' | 'onOverlayOpenChange'> & {
  actions?: React.ReactNode
}

function IconFooter({ user, actions, extensionsLabel, onExtensionsClick }: FooterProps) {
  return (
    <div className="flex flex-col items-center gap-1 px-1.5 pt-2 pb-3 [-webkit-app-region:no-drag]">
      {extensionsLabel && (
        <SidebarTooltip content={extensionsLabel}>
          <button
            type="button"
            onClick={onExtensionsClick}
            className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground">
            <Columns2 size={18} strokeWidth={1.6} />
          </button>
        </SidebarTooltip>
      )}
      {actions}
      {user && (
        <SidebarTooltip content={user.name}>
          <button type="button" aria-label={user.name} onClick={user.onClick} className="cursor-pointer rounded-full">
            <UserAvatar user={user} className="h-7 w-7" />
          </button>
        </SidebarTooltip>
      )}
    </div>
  )
}

function FullFooter({ user, actions, extensionsLabel, onExtensionsClick }: FooterProps) {
  return (
    <div className="space-y-1 border-sidebar-border border-t px-2 py-2 [-webkit-app-region:no-drag]">
      {extensionsLabel && (
        <button
          type="button"
          onClick={onExtensionsClick}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.75 text-[13px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground">
          <Columns2 size={16} strokeWidth={1.6} />
          <span>{extensionsLabel}</span>
        </button>
      )}

      {actions}

      {user && (
        <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent/60">
          <button type="button" onClick={user.onClick} className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <UserAvatar user={user} className="h-7 w-7 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] text-sidebar-foreground">{user.name}</span>
              {user.description && (
                <span className="block truncate text-[10px] text-muted-foreground">{user.description}</span>
              )}
            </span>
          </button>
          {user.onSettingsClick && (
            <button
              type="button"
              aria-label={user.settingsLabel}
              onClick={user.onSettingsClick}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
              <Settings size={15} strokeWidth={1.6} />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
