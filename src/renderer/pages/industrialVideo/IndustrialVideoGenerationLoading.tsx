import './industrialVideoGenerationLoading.css'

const count = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null)

export function readGenerationProgress(
  progress: Record<string, unknown> | undefined,
  state: string,
  fallback: number | null
) {
  const total = count(progress?.scenes_total) ?? count(progress?.total_scenes) ?? count(progress?.total) ?? fallback
  const rawDone = count(progress?.scenes_done) ?? count(progress?.done)
  const done = rawDone !== null && (total === null || rawDone <= total) ? rawDone : null
  const stage =
    typeof progress?.stage_current === 'string'
      ? progress.stage_current
      : typeof progress?.stage === 'string'
        ? progress.stage
        : state
  const assembling = ['assemble', 'assembling', 'concat', 'compose'].includes(stage) || state === 'assembling'
  return {
    total,
    done,
    label: assembling ? '正在合成成片' : '正在生成分镜视频',
    stageLabel: assembling ? '成片合成中' : '镜头制作中'
  }
}

export default function IndustrialVideoGenerationLoading({
  progress,
  stopped,
  error
}: {
  progress: ReturnType<typeof readGenerationProgress>
  stopped?: string
  error?: string
}) {
  const animating = !stopped && !error
  const { total, done } = progress
  return (
    <section
      className="ivideo-loading flex h-full min-h-80 flex-col items-center justify-center gap-5 px-6 py-10 text-center text-sm"
      data-animating={animating ? 'true' : 'false'}
      aria-label="视频制作实时进度">
      <div
        className="ivideo-loading-stage relative w-full max-w-80 overflow-hidden rounded-2xl border border-border bg-background"
        aria-hidden="true">
        <svg viewBox="0 0 320 190" className="w-full text-primary" fill="none">
          <defs>
            <pattern id="ivideo-loading-grid" width="20" height="20" patternUnits="userSpaceOnUse">
              <path d="M20 0H0V20" stroke="currentColor" strokeOpacity=".08" />
            </pattern>
          </defs>
          <rect width="320" height="190" fill="url(#ivideo-loading-grid)" />
          <path d="M40 142H280" stroke="currentColor" strokeOpacity=".2" strokeDasharray="4 5" />
          {[0, 1, 2].map((index) => (
            <g
              key={index}
              className="ivideo-frame"
              style={{ animationDelay: `${index * -0.7}s` }}
              transform={`translate(${40 + index * 78} ${66 - (index === 1 ? 14 : 0)})`}>
              <rect width="68" height="48" rx="7" fill="var(--background)" stroke="currentColor" strokeOpacity=".5" />
              <path d="M12 35L26 20L38 30L47 22L57 35" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="49" cy="13" r="4" fill="currentColor" fillOpacity=".3" />
              <path d="M10 41H58" stroke="currentColor" strokeOpacity=".2" />
            </g>
          ))}
          <g className="ivideo-scan">
            <path d="M160 35V130" stroke="currentColor" strokeWidth="2" strokeOpacity=".65" />
          </g>
          <circle className="ivideo-signal" cx="160" cy="142" r="4" fill="currentColor" />
          <path d="M151 164L157 170L170 157" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
      <span className="rounded-full border border-border bg-muted px-3 py-1 text-xs text-muted-foreground">
        {stopped || progress.stageLabel}
      </span>
      <div className="space-y-2" role="status" aria-live="polite">
        <h3 className="text-base font-semibold text-foreground">{stopped || progress.label}</h3>
        <p className="text-muted-foreground tabular-nums">
          {done !== null && total !== null
            ? `已完成 ${done}/${total} 个分镜`
            : total !== null
              ? `共 ${total} 个分镜，等待完成进度`
              : '等待服务端返回分镜进度'}
        </p>
      </div>
      {total !== null && total > 0 && done !== null && (
        <div
          role="progressbar"
          aria-label="分镜完成数"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          className="h-1 w-full max-w-60 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none"
            style={{ width: `${(done / total) * 100}%` }}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="max-w-64 break-words text-error">
          {stopped ? error : `进度更新暂时中断：${error}`}
        </p>
      )}
      {!stopped && (
        <p className="max-w-64 text-xs leading-6 text-muted-foreground">
          完成后会自动显示成片，
          <br />
          你可以先查看脚本与分镜。
        </p>
      )}
    </section>
  )
}
