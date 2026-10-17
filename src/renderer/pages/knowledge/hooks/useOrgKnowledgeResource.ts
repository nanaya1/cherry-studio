import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

export function useOrgKnowledgeResource<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  // const activeLoader = useRef<typeof load | null>(load)
  const resource = useMemo(() => ({ load }), [load])
  const activeLoader = useRef<typeof resource | null>(resource)
  const [dataLoader, setDataLoader] = useState(resource)
  // MEA:enterprise-knowledge-page 旧操作不能重启已离开的资源请求。
  useLayoutEffect(() => {
    activeLoader.current = resource
    return () => {
      activeLoader.current = null
      generation.current += 1
    }
  }, [resource])
  const refresh = useCallback(async () => {
    if (activeLoader.current !== resource) return
    const request = ++generation.current
    setDataLoader(resource)
    setLoading(true)
    setData(undefined)
    setError(null)
    try {
      const result = await resource.load()
      if (request === generation.current) setData(result)
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [resource])
  useEffect(() => {
    setData(undefined)
    void refresh()
    return () => {
      generation.current += 1
    }
  }, [refresh])
  // return { data, loading, error, refresh }
  // 首次渲染新资源时也不能暴露上一资源的数据。
  const current = dataLoader === resource
  return { data: current ? data : undefined, loading: !current || loading, error: current ? error : null, refresh }
}
