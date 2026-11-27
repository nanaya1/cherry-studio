import { diagnosticBundleService } from '@main/services/diagnostics'
import type { diagnosticsRequestSchemas } from '@shared/ipc/schemas/diagnostics'
import type { IpcHandlersFor } from '@shared/ipc/types'

export const diagnosticsHandlers: IpcHandlersFor<typeof diagnosticsRequestSchemas> = {
  'diagnostics.bundle.inspect': async ({ range }) => diagnosticBundleService.inspect(range),
  'diagnostics.bundle.export': async (input, { senderId }) => diagnosticBundleService.exportBundle(input, senderId),
  'diagnostics.bundle.upload': async () => {
    throw new Error('Diagnostic upload is disabled')
  },
  'diagnostics.bundle.retry_upload': async () => {
    throw new Error('Diagnostic upload is disabled')
  },
  'diagnostics.report.refresh': async () => {
    throw new Error('Diagnostic upload is disabled')
  },
  'diagnostics.bundle.save_upload': async (input, { senderId }) =>
    diagnosticBundleService.saveUploadBundle(input, senderId),
  'diagnostics.bundle.discard_upload': async (input) => diagnosticBundleService.discardUpload(input)
}
