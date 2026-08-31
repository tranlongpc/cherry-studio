import { Button, Input } from '@cherrystudio/ui'
import AppLogo from '@renderer/assets/images/logo.png'
import {
  connectRemoteClient,
  RemoteClientConnectionError,
  type RemoteClientConnectionErrorKind
} from '@renderer/services/remoteClientSession'
import { LockKeyhole, Mail, Server, ShieldCheck } from 'lucide-react'
import type { FormEvent } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface RemoteClientLoginPageProps {
  loading: boolean
  onAuthenticated: () => Promise<void>
}

export function RemoteClientLoginPage({ loading, onAuthenticated }: RemoteClientLoginPageProps): React.ReactElement {
  const { t: lang } = useTranslation()
  const [serverUrl, setServerUrl] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errorKind, setErrorKind] = useState<RemoteClientConnectionErrorKind>()
  const [connecting, setConnecting] = useState(false)

  const errorMessage =
    errorKind === 'invalid-url'
      ? lang('settings.provider.base_url.invalid')
      : errorKind === 'authentication'
        ? lang('webLogin.errors.invalid')
        : errorKind === 'network'
          ? lang('error.diagnosis.network')
          : errorKind === 'server'
            ? lang('message.api.connection.failed')
            : undefined

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setErrorKind(undefined)
    setConnecting(true)
    try {
      await connectRemoteClient({ serverUrl, email, password })
      await onAuthenticated()
    } catch (error) {
      setErrorKind(error instanceof RemoteClientConnectionError ? error.kind : 'server')
    } finally {
      setConnecting(false)
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-5 py-12 text-foreground">
      <div className="pointer-events-none absolute inset-y-0 left-0 w-[30vw] bg-sidebar" />
      <section className="relative w-full max-w-[420px] rounded-2xl border border-border bg-card p-7 shadow-lg sm:p-9">
        <div className="mb-8 flex items-center gap-3">
          <img src={AppLogo} alt="" className="size-12 rounded-xl" />
          <div>
            <p className="font-medium text-muted-foreground text-sm">{lang('webLogin.productName')}</p>
            <h1 className="font-semibold text-2xl tracking-tight">{lang('webLogin.signIn')}</h1>
          </div>
        </div>

        <p className="mb-6 text-muted-foreground text-sm leading-6">{lang('webLogin.description')}</p>

        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-2">
            <label htmlFor="remote-server-url" className="flex items-center gap-2 font-medium text-sm">
              <Server className="size-4 text-muted-foreground" />
              {lang('settings.provider.base_url.label')}
            </label>
            <Input
              id="remote-server-url"
              type="url"
              autoComplete="url"
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              placeholder={lang('settings.provider.base_url.placeholder')}
              aria-invalid={errorKind === 'invalid-url' || errorKind === 'network' || errorKind === 'server'}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="remote-email" className="flex items-center gap-2 font-medium text-sm">
              <Mail className="size-4 text-muted-foreground" />
              {lang('webLogin.email')}
            </label>
            <Input
              id="remote-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={lang('webLogin.emailPlaceholder')}
              aria-invalid={errorKind === 'authentication'}
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="remote-password" className="flex items-center gap-2 font-medium text-sm">
              <LockKeyhole className="size-4 text-muted-foreground" />
              {lang('webLogin.password')}
            </label>
            <Input
              id="remote-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={lang('webLogin.passwordPlaceholder')}
              aria-invalid={errorKind === 'authentication'}
            />
            {errorMessage ? <p className="text-error-subtle-foreground text-sm">{errorMessage}</p> : null}
          </div>

          <Button
            type="submit"
            size="lg"
            className="w-full"
            loading={connecting || loading}
            disabled={!serverUrl.trim() || !email.trim() || !password || loading}>
            {lang('webLogin.signIn')}
          </Button>
        </form>

        <div className="mt-7 flex gap-3 border-border-subtle border-t pt-5 text-muted-foreground text-xs leading-5">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <p>{lang('webLogin.securityNotice')}</p>
        </div>
      </section>
    </main>
  )
}
