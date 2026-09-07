import { cn } from '@cherrystudio/ui/lib/utils'
import type { FC, HTMLAttributes, ReactNode } from 'react'

/** Matches NarrowLayout's `px-6` side padding, for callers doing inline padding math. */
export const NARROW_LAYOUT_SIDE_PADDING_PX = 24

interface Props extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  narrowMode?: boolean
  withSidePadding?: boolean
}

const NarrowLayout: FC<Props> = ({ children, className, narrowMode = false, withSidePadding = false, ...props }) => {
  return (
    <div
      className={cn(
        'narrow-mode relative mx-auto w-full transition-[max-width] duration-300 ease-in-out',
        narrowMode ? 'active' : 'max-w-full',
        narrowMode && (withSidePadding ? 'max-w-[calc(800px+3rem)]' : 'max-w-[800px]'),
        withSidePadding && 'box-border px-6',
        className
      )}
      {...props}>
      {children}
    </div>
  )
}

export default NarrowLayout
