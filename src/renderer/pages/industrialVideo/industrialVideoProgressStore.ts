import { useSyncExternalStore } from 'react'

import type { readGenerationProgress } from './IndustrialVideoGenerationLoading'

export interface IndustrialVideoProgressSnapshot {
  identity: string
  progress: ReturnType<typeof readGenerationProgress>
  stopped?: string
  error?: string
}

interface IndustrialVideoStopAction {
  stop: () => Promise<void>
  stopping: boolean
}
const stopActions = new Map<string, IndustrialVideoStopAction>()

export function publishIndustrialVideoStop(sessionId: string, action: IndustrialVideoStopAction | null): void {
  if (action) stopActions.set(sessionId, action)
  else stopActions.delete(sessionId)
  listeners.forEach((listener) => listener())
}

export function useIndustrialVideoStop(sessionId?: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => (sessionId ? (stopActions.get(sessionId) ?? null) : null)
  )
}

const snapshots = new Map<string, IndustrialVideoProgressSnapshot>()
const listeners = new Set<() => void>()

interface IndustrialVideoWorkbenchSnapshot {
  run: string
  url: string
  document?: { name: string; content: string }
  restoreOnly?: boolean
}
const workbenches = new Map<string, IndustrialVideoWorkbenchSnapshot>()
const availableWorkbenches = new Map<string, Map<string, number>>()
const selectedPanels = new Map<string, string>()

export function publishIndustrialVideoWorkbenchAvailability(sessionId: string, run: string | null): void {
  if (run) availableWorkbenches.set(sessionId, new Map([[run, Number.POSITIVE_INFINITY]]))
  else availableWorkbenches.delete(sessionId)
  listeners.forEach((listener) => listener())
}

export function registerIndustrialVideoWorkbenchAvailability(sessionId: string, run: string): () => void {
  const runs = availableWorkbenches.get(sessionId) ?? new Map<string, number>()
  runs.set(run, (runs.get(run) ?? 0) + 1)
  availableWorkbenches.set(sessionId, runs)
  listeners.forEach((listener) => listener())
  return () => {
    const current = availableWorkbenches.get(sessionId)
    if (!current) return
    const count = current.get(run) ?? 0
    if (count > 1) current.set(run, count - 1)
    else current.delete(run)
    if (!current.size) availableWorkbenches.delete(sessionId)
    listeners.forEach((listener) => listener())
  }
}

export function useIndustrialVideoWorkbenchAvailability(sessionId?: string): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => (sessionId ? (Array.from(availableWorkbenches.get(sessionId)?.keys() ?? []).at(-1) ?? null) : null)
  )
}

export function selectIndustrialVideoPanel(sessionId: string, panelId: string): void {
  if (selectedPanels.get(sessionId) === panelId) return
  selectedPanels.set(sessionId, panelId)
  listeners.forEach((listener) => listener())
}

export function useIndustrialVideoSelectedPanel(sessionId?: string): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => (sessionId ? (selectedPanels.get(sessionId) ?? null) : null)
  )
}

export function openIndustrialVideoWorkbench(sessionId: string, run: string, url: string, restoreOnly = false): void {
  workbenches.set(sessionId, { run, url, restoreOnly })
  listeners.forEach((listener) => listener())
}

export function openIndustrialVideoReviewDocument(
  sessionId: string,
  run: string,
  document: { name: string; content: string }
): void {
  workbenches.set(sessionId, { run, url: '', document })
  listeners.forEach((listener) => listener())
}

// const finals = new Map<string, { run: string; path: string }>()
const finals = new Map<string, { run: string; path: string; restoreOnly?: boolean }>()

export function openIndustrialVideoFinal(sessionId: string, run: string, path: string, restoreOnly = false): void {
  if (workbenches.get(sessionId)?.run !== run) workbenches.delete(sessionId)
  const current = finals.get(sessionId)
  if (restoreOnly && current?.run === run && current.path === path) return
  // finals.set(sessionId, { run, path })
  finals.set(sessionId, { run, path, restoreOnly })
  listeners.forEach((listener) => listener())
}

export function useIndustrialVideoFinal(sessionId: string | undefined) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => {
      if (!sessionId) return null
      const final = finals.get(sessionId)
      const workbench = workbenches.get(sessionId)
      return final && (!workbench || workbench.run === final.run) ? final : null
    }
  )
}

export function useIndustrialVideoWorkbench(sessionId: string | undefined) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => (sessionId ? (workbenches.get(sessionId) ?? null) : null)
  )
}

export function publishIndustrialVideoProgress(
  sessionId: string,
  snapshot: IndustrialVideoProgressSnapshot | null
): void {
  const current = snapshots.get(sessionId)
  if (snapshot === null) {
    if (!current) return
    snapshots.delete(sessionId)
  } else {
    if (
      current?.identity === snapshot.identity &&
      current.progress.total === snapshot.progress.total &&
      current.progress.done === snapshot.progress.done &&
      current.progress.label === snapshot.progress.label &&
      current.progress.stageLabel === snapshot.progress.stageLabel &&
      current.stopped === snapshot.stopped &&
      current.error === snapshot.error
    )
      return
    snapshots.set(sessionId, snapshot)
  }
  listeners.forEach((listener) => listener())
}

export function getIndustrialVideoProgressSnapshot(
  sessionId: string | undefined
): IndustrialVideoProgressSnapshot | null {
  return sessionId ? (snapshots.get(sessionId) ?? null) : null
}

export function useIndustrialVideoProgressSnapshot(
  sessionId: string | undefined
): IndustrialVideoProgressSnapshot | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => getIndustrialVideoProgressSnapshot(sessionId)
  )
}
