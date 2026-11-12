import { describe, expect, it } from 'vitest'

import type { Model } from '@shared/data/types/model'
import { MODEL_CAPABILITY } from '@shared/data/types/model'

import {
  getIndustrialVideoModelStatus,
  type IndustrialVideoModelStatus,
  supportsIndustrialVideoTools
} from './industrialVideoModelCompatibility'

const FAILED_PROVIDER_ID = 'c3f07f02-f6dc-4110-8b22-8c77d9174e17'
const FAILED_MODEL_ID = 'chemellm_agent'
const OTHER_PROVIDER_ID = 'other-provider-id'

describe('工业视频模型兼容性', () => {
  it('按模型列表function-call能力筛选，不要求进入实测名单', () => {
    expect(supportsIndustrialVideoTools({ capabilities: [MODEL_CAPABILITY.FUNCTION_CALL] } as Model)).toBe(true)
    expect(supportsIndustrialVideoTools({ capabilities: [] } as unknown as Model)).toBe(false)
  })
  it('已知失败模型按完整 provider + model 身份判定为 failed', () => {
    expect(getIndustrialVideoModelStatus(FAILED_PROVIDER_ID, FAILED_MODEL_ID)).toBe<IndustrialVideoModelStatus>(
      'failed'
    )
  })

  it('同名模型在不同 provider 下不误判为 failed（身份按 provider+model，不按名称）', () => {
    expect(getIndustrialVideoModelStatus(OTHER_PROVIDER_ID, FAILED_MODEL_ID)).toBe<IndustrialVideoModelStatus>(
      'unverified'
    )
  })

  it('同一 provider 下不同模型不被失败名单牵连', () => {
    expect(getIndustrialVideoModelStatus(FAILED_PROVIDER_ID, 'some-other-model')).toBe<IndustrialVideoModelStatus>(
      'unverified'
    )
  })

  it('未列入任何名单的模型为 unverified', () => {
    expect(getIndustrialVideoModelStatus(OTHER_PROVIDER_ID, 'any-model')).toBe<IndustrialVideoModelStatus>('unverified')
  })

  it('已验证名单为空时，任何模型都不会被判为 verified', () => {
    expect(
      getIndustrialVideoModelStatus(FAILED_PROVIDER_ID, 'any-verified-candidate')
    ).not.toBe<IndustrialVideoModelStatus>('supported')
  })
})
