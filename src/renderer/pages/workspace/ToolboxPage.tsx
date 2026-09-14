import { Scrollbar } from '@cherrystudio/ui'
import { cn } from '@renderer/utils/style'
import { ArrowUpRight } from 'lucide-react'
import type { FC } from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * One toolbox entry: a Xuelang product opened in the user's default browser
 * via `shell.openExternal`.
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
    id: 'hufu',
    nameKey: 'workspace.toolbox.products.hufu.name',
    taglineKey: 'workspace.toolbox.products.hufu.tagline',
    descriptionKey: 'workspace.toolbox.products.hufu.description',
    url: 'http://osdev.xuelangyun.com:30080',
    toneClass: 'bg-chart-1/15 text-chart-1'
  },
  {
    id: 'gonggong',
    nameKey: 'workspace.toolbox.products.gonggong.name',
    taglineKey: 'workspace.toolbox.products.gonggong.tagline',
    descriptionKey: 'workspace.toolbox.products.gonggong.description',
    url: 'http://osdev.xuelangyun.com:30080',
    toneClass: 'bg-info-subtle text-info-subtle-foreground'
  },
  {
    id: 'suanpan',
    nameKey: 'workspace.toolbox.products.suanpan.name',
    taglineKey: 'workspace.toolbox.products.suanpan.tagline',
    descriptionKey: 'workspace.toolbox.products.suanpan.description',
    url: 'http://osdev.xuelangyun.com:30080',
    toneClass: 'bg-success-subtle text-success-subtle-foreground'
  },
  {
    id: 'ontology',
    nameKey: 'workspace.toolbox.products.ontology.name',
    taglineKey: 'workspace.toolbox.products.ontology.tagline',
    descriptionKey: 'workspace.toolbox.products.ontology.description',
    url: 'http://121.36.244.169:30009/?open_in_browser=true#/auth/login',
    toneClass: 'bg-warning-subtle text-warning-subtle-foreground'
  },
  {
    id: 'mdo',
    nameKey: 'workspace.toolbox.products.mdo.name',
    taglineKey: 'workspace.toolbox.products.mdo.tagline',
    descriptionKey: 'workspace.toolbox.products.mdo.description',
    url: 'http://mdo.xuelangyun.com/',
    toneClass: 'bg-chart-2/15 text-chart-2'
  },
  {
    id: 'metam',
    nameKey: 'workspace.toolbox.products.metam.name',
    taglineKey: 'workspace.toolbox.products.metam.tagline',
    descriptionKey: 'workspace.toolbox.products.metam.description',
    url: 'http://metam.xuelangyun.com/',
    toneClass: 'bg-info-subtle text-info-subtle-foreground'
  },
  {
    id: 'rto',
    nameKey: 'workspace.toolbox.products.rto.name',
    taglineKey: 'workspace.toolbox.products.rto.tagline',
    descriptionKey: 'workspace.toolbox.products.rto.description',
    url: 'http://rto.xuelangyun.com',
    toneClass: 'bg-success-subtle text-success-subtle-foreground'
  },
  {
    id: 'aiops',
    nameKey: 'workspace.toolbox.products.aiops.name',
    taglineKey: 'workspace.toolbox.products.aiops.tagline',
    descriptionKey: 'workspace.toolbox.products.aiops.description',
    url: 'https://mro.xuelangyun.com/',
    toneClass: 'bg-warning-subtle text-warning-subtle-foreground'
  }
]

const ToolboxPage: FC = () => {
  const { t } = useTranslation()

  const openProduct = useCallback((product: ToolboxProduct) => {
    if (!product.url) return
    void window.api.shell.openExternal(product.url)
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <main className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-6 pt-7 pb-5">
          <h2 className="font-semibold text-xl">{t('workspace.toolbox.title')}</h2>
          <p className="mt-1.5 text-muted-foreground text-sm leading-6">{t('workspace.toolbox.subtitle')}</p>
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
