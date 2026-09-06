import { useMiniAppPopup } from '@renderer/hooks/useMiniAppPopup'
import { cn } from '@renderer/utils/style'
import { ArrowUpRight } from 'lucide-react'
import type { FC } from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * One toolbox entry: a Xuelang product opened in the built-in browser via a
 * transient mini app (`openSmartMiniApp`).
 */
interface ToolboxProduct {
  id: string
  /** Explicit i18n keys — template literals in t() are banned by the i18n lint rule. */
  nameKey: string
  taglineKey: string
  descriptionKey: string
  url?: string
  /** Icon block tint — cycled from the semantic feedback/chart families, no raw hex. */
  toneClass: string
}

const PRODUCTS: ToolboxProduct[] = [
  {
    id: 'mdo',
    nameKey: 'workspace.toolbox.products.mdo.name',
    taglineKey: 'workspace.toolbox.products.mdo.tagline',
    descriptionKey: 'workspace.toolbox.products.mdo.description',
    url: 'http://mdo.xuelangyun.com:30080/idaas/login.html?ssoReqParams=95138ace-24fc-4a13-aa22-5cbcbb3d44d7&referer=null#/login',
    toneClass: 'bg-chart-1/15 text-chart-1'
  },
  {
    id: 'metam',
    nameKey: 'workspace.toolbox.products.metam.name',
    taglineKey: 'workspace.toolbox.products.metam.tagline',
    descriptionKey: 'workspace.toolbox.products.metam.description',
    url: 'https://spuc.xuelangyun.com/auth/login?callback=http%3A%2F%2Fmetam.xuelangyun.com%3A30080%2Fweb',
    toneClass: 'bg-info-subtle text-info-subtle-foreground'
  },
  {
    id: 'rto',
    nameKey: 'workspace.toolbox.products.rto.name',
    taglineKey: 'workspace.toolbox.products.rto.tagline',
    descriptionKey: 'workspace.toolbox.products.rto.description',
    toneClass: 'bg-success-subtle text-success-subtle-foreground'
  },
  {
    id: 'ontology',
    nameKey: 'workspace.toolbox.products.ontology.name',
    taglineKey: 'workspace.toolbox.products.ontology.tagline',
    descriptionKey: 'workspace.toolbox.products.ontology.description',
    url: 'https://mro.xuelangyun.com/aiops/#/',
    toneClass: 'bg-warning-subtle text-warning-subtle-foreground'
  }
]

const ToolboxPage: FC = () => {
  const { t } = useTranslation()
  const { openSmartMiniApp } = useMiniAppPopup()

  const openProduct = useCallback(
    (product: ToolboxProduct) => {
      if (!product.url) return
      openSmartMiniApp({
        appId: `toolbox-${product.id}`,
        name: t(product.nameKey),
        url: product.url
      })
    },
    [openSmartMiniApp, t]
  )

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
      <main className="flex min-h-[520px] flex-1 items-start justify-center px-6 pt-35 pb-12">
        <div className="w-full max-w-2xl">
          <div className="text-center">
            <h2 className="font-semibold text-2xl tracking-tight">{t('workspace.toolbox.title')}</h2>
            <p className="mt-2 text-muted-foreground text-sm">{t('workspace.toolbox.subtitle')}</p>
          </div>
          <div className="mt-8 grid grid-cols-1 gap-3 md:grid-cols-2">
            {PRODUCTS.map((product) => (
              <button
                key={product.id}
                type="button"
                disabled={!product.url}
                onClick={() => openProduct(product)}
                className="group relative flex min-h-28 cursor-pointer items-start gap-3 rounded-lg border border-border-subtle bg-card p-4 text-left transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:hover:border-border-subtle disabled:hover:shadow-none">
                <span
                  aria-hidden
                  className={cn(
                    'flex size-11 shrink-0 items-center justify-center rounded-lg font-semibold text-lg',
                    product.toneClass
                  )}>
                  {t(product.nameKey).slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-sm">{t(product.nameKey)}</span>
                  <span className="mt-0.5 block text-muted-foreground text-xs">{t(product.taglineKey)}</span>
                  <span className="mt-1.5 block text-muted-foreground text-xs leading-relaxed">
                    {t(product.descriptionKey)}
                  </span>
                </span>
                {product.url && (
                  <ArrowUpRight
                    size={14}
                    aria-hidden
                    className="absolute right-3.5 bottom-3 text-foreground-tertiary opacity-0 transition-opacity group-hover:opacity-100"
                  />
                )}
              </button>
            ))}
          </div>
        </div>
      </main>
    </div>
  )
}

export default ToolboxPage
