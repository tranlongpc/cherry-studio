import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import FallbackFavicon from '../FallbackFavicon'

describe('FallbackFavicon', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn())
  })

  it('loads favicon images without a CORS-sensitive fetch probe', async () => {
    render(<FallbackFavicon hostname="bitwarden.com" alt="Bitwarden" />)

    const image = await screen.findByRole('img', { name: 'Bitwarden' })

    expect(image).toHaveAttribute('src', 'https://icon.horse/icon/bitwarden.com')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('tries each favicon source before showing the hostname fallback', async () => {
    render(<FallbackFavicon hostname="bitwarden.com" alt="Bitwarden" />)

    const image = await screen.findByRole('img', { name: 'Bitwarden' })
    fireEvent.error(image)
    expect(image).toHaveAttribute('src', 'https://favicon.splitbee.io/?url=bitwarden.com')

    fireEvent.error(image)
    expect(image).toHaveAttribute('src', 'https://favicon.im/bitwarden.com')

    fireEvent.error(image)
    expect(image).toHaveAttribute('src', 'https://bitwarden.com/favicon.ico')

    fireEvent.error(image)
    expect(screen.queryByRole('img', { name: 'Bitwarden' })).not.toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
  })
})
