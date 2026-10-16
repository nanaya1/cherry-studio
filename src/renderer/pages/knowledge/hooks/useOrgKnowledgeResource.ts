import { useCallback, useEffect, useRef, useState } from 'react'

export function useOrgKnowledgeResource<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++generation.current
    setLoading(true)
    setData(undefined)
    setError(null)
    try {
      const result = await load()
      if (request === generation.current) setData(result)
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [load])
  useEffect(() => {
    setData(undefined)
    void refresh()
    return () => {
      generation.current += 1
    }
  }, [refresh])
  return { data, loading, error, refresh }
}
