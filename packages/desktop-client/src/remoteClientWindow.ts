import type { BrowserWindow } from 'electron'

export async function showRemoteClientWindow(
  window: BrowserWindow | null,
  createWindow: () => Promise<void>
): Promise<void> {
  if (!window || window.isDestroyed()) {
    await createWindow()
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}
