import '@renderer/assets/styles/index.css'
import '@renderer/assets/styles/tailwind.css'

import AppLogo from '@renderer/assets/images/logo.png'
import type { ComponentType } from 'react'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { authenticateWebToken, clearWebToken, getWebToken, installWebBridge } from './webBridge'
import { WebLoginPage } from './WebLoginPage'

installWebBridge()

const rootElement = document.getElementById('root') as HTMLElement
window.root = rootElement

function WebRoot(): React.ReactElement {
  const [sessionVersion, setSessionVersion] = useState(0)
  const [loginRequired, setLoginRequired] = useState(() => !getWebToken())
  const [WebApp, setWebApp] = useState<ComponentType | null>(null)

  useEffect(() => {
    const token = getWebToken()
    if (!token) return
    let active = true

    void authenticateWebToken(token)
      .then(() => Promise.all([import('@renderer/windows/prepareWindow'), import('./WebApp')]))
      .then(async ([{ prepareWindow }, { default: App }]) => {
        await prepareWindow({ preference: 'all' })
        if (active) setWebApp(() => App)
      })
      .catch(() => {
        clearWebToken()
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

createRoot(rootElement).render(<WebRoot />)
