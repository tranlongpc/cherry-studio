import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WebLoginPage } from '../WebLoginPage'

const authenticateWebToken = vi.hoisted(() => vi.fn())

vi.mock('../webBridge', () => ({ authenticateWebToken }))

describe('WebLoginPage', () => {
  beforeEach(() => {
    authenticateWebToken.mockReset()
  })

  it('authenticates the entered API key without putting it in the URL', async () => {
    const onAuthenticated = vi.fn()
    authenticateWebToken.mockResolvedValue(undefined)
    render(<WebLoginPage onAuthenticated={onAuthenticated} />)

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'cs-sk-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce())
    expect(authenticateWebToken).toHaveBeenCalledWith('cs-sk-secret')
    expect(window.location.search).toBe('')
  })

  it('keeps the login form visible when authentication fails', async () => {
    authenticateWebToken.mockRejectedValue(new Error('API key is not valid'))
    render(<WebLoginPage onAuthenticated={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'wrong-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText('API key is not valid')).toBeInTheDocument()
  })
})
