import { FileProcessingJobOutputSchema } from '@shared/data/types/fileProcessing'
import type { AbsoluteFilePath } from '@shared/types/file'

export type MaterialState = { status: 'parsing' | 'ready' | 'failed'; text?: string }

export function canAnalyzeMaterials(requirement: string, materials: MaterialState[], acceptPartial: boolean) {
  return Boolean(
    requirement.trim() &&
    materials.some((material) => material.status === 'ready' && material.text?.trim()) &&
    !materials.some((material) => material.status === 'parsing') &&
    (acceptPartial || !materials.some((material) => material.status === 'failed'))
  )
}

export async function readMaterialArtifact(output: unknown, readText: (path: AbsoluteFilePath) => Promise<string>) {
  const { artifact } = FileProcessingJobOutputSchema.parse(output)
  const text = artifact.kind === 'text' ? artifact.text : await readText(artifact.path)
  if (!text.trim()) throw new Error('industrial_video.empty_material')
  return text
}
