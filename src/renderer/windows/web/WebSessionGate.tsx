import type { ComponentType } from 'react'
import { useEffect, useState } from 'react'

import { authenticateWebSession, clearWebSession } from './webBridge'
import { WebLoginPage } from './WebLoginPage'

export function WebSessionGate(): React.ReactElement {
  const [sessionVersion, setSessionVersion] = useState(0)
  const [loginRequired, setLoginRequired] = useState(false)
  const [WebApp, setWebApp] = useState<ComponentType | null>(null)

  useEffect(() => {
    let active = true

    void authenticateWebSession()
      .then(() =>
        Promise.all([import('@renderer/windows/prepareWindow'), import('./WebApp'), import('@renderer/i18n/resolver')])
      )
      .then(async ([{ prepareWindow }, { default: App }, { default: i18n, getLanguage }]) => {
        await prepareWindow({ preference: 'all' })
        await i18n.changeLanguage(await getLanguage())
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

  if (!WebApp) return <div className="h-screen bg-background" />

  return <WebApp />
}
