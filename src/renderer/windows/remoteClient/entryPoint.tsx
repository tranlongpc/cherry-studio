import '@renderer/assets/styles/index.css'
import '@renderer/assets/styles/tailwind.css'

import { isAppLanguage } from '@renderer/i18n/languages'
import { installWebBridge } from '@renderer/windows/web/webBridge'
import { defaultLanguage } from '@shared/utils/languages'
import { createRoot } from 'react-dom/client'

import RemoteClientApp from './RemoteClientApp'

installWebBridge()

void import('@renderer/i18n/resolver').then(async ({ default: i18n, initI18n }) => {
  await initI18n(isAppLanguage(navigator.language) ? navigator.language : defaultLanguage)
  document.title = i18n.t('webLogin.productName')
  const rootElement = document.getElementById('root') as HTMLElement
  window.root = rootElement
  createRoot(rootElement).render(<RemoteClientApp />)
})
