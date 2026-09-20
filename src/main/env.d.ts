import type { AppEdition } from '@shared/types/appEdition'

declare global {
  const __APP_EDITION__: AppEdition
  const __XUELANG_API_ORIGIN__: string

  interface ImportMetaEnv {
    readonly MAIN_VITE_CHERRYAI_CLIENT_SECRET: string
    readonly MAIN_VITE_CHERRY_CLOUD_CLIENT_SECRET?: string
    readonly MAIN_VITE_CHERRY_CLOUD_API_ORIGIN?: string
    readonly MAIN_VITE_ORG_SERVER_BASE_URL?: string
  }
}
