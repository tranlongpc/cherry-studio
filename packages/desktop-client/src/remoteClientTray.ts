import { app, Menu, nativeImage, nativeTheme, Tray } from 'electron'

import icon from '../../../build/tray_icon.png?asset'
import iconDark from '../../../build/tray_icon_dark.png?asset'
import iconLight from '../../../build/tray_icon_light.png?asset'
import { lang } from './remoteClientLang'

interface RemoteClientTrayActions {
  showQuickAssistant: () => void
  showWindow: () => void
}

export function createRemoteClientTray({ showQuickAssistant, showWindow }: RemoteClientTrayActions): Tray {
  const iconPath = process.platform === 'darwin' ? (nativeTheme.shouldUseDarkColors ? iconLight : iconDark) : icon
  const image = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
  if (process.platform === 'darwin') image.setTemplateImage(true)

  const tray = new Tray(image)
  const contextMenu = Menu.buildFromTemplate([
    { label: lang('tray.show_window'), click: showWindow },
    { label: lang('tray.show_quick_assistant'), click: showQuickAssistant },
    { type: 'separator' },
    { label: lang('tray.quit'), role: 'quit' }
  ])
  tray.setToolTip(app.name)
  tray.on('click', showQuickAssistant)
  if (process.platform === 'linux') {
    tray.setContextMenu(contextMenu)
  } else {
    tray.on('right-click', () => tray.popUpContextMenu(contextMenu))
  }
  return tray
}
