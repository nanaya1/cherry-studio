import { Scrollbar } from '@cherrystudio/ui'
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
  },
  {
    id: 'tuling',
    nameKey: 'workspace.toolbox.products.tuling.name',
    taglineKey: 'workspace.toolbox.products.tuling.tagline',
    descriptionKey: 'workspace.toolbox.products.tuling.description',
    url: 'https://tl.xuelangyun.com/',
    toneClass: 'bg-chart-2/15 text-chart-2'
  },
  {
    id: 'production-control',
    nameKey: 'workspace.toolbox.products.productionControl.name',
    taglineKey: 'workspace.toolbox.products.productionControl.tagline',
    descriptionKey: 'workspace.toolbox.products.productionControl.description',
    url: 'http://10.88.40.213:3000/',
    toneClass: 'bg-info-subtle text-info-subtle-foreground'
  },
  {
    id: 'pro',
    nameKey: 'workspace.toolbox.products.pro.name',
    taglineKey: 'workspace.toolbox.products.pro.tagline',
    descriptionKey: 'workspace.toolbox.products.pro.description',
    toneClass: 'bg-success-subtle text-success-subtle-foreground'
  },
  {
    id: 'aiops',
    nameKey: 'workspace.toolbox.products.aiops.name',
    taglineKey: 'workspace.toolbox.products.aiops.tagline',
    descriptionKey: 'workspace.toolbox.products.aiops.description',
    url: 'https://mro.xuelangyun.com/aiops/#/login',
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
    <div className="flex h-full min-h-0 flex-col bg-background">
      <main className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-6 pt-7 pb-5">
          <h2 className="font-semibold text-xl">{t('workspace.toolbox.title')}</h2>
          <p className="mt-1.5 max-w-3xl text-muted-foreground text-sm leading-6">{t('workspace.toolbox.subtitle')}</p>
        </div>

        <Scrollbar className="@container/toolbox min-h-0 flex-1 px-6 pb-6">
          <div
            className="grid @[1120px]/toolbox:grid-cols-4 @[560px]/toolbox:grid-cols-2 @[840px]/toolbox:grid-cols-3 grid-cols-1 gap-3"
            role="list">
            {PRODUCTS.map((product) => (
              <button
                key={product.id}
                type="button"
                disabled={!product.url}
                onClick={() => openProduct(product)}
                className="group relative flex min-h-36 cursor-pointer flex-col rounded-lg border border-border-subtle bg-card p-4 text-left transition-[background-color,border-color,box-shadow] hover:border-border-strong hover:bg-background-subtle hover:shadow-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-70 disabled:hover:border-border-subtle disabled:hover:bg-card disabled:hover:shadow-none">
                <span className="flex w-full min-w-0 items-start gap-3">
                  <span
                    aria-hidden
                    className={cn(
                      'flex size-10 shrink-0 items-center justify-center rounded-lg font-semibold text-base',
                      product.toneClass
                    )}>
                    {t(product.nameKey).slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-base leading-5">{t(product.nameKey)}</span>
                    <span className="mt-1 line-clamp-2 block text-muted-foreground text-xs leading-4">
                      {t(product.taglineKey)}
                    </span>
                  </span>
                  {product.url ? (
                    <ArrowUpRight
                      size={15}
                      aria-hidden
                      className="group-hover:-translate-y-0.5 mt-0.5 shrink-0 text-foreground-tertiary opacity-0 transition-[opacity,transform] group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100"
                    />
                  ) : (
                    <span className="shrink-0 rounded-md bg-background-subtle px-2 py-1 text-[10px] text-foreground-tertiary">
                      {t('agent.channels.comingSoon')}
                    </span>
                  )}
                </span>
                <span className="mt-4 line-clamp-2 text-muted-foreground text-sm leading-5">
                  {t(product.descriptionKey)}
                </span>
              </button>
            ))}
          </div>
        </Scrollbar>
      </main>
    </div>
  )
}

export default ToolboxPage
