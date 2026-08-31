import { Spinner } from '@cherrystudio/ui'
import { REMOTE_CLIENT_SESSION_EXPIRED_EVENT } from '@renderer/services/RemoteClientRuntimeService'
import { disconnectRemoteClient, restoreRemoteClient } from '@renderer/services/remoteClientSession'
import { clearWebSession } from '@renderer/windows/web/webBridge'
import type { ComponentType } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { RemoteClientLoginPage } from './RemoteClientLoginPage'

export function RemoteClientSessionGate(): React.ReactElement {
  const { t: lang } = useTranslation()
  const [ClientApp, setClientApp] = useState<ComponentType | null>(null)
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState(true)

  const openClient = useCallback(async () => {
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
  }, [])

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

  useEffect(() => {
    let active = true
    void restoreRemoteClient()
      .then((restored) => (restored && active ? openClient() : undefined))
      .finally(() => {
        if (active) setRestoring(false)
      })
    return () => {
      active = false
    }
  }, [openClient])

  if (restoring) {
    return (
      <main className="grid min-h-full w-full flex-1 place-items-center bg-background text-foreground">
        <Spinner text={lang('common.loading')} />
      </main>
    )
  }

  if (!ClientApp) return <RemoteClientLoginPage loading={loading} onAuthenticated={openClient} />
  return <ClientApp />
}
