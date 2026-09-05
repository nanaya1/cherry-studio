import type * as CherryStudioUi from '@cherrystudio/ui'
import { Form } from '@cherrystudio/ui'
import type { Model, UniqueModelId } from '@shared/data/types/model'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useForm } from 'react-hook-form'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResourceCreateWizardFormValues } from '../../types'
import { BasicInfoStep } from '../BasicInfoStep'

const { mockUseModelById } = vi.hoisted(() => ({
  mockUseModelById: vi.fn()
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('@cherrystudio/ui', async (importOriginal) => await importOriginal<typeof CherryStudioUi>())

vi.mock('@renderer/components/ModelSelector', () => ({
  ModelSelector: () => null
}))

vi.mock('@renderer/hooks/useModel', () => ({
  useModelById: mockUseModelById
}))

vi.mock('@renderer/hooks/useProvider', () => ({
  useProviderDisplayName: () => ''
}))

function Harness({
  modelId = null,
  runtimeSelectable = false
}: {
  modelId?: UniqueModelId | null
  runtimeSelectable?: boolean
}) {
  const form = useForm<ResourceCreateWizardFormValues>({
    defaultValues: {
      avatar: '💬',
      name: '',
      description: '',
      agentType: 'claude-code',
      permissionMode: 'auto',
      modelId,
      prompt: '',
      knowledgeBaseIds: [],
      skillIds: []
    }
  })

  return (
    <Form {...form}>
      <BasicInfoStep form={form} portalContainer={null} runtimeSelectable={runtimeSelectable} />
      <output data-testid="permission-mode">{form.watch('permissionMode')}</output>
    </Form>
  )
}

afterEach(cleanup)

beforeAll(() => {
  HTMLElement.prototype.hasPointerCapture = () => false
  HTMLElement.prototype.setPointerCapture = () => {}
  HTMLElement.prototype.scrollIntoView = () => {}
})

beforeEach(() => {
  mockUseModelById.mockReset()
  mockUseModelById.mockReturnValue({ model: undefined })
})

describe('BasicInfoStep', () => {
  it('focuses the name field by default', async () => {
    render(<Harness />)

    await waitFor(() =>
      expect(screen.getByPlaceholderText('library.config.dialogs.create.name_placeholder')).toHaveFocus()
    )
  })

  it('hides the avatar picker from the name field', () => {
    render(<Harness />)

    expect(screen.getByText('common.name')).toBeVisible()
    expect(screen.getByPlaceholderText('library.config.dialogs.create.name_placeholder')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'library.config.dialogs.create.avatar_aria' })).not.toBeInTheDocument()
  })

  it('exposes every supported runtime as a selectable card with immutable guidance', () => {
    render(<Harness runtimeSelectable />)

    expect(screen.getByText('library.config.agent.field.runtime.immutable_hint')).toBeVisible()
    expect(screen.queryByRole('img', { name: /runtime\.immutable_hint/ })).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /runtime.option.claude_code/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /runtime.option.pi/ })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: /runtime.option.dsh/ })).not.toBeChecked()
    expect(screen.queryByText('library.config.agent.field.runtime.pi_hint')).not.toBeInTheDocument()
  })

  it('uses smart approval for Claude and Pi while DSH auto-accepts edits', async () => {
    const user = userEvent.setup()
    render(<Harness runtimeSelectable />)

    expect(screen.getByLabelText('library.config.agent.field.permission_mode.label')).toHaveTextContent(
      'agent.settings.tooling.permissionMode.auto.title'
    )

    await user.click(screen.getByRole('radio', { name: /runtime.option.pi/ }))

    expect(screen.getByRole('radio', { name: /runtime.option.pi/ })).toBeChecked()
    expect(screen.getByLabelText('library.config.agent.field.permission_mode.label')).toHaveTextContent(
      'agent.settings.tooling.permissionMode.auto.title'
    )
    expect(screen.getByTestId('permission-mode')).toHaveTextContent('auto')

    await user.click(screen.getByRole('radio', { name: /runtime.option.dsh/ }))

    expect(screen.getByRole('radio', { name: /runtime.option.dsh/ })).toBeChecked()
    expect(screen.getByLabelText('library.config.agent.field.permission_mode.label')).toHaveTextContent(
      'agent.settings.tooling.permissionMode.acceptEdits.title'
    )
    expect(screen.getByTestId('permission-mode')).toHaveTextContent('acceptEdits')
  })

  it('clears the missing-model warning when a prefilled model resolves asynchronously', async () => {
    const modelId = 'openai::gpt-4o' as UniqueModelId
    const view = render(<Harness modelId={modelId} />)

    expect(screen.getByText('library.config.basic.model_not_found')).toBeInTheDocument()

    mockUseModelById.mockReturnValue({
      model: { id: modelId, name: 'GPT-4o', providerId: 'openai' } as Model
    })
    view.rerender(<Harness modelId={modelId} />)

    await waitFor(() => expect(screen.queryByText('library.config.basic.model_not_found')).not.toBeInTheDocument())
  })
})
