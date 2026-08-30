import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authenticateWebSession = vi.hoisted(() => vi.fn())
const clearWebSession = vi.hoisted(() => vi.fn())
const prepareWindow = vi.hoisted(() => vi.fn())
const getLanguage = vi.hoisted(() => vi.fn())
const changeLanguage = vi.hoisted(() => vi.fn())

vi.mock('../webBridge', () => ({ authenticateWebSession, clearWebSession }))
vi.mock('@renderer/windows/prepareWindow', () => ({ prepareWindow }))
vi.mock('@renderer/i18n/resolver', () => ({ default: { changeLanguage }, getLanguage }))
vi.mock('../WebApp', () => ({ default: () => <div>Web app ready</div> }))

import { WebSessionGate } from '../WebSessionGate'

describe('WebSessionGate', () => {
  beforeEach(() => {
    authenticateWebSession.mockReset()
    clearWebSession.mockReset()
    prepareWindow.mockReset().mockResolvedValue(undefined)
    getLanguage.mockReset().mockResolvedValue('vi-VN')
    changeLanguage.mockReset().mockResolvedValue(undefined)
  })

  it('does not flash an image while the web session is loading', () => {
    authenticateWebSession.mockReturnValue(new Promise(() => {}))

    const { container } = render(<WebSessionGate />)

    expect(container.querySelector('img')).toBeNull()
  })

  it('applies the authenticated preference language before rendering the web app', async () => {
    authenticateWebSession.mockResolvedValue(undefined)

    render(<WebSessionGate />)

    await screen.findByText('Web app ready')
    await waitFor(() => expect(changeLanguage).toHaveBeenCalledWith('vi-VN'))
    expect(prepareWindow).toHaveBeenCalledWith({ preference: 'all' })
  })
})
