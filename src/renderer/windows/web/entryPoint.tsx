import '@renderer/assets/styles/index.css'
import '@renderer/assets/styles/tailwind.css'

import { isAppLanguage } from '@renderer/i18n/languages'
import { defaultLanguage } from '@shared/utils/languages'
import { createRoot } from 'react-dom/client'

import { installWebBridge } from './webBridge'
import { WebSessionGate } from './WebSessionGate'

installWebBridge()

void import('@renderer/i18n/resolver').then(async ({ initI18n }) => {
  await initI18n(isAppLanguage(navigator.language) ? navigator.language : defaultLanguage)
  const rootElement = document.getElementById('root') as HTMLElement
  window.root = rootElement
  createRoot(rootElement).render(<WebSessionGate />)
})
