import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => {
  const image = {
    resize: vi.fn(),
    setTemplateImage: vi.fn()
  }
  image.resize.mockReturnValue(image)
  return {
    app: { getLocale: vi.fn(() => 'en-US'), name: 'Cherry Studio Client' },
    image,
    menu: { buildFromTemplate: vi.fn(() => ({ id: 'context-menu' })) },
    nativeImage: { createFromPath: vi.fn(() => image) },
    nativeTheme: { shouldUseDarkColors: false },
    tray: {
      on: vi.fn(),
      popUpContextMenu: vi.fn(),
      setContextMenu: vi.fn(),
      setToolTip: vi.fn()
    },
    Tray: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: electronMocks.app,
  Menu: electronMocks.menu,
  nativeImage: electronMocks.nativeImage,
  nativeTheme: electronMocks.nativeTheme,
  Tray: electronMocks.Tray
}))

import { createRemoteClientTray } from '../remoteClientTray'

describe('createRemoteClientTray', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    electronMocks.Tray.mockReturnValue(electronMocks.tray)
  })

  it('opens Quick Assistant when the tray icon is clicked', () => {
    const showWindow = vi.fn()
    const showQuickAssistant = vi.fn()

    const tray = createRemoteClientTray({ showQuickAssistant, showWindow })

    expect(tray).toBe(electronMocks.tray)
    expect(electronMocks.tray.setToolTip).toHaveBeenCalledWith('Cherry Studio Client')
    expect(electronMocks.tray.on).toHaveBeenCalledWith('click', showQuickAssistant)
  })

  it('provides window and quit actions from the tray menu', () => {
    const showWindow = vi.fn()
    const showQuickAssistant = vi.fn()

    createRemoteClientTray({ showQuickAssistant, showWindow })

    expect(electronMocks.menu.buildFromTemplate).toHaveBeenCalledWith([
      { label: 'Show Window', click: showWindow },
      { label: 'Quick Assistant', click: showQuickAssistant },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' }
    ])
  })
})
