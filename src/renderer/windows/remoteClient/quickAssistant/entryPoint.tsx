import '@renderer/assets/styles/index.css'
import '@renderer/assets/styles/tailwind.css'

import { REMOTE_CLIENT_SESSION_EXPIRED_EVENT } from '@renderer/services/RemoteClientRuntimeService'
import { disconnectRemoteClient, restoreRemoteClient } from '@renderer/services/remoteClientSession'
import { clearWebSession, installWebBridge } from '@renderer/windows/web/webBridge'
import { createRoot } from 'react-dom/client'

const nativeIpcApi = window.remoteClient
const restored = await restoreRemoteClient()

if (!nativeIpcApi || !restored) {
  await nativeIpcApi?.request('quick_assistant.hide')
} else {
  installWebBridge({
    nativeIpcApi,
    nativeIpcEvents: new Set(['quick_assistant.shown']),
    nativeIpcRoutes: new Set(['quick_assistant.close', 'quick_assistant.hide', 'quick_assistant.set_pin']),
    platform: nativeIpcApi.platform
  })
  window.addEventListener(REMOTE_CLIENT_SESSION_EXPIRED_EVENT, () => {
    clearWebSession()
    void disconnectRemoteClient().finally(() => nativeIpcApi.request('quick_assistant.hide'))
  })
  const [{ prepareWindow }, { default: QuickAssistantApp }, { default: i18n }] = await Promise.all([
    import('@renderer/windows/prepareWindow'),
    import('@renderer/windows/quickAssistant/QuickAssistantApp'),
    import('@renderer/i18n/resolver')
  ])
  await prepareWindow({
    preference: [
      'app.language',
      'ui.custom_css',
      'ui.theme_mode',
      'ui.theme_user.color_primary',
      'ui.window_style',
      'feature.quick_assistant.assistant_id',
      'feature.quick_assistant.model_id',
      'chat.default_model_id',
      'feature.quick_assistant.read_clipboard_at_startup'
    ]
  })
  document.title = i18n.t('settings.quickAssistant.title')
  createRoot(document.getElementById('root') as HTMLElement).render(<QuickAssistantApp />)
}
