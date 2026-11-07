import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

import { AbsoluteFilePathSchema } from '@shared/types/file'

import IndustrialVideoMaterial from './IndustrialVideoMaterial'

it('附件仅展示就绪状态，不在页面层按扩展名解析', () => {
  render(
    createElement(IndustrialVideoMaterial, {
      material: {
        id: 'html-1',
        name: 'guide.html',
        path: AbsoluteFilePathSchema.parse('/tmp/guide.html'),
        status: 'ready'
      },
      disabled: false,
      onRemove: vi.fn(),
      onRetry: vi.fn()
    })
  )

  expect(screen.getByText('guide.html')).toBeInTheDocument()
  expect(screen.getByText('industrial_video.material_ready')).toBeInTheDocument()
  expect(screen.queryByText('industrial_video.unsupported_material')).not.toBeInTheDocument()
})
