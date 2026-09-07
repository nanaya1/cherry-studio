/**
 * v1 download offer.
 *
 * Opens when the user chooses "Continue using V1" from the failure page's More options.
 * Dismissing leaves the failure screen untouched.
 */

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@cherrystudio/ui'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onDownload: () => void
}

// onDownload 回调暂时未使用，等恢复「下载 V1」入口时再把 _onDownload 改回 onDownload。
export const V1DownloadDialog: FC<Props> = ({
  open,
  onOpenChange,
  // oxlint-disable-next-line no-unused-vars
  onDownload: _onDownload
}) => {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('migration.error.v1_fallback.title')}</DialogTitle>
          <DialogDescription>{t('migration.error.v1_fallback.description')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t('migration.error.v1_fallback.dismiss')}</Button>
          </DialogClose>
          {/* 「下载 V1 版本」按钮暂时隐藏：跳转目标属 Cherry 厂商云。恢复时把 null 换成 ( */}
          {/* <Button variant="emphasis" onClick={onDownload}> */}
          {/*   <ExternalLink size={13} /> */}
          {/*   {t('migration.error.v1_fallback.download')} */}
          {/* </Button> */}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
