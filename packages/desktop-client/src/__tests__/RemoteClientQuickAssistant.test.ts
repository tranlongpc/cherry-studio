import { IpcChannel } from '@shared/IpcChannel'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => {
  const listeners = new Map<string, (...args: any[]) => void>()
  const webContentsListeners = new Map<string, (...args: any[]) => void>()
  const window = {
    destroy: vi.fn(),
    focus: vi.fn(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 550, height: 400 })),
    hide: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
    loadURL: vi.fn().mockResolvedValue(undefined),
    minimize: vi.fn(),
    on: vi.fn((event: string, listener: (...args: any[]) => void) => listeners.set(event, listener)),
    setAlwaysOnTop: vi.fn(),
    setBounds: vi.fn(),
    setOpacity: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    show: vi.fn(),
    webContents: {
      id: 99,
      on: vi.fn((event: string, listener: (...args: any[]) => void) => webContentsListeners.set(event, listener)),
      send: vi.fn(),
      setWindowOpenHandler: vi.fn()
    }
  }
  return {
    app: { hide: vi.fn() },
    BrowserWindow: vi.fn(() => window),
    listeners,
    screen: {
      getCursorScreenPoint: vi.fn(() => ({ x: 10, y: 10 })),
      getDisplayNearestPoint: vi.fn(() => ({
        id: 1,
        workArea: { x: 0, y: 0, width: 1440, height: 900 }
      }))
    },
    window
  }
})

vi.mock('electron', () => ({
  app: electronMocks.app,
  BrowserWindow: electronMocks.BrowserWindow,
  screen: electronMocks.screen
}))

import { RemoteClientQuickAssistant } from '../RemoteClientQuickAssistant'

describe('RemoteClientQuickAssistant', () => {
  const ensureSession = vi.fn()
  const showMainWindow = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    electronMocks.listeners.clear()
    electronMocks.window.isDestroyed.mockReturnValue(false)
    electronMocks.window.isFocused.mockReturnValue(true)
    electronMocks.window.isMinimized.mockReturnValue(false)
    electronMocks.window.loadURL.mockResolvedValue(undefined)
  })

  function createAssistant(): RemoteClientQuickAssistant {
    return new RemoteClientQuickAssistant({
      clientSession: {} as Electron.Session,
      ensureSession,
      getMainWindow: () => electronMocks.window as unknown as Electron.BrowserWindow,
      isQuitting: () => false,
      openExternalUrl: vi.fn(),
      preloadPath: '/preload.js',
      rendererUrl: 'file:///quick-assistant.html',
      showMainWindow
    })
  }

  it('opens the login window instead of an unauthenticated Quick Assistant', async () => {
    ensureSession.mockResolvedValue(false)
    const assistant = createAssistant()

    await assistant.show()

    expect(showMainWindow).toHaveBeenCalledOnce()
    expect(electronMocks.BrowserWindow).not.toHaveBeenCalled()
  })

  it('creates one native window and publishes the local shown event', async () => {
    ensureSession.mockResolvedValue(true)
    const assistant = createAssistant()

    await assistant.show()
    await assistant.show()

    expect(electronMocks.BrowserWindow).toHaveBeenCalledOnce()
    expect(electronMocks.window.loadURL).toHaveBeenCalledWith('file:///quick-assistant.html')
    expect(electronMocks.window.show).toHaveBeenCalledTimes(2)
    expect(electronMocks.window.webContents.send).toHaveBeenCalledWith(
      IpcChannel.IpcApi_Event,
      'quick_assistant.shown',
      undefined
    )
  })

  it('keeps the window visible while pinned and hides it after unpinning', async () => {
    ensureSession.mockResolvedValue(true)
    const assistant = createAssistant()
    await assistant.show()
    const blur = electronMocks.listeners.get('blur')

    assistant.setPinned(true)
    blur?.()
    expect(electronMocks.window.hide).not.toHaveBeenCalled()

    assistant.setPinned(false)
    blur?.()
    expect(electronMocks.window.hide).toHaveBeenCalledOnce()
  })
})
