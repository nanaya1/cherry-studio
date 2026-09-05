import { MenuItem, Popover, PopoverContent, PopoverTrigger } from '@cherrystudio/ui'
import { Ellipsis } from 'lucide-react'
import { useState } from 'react'

import { ActiveIndicator } from './primitives'
import { SidebarTooltip } from './Tooltip'
import type { ResolvedSidebarEntry, SidebarActiveState, SidebarVisibleLayout } from './types'

export interface SidebarMoreMenuProps {
  label: string
  entries: ResolvedSidebarEntry[]
  active: SidebarActiveState
  layout: SidebarVisibleLayout
  onOpenChange?: (open: boolean) => void
}

function MoreMenuRow({
  entry,
  active,
  onSelect
}: {
  entry: ResolvedSidebarEntry
  active: SidebarActiveState
  onSelect: () => void
}) {
  return (
    <MenuItem
      variant="ghost"
      size="sm"
      icon={<span className="flex size-4 items-center justify-center">{entry.renderIcon(14, 'md')}</span>}
      label={entry.label}
      active={entry.isActive(active)}
      onClick={onSelect}
      className="rounded-lg"
    />
  )
}

export function SidebarMoreMenu({ label, entries, active, layout, onOpenChange }: SidebarMoreMenuProps) {
  const [open, setOpen] = useState(false)
  const hasActive = entries.some((entry) => entry.isActive(active))

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }

  const handleSelect = (onOpen: () => void) => {
    handleOpenChange(false)
    onOpen()
  }

  const panel = (
    <PopoverContent side="right" align="start" className="w-fit min-w-36 p-1.5">
      <div className="flex max-h-96 flex-col overflow-y-auto">
        {entries.map((entry) => (
          <MoreMenuRow key={entry.key} entry={entry} active={active} onSelect={() => handleSelect(entry.onOpen)} />
        ))}
      </div>
    </PopoverContent>
  )

  if (layout === 'icon') {
    return (
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <SidebarTooltip content={label}>
            <button
              type="button"
              aria-label={label}
              className={`relative flex h-9 w-9 items-center justify-center rounded-full transition-all duration-150 ${
                open || hasActive
                  ? 'bg-[var(--sidebar-active-bg)] text-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              }`}>
              {hasActive && !open && <ActiveIndicator className="rounded-full" />}
              <Ellipsis size={18} strokeWidth={1.6} />
            </button>
          </SidebarTooltip>
        </PopoverTrigger>
        {panel}
      </Popover>
    )
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <MenuItem
          variant="ghost"
          icon={<Ellipsis size={16} strokeWidth={1.6} />}
          label={label}
          active={hasActive}
          className="rounded-lg"
        />
      </PopoverTrigger>
      {panel}
    </Popover>
  )
}
