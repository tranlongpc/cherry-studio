import '@renderer/assets/styles/index.css'
import '@renderer/assets/styles/tailwind.css'

import AppLogo from '@renderer/assets/images/logo.png'
import type { ComponentType } from 'react'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { authenticateWebSession, clearWebSession, installWebBridge } from './webBridge'
import { WebLoginPage } from './WebLoginPage'

installWebBridge()

function WebRoot(): React.ReactElement {
  const [sessionVersion, setSessionVersion] = useState(0)
  const [loginRequired, setLoginRequired] = useState(false)
  const [WebApp, setWebApp] = useState<ComponentType | null>(null)

  useEffect(() => {
    let active = true

    void authenticateWebSession()
      .then(() => Promise.all([import('@renderer/windows/prepareWindow'), import('./WebApp')]))
      .then(async ([{ prepareWindow }, { default: App }]) => {
        await prepareWindow({ preference: 'all' })
        if (active) setWebApp(() => App)
      })
      .catch(() => {
        clearWebSession()
        if (active) setLoginRequired(true)
      })

    return () => {
      active = false
    }
  }, [sessionVersion])

  if (loginRequired) {
    return (
      <WebLoginPage
        onAuthenticated={() => {
          setLoginRequired(false)
          setSessionVersion((version) => version + 1)
        }}
      />
    )
  }
  if (!WebApp)
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <img src={AppLogo} alt="" className="size-16 animate-pulse rounded-2xl" />
      </div>
    )
  return <WebApp />
}

void import('@renderer/i18n/resolver').then(async ({ initI18n }) => {
  await initI18n()
  const rootElement = document.getElementById('root') as HTMLElement
  window.root = rootElement
  createRoot(rootElement).render(<WebRoot />)
})
