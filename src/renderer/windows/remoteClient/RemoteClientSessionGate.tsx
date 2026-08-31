import { REMOTE_CLIENT_SESSION_EXPIRED_EVENT } from '@renderer/services/RemoteClientRuntimeService'
import { disconnectRemoteClient } from '@renderer/services/remoteClientSession'
import { clearWebSession } from '@renderer/windows/web/webBridge'
import type { ComponentType } from 'react'
import { useEffect, useState } from 'react'

import { RemoteClientLoginPage } from './RemoteClientLoginPage'

export function RemoteClientSessionGate(): React.ReactElement {
  const [ClientApp, setClientApp] = useState<ComponentType | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const expireSession = () => {
      clearWebSession()
      void disconnectRemoteClient()
        .catch(() => undefined)
        .finally(() => setClientApp(null))
    }
    window.addEventListener(REMOTE_CLIENT_SESSION_EXPIRED_EVENT, expireSession)
    return () => window.removeEventListener(REMOTE_CLIENT_SESSION_EXPIRED_EVENT, expireSession)
  }, [])

  const openClient = async () => {
    setLoading(true)
    try {
      const [{ prepareWindow }, { default: App }, { default: i18n, getLanguage }] = await Promise.all([
        import('@renderer/windows/prepareWindow'),
        import('../web/WebApp'),
        import('@renderer/i18n/resolver')
      ])
      await prepareWindow({ preference: 'all' })
      await i18n.changeLanguage(await getLanguage())
      setClientApp(() => App)
    } finally {
      setLoading(false)
    }
  }

  if (!ClientApp) return <RemoteClientLoginPage loading={loading} onAuthenticated={openClient} />
  return <ClientApp />
}
