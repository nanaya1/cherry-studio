import type { ReactNode } from 'react'
import { createContext, use } from 'react'

export type AgentFileNavigationRequest = (transition: () => void) => void

const AgentFileNavigationContext = createContext<AgentFileNavigationRequest | null>(null)

export function AgentFileNavigationProvider({
  children,
  value
}: {
  children: ReactNode
  value: AgentFileNavigationRequest | null
}) {
  return <AgentFileNavigationContext value={value}>{children}</AgentFileNavigationContext>
}

export function useOptionalAgentFileNavigation(): AgentFileNavigationRequest | null {
  return use(AgentFileNavigationContext)
}
