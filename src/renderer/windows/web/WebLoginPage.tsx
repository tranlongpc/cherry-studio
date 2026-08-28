import { Button, Input } from '@cherrystudio/ui'
import AppLogo from '@renderer/assets/images/logo.png'
import { LockKeyhole, Mail, ShieldCheck } from 'lucide-react'
import type { FormEvent } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { authenticateWebCredentials } from './webBridge'

interface WebLoginPageProps {
  onAuthenticated: () => void
}

export function WebLoginPage({ onAuthenticated }: WebLoginPageProps): React.ReactElement {
  const { t: lang } = useTranslation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [hasError, setHasError] = useState(false)
  const [loading, setLoading] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setHasError(false)
    setLoading(true)
    try {
      await authenticateWebCredentials(email, password)
      onAuthenticated()
    } catch {
      setHasError(true)
    } finally {
      setLoading(false)
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
            <h1 className="font-semibold text-2xl tracking-tight">{lang('webLogin.title')}</h1>
          </div>
        </div>

        <p className="mb-6 text-muted-foreground text-sm leading-6">{lang('webLogin.description')}</p>

        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-2">
            <label htmlFor="web-email" className="flex items-center gap-2 font-medium text-sm">
              <Mail className="size-4 text-muted-foreground" />
              {lang('webLogin.email')}
            </label>
            <Input
              id="web-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={lang('webLogin.emailPlaceholder')}
              aria-invalid={hasError}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="web-password" className="flex items-center gap-2 font-medium text-sm">
              <LockKeyhole className="size-4 text-muted-foreground" />
              {lang('webLogin.password')}
            </label>
            <Input
              id="web-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={lang('webLogin.passwordPlaceholder')}
              aria-invalid={hasError}
            />
            {hasError ? (
              <p className="text-error-subtle-foreground text-sm">{lang('webLogin.errors.invalid')}</p>
            ) : null}
          </div>

          <Button type="submit" size="lg" className="w-full" loading={loading} disabled={!email.trim() || !password}>
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
