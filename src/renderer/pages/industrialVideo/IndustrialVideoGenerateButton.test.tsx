import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'

import IndustrialVideoGenerateButton from './IndustrialVideoGenerateButton'

it('sends the start command once and disables the button after success', async () => {
  const user = userEvent.setup()
  const sendMessage = vi.fn(async () => true)
  render(<IndustrialVideoGenerateButton sendMessage={sendMessage} />)

  const button = screen.getByRole('button', { name: '开始生成视频' })
  await user.click(button)

  expect(sendMessage).toHaveBeenCalledWith({ text: '开始生成视频' })
  expect(button).toBeDisabled()

  await user.click(button)
  expect(sendMessage).toHaveBeenCalledTimes(1)
})
