import { fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WebLoginPage } from '../WebLoginPage'

const authenticateWebCredentials = vi.hoisted(() => vi.fn())

vi.mock('../webBridge', () => ({ authenticateWebCredentials }))

describe('WebLoginPage', () => {
  beforeEach(() => {
    authenticateWebCredentials.mockReset()
  })

  it('authenticates the entered email and password without putting them in the URL', async () => {
    const onAuthenticated = vi.fn()
    authenticateWebCredentials.mockResolvedValue(undefined)
    render(<WebLoginPage onAuthenticated={onAuthenticated} />)

    fireEvent.change(document.querySelector('#web-email')!, { target: { value: 'user@example.com' } })
    fireEvent.change(document.querySelector('#web-password')!, { target: { value: 'secret-password' } })
    fireEvent.click(document.querySelector('button[type="submit"]')!)

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce())
    expect(authenticateWebCredentials).toHaveBeenCalledWith('user@example.com', 'secret-password')
    expect(window.location.search).toBe('')
  })

  it('keeps the login form visible when authentication fails', async () => {
    authenticateWebCredentials.mockRejectedValue(new Error('Invalid email or password'))
    render(<WebLoginPage onAuthenticated={vi.fn()} />)

    fireEvent.change(document.querySelector('#web-email')!, { target: { value: 'user@example.com' } })
    fireEvent.change(document.querySelector('#web-password')!, { target: { value: 'wrong-password' } })
    fireEvent.click(document.querySelector('button[type="submit"]')!)

    await waitFor(() => expect(document.querySelector('#web-password')).toHaveAttribute('aria-invalid', 'true'))
  })
})
