export function reconcileIndustrialVideoJob(jobId: string | null, candidates: Record<string, unknown>[]) {
  if (!jobId) return { state: 'unknown' as const }
  const matches = candidates.filter((job) => job.job_id === jobId)
  return matches.length === 1 ? { state: 'found' as const, job: matches[0] } : { state: 'unknown' as const }
}

export function canSubmitIndustrialVideo(input: { pendingIntent: boolean; unknownCount: number; activeJob: boolean }) {
  return !input.pendingIntent && input.unknownCount === 0 && !input.activeJob
}
