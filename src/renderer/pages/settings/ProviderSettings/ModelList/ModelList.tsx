import React, { memo } from 'react'

import { ButtonGroup } from '@cherrystudio/ui'

import { useCoworkManagedProvider } from '../hooks/useCoworkManagedProvider'
import { modelListClasses } from '../primitives/ProviderSettingsPrimitives'
import { XuelangModelRefresh } from '../ProviderSpecific/XuelangAccountSettings'
import { useModelListHealthRun } from './modelListHealthContext'
import ProviderModelAdd from './ProviderModelAdd'
import ProviderModelDownload from './ProviderModelDownload'
import ProviderModelList from './ProviderModelList'
import ProviderModelPullReconcile from './ProviderModelPullReconcile'

interface ModelListProps {
  scrollElement?: HTMLDivElement | null
  providerId: string
  modelPullGuideVersion?: number
  onContinueApiSetup?: () => void
}

function ModelListContent({
  scrollElement,
  providerId,
  modelPullGuideVersion = 0,
  onContinueApiSetup
}: {
  scrollElement?: HTMLDivElement | null
  providerId: string
  modelPullGuideVersion?: number
  onContinueApiSetup?: () => void
}) {
  const { isModelChecking } = useModelListHealthRun()
  const readOnly = useCoworkManagedProvider(providerId)
  const disabled = isModelChecking

  return (
    <>
      <ProviderModelList
        scrollElement={scrollElement}
        providerId={providerId}
        disabled={disabled}
        readOnly={readOnly}
        onContinueApiSetup={readOnly ? undefined : onContinueApiSetup}
        actions={
          readOnly
            ? ({ disabled: toolbarDisabled }) => <XuelangModelRefresh disabled={toolbarDisabled} />
            : ({ disabled: toolbarDisabled }) => (
                <ButtonGroup className={modelListClasses.toolbarButtonGroup}>
                  <ProviderModelPullReconcile
                    providerId={providerId}
                    disabled={toolbarDisabled}
                    guideVersion={modelPullGuideVersion}
                  />
                  {providerId === 'ovms' ? (
                    <ProviderModelDownload providerId={providerId} disabled={toolbarDisabled} />
                  ) : (
                    <ProviderModelAdd providerId={providerId} disabled={toolbarDisabled} />
                  )}
                </ButtonGroup>
              )
        }
      />
    </>
  )
}

const ModelList: React.FC<ModelListProps> = ({
  scrollElement,
  providerId,
  modelPullGuideVersion = 0,
  onContinueApiSetup
}) => {
  return (
    <div className={modelListClasses.cqRoot}>
      <section data-testid="provider-model-list" className={modelListClasses.section}>
        <ModelListContent
          scrollElement={scrollElement}
          providerId={providerId}
          modelPullGuideVersion={modelPullGuideVersion}
          onContinueApiSetup={onContinueApiSetup}
        />
      </section>
    </div>
  )
}

export default memo(ModelList)
