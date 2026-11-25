import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@cherrystudio/ui'

export default function KnowledgeFilePagination({
  total,
  pageSize,
  currentPage,
  goToPage,
  loading = false,
  hasNext = true,
  onPageSizeChange
}: {
  total: number
  pageSize: number
  currentPage: number
  goToPage: (page: number) => void
  loading?: boolean
  hasNext?: boolean
  onPageSizeChange?: (size: number) => void
}) {
  const { t } = useTranslation()
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const pageNumbers = Array.from(
    new Set([
      1,
      pageCount,
      currentPage - 1,
      currentPage,
      currentPage + 1,
      ...(currentPage <= 2 ? [2, 3] : []),
      ...(currentPage >= pageCount - 1 ? [pageCount - 2, pageCount - 1] : [])
    ])
  )
    .filter((page) => page >= 1 && page <= pageCount)
    .sort((left, right) => left - right)
  return (
    // MEA:public-knowledge-ready-pagination 分页独占底栏，覆盖共享组件的自动居中。
    <Pagination aria-label={t('knowledge.org.documents')} className="mx-0 w-full justify-end whitespace-nowrap">
      <PaginationContent className="gap-1 text-xs text-muted-foreground">
        <PaginationItem className="px-3">{t('knowledge.org.pagination_total', { total: total })}</PaginationItem>
        <span aria-hidden="true" className="h-4 w-px shrink-0 self-center bg-border" />
        <PaginationItem className="pr-2">
          {onPageSizeChange ? (
            <Select
              value={String(pageSize)}
              disabled={loading}
              onValueChange={(value) => onPageSizeChange(Number(value))}>
              <SelectTrigger
                size="sm"
                aria-label={t('knowledge.org.page_size')}
                className="h-7 border-transparent px-2 text-xs shadow-none">
                <SelectValue />
              </SelectTrigger>
              {/* MEA:public-knowledge-ready-pagination 仅此快速分页菜单取消共享弹层的进出动画。 */}
              {/* 原 <SelectContent> 保留共享默认值；此实例不等待动画结束卸载。 */}
              <SelectContent
                align="end"
                className="data-[state=open]:animate-none! data-[state=closed]:animate-none!"
                style={{ transition: 'none' }}>
                {[5, 10, 20, 50, 100].map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {t('knowledge.org.per_page', { size })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            t('knowledge.org.per_page', { size: pageSize })
          )}
        </PaginationItem>
        <span aria-hidden="true" className="h-4 w-px shrink-0 self-center bg-border" />
        <PaginationItem>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 shadow-none"
            aria-label={t('common.previous')}
            disabled={loading || currentPage === 1}
            onClick={() => goToPage(currentPage - 1)}>
            <ChevronLeft className="size-3.5" />
          </Button>
        </PaginationItem>
        {pageNumbers.map((page, index) => (
          <PaginationItem key={page} className="flex items-center gap-1">
            {index > 0 && page - pageNumbers[index - 1] > 1 ? <PaginationEllipsis className="size-7" /> : null}
            <Button
              type="button"
              variant={page === currentPage ? 'secondary' : 'ghost'}
              size="icon-sm"
              className="size-7 text-xs tabular-nums shadow-none"
              aria-current={page === currentPage ? 'page' : undefined}
              disabled={loading}
              onClick={() => goToPage(page)}>
              {page}
            </Button>
          </PaginationItem>
        ))}
        <PaginationItem>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 shadow-none"
            aria-label={t('knowledge.org.next_page')}
            disabled={loading || !hasNext || currentPage >= pageCount}
            onClick={() => goToPage(currentPage + 1)}>
            <ChevronRight className="size-3.5" />
          </Button>
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  )
}
