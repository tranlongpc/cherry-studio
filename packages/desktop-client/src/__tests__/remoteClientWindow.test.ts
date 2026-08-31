import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import { showRemoteClientWindow } from '../remoteClientWindow'

function createWindow(options?: { destroyed?: boolean; minimized?: boolean }): BrowserWindow {
  return {
    focus: vi.fn(),
    isDestroyed: vi.fn(() => options?.destroyed ?? false),
    isMinimized: vi.fn(() => options?.minimized ?? false),
    restore: vi.fn(),
    show: vi.fn()
  } as unknown as BrowserWindow
}

describe('showRemoteClientWindow', () => {
  it.each([null, createWindow({ destroyed: true })])('creates a window when none is available', async (window) => {
    const createClientWindow = vi.fn().mockResolvedValue(undefined)

    await showRemoteClientWindow(window, createClientWindow)

    expect(createClientWindow).toHaveBeenCalledOnce()
  })

  it('restores a minimized window before showing and focusing it', async () => {
    const window = createWindow({ minimized: true })

    await showRemoteClientWindow(window, vi.fn())

    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('shows and focuses an existing window without recreating it', async () => {
    const window = createWindow()
    const createClientWindow = vi.fn()

    await showRemoteClientWindow(window, createClientWindow)

    expect(createClientWindow).not.toHaveBeenCalled()
    expect(window.restore).not.toHaveBeenCalled()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })
})
