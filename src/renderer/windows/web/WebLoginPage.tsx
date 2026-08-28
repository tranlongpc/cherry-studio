import { Button, Input } from '@cherrystudio/ui'
import AppLogo from '@renderer/assets/images/logo.png'
import { KeyRound, ShieldCheck } from 'lucide-react'
import type { FormEvent } from 'react'
import { useState } from 'react'

import { authenticateWebToken } from './webBridge'

interface WebLoginPageProps {
  onAuthenticated: () => void
}

export function WebLoginPage({ onAuthenticated }: WebLoginPageProps): React.ReactElement {
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setLoading(true)
    try {
      await authenticateWebToken(apiKey)
      onAuthenticated()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Unable to sign in')
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
            <p className="font-medium text-muted-foreground text-sm">Cherry Studio</p>
            <h1 className="font-semibold text-2xl tracking-tight">Web access</h1>
          </div>
        </div>

        <p className="mb-6 text-muted-foreground text-sm leading-6">
          Enter the API Gateway key from Cherry Studio on your Mac. The key stays in this browser tab and is removed
          when the tab closes.
        </p>

        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-2">
            <label htmlFor="web-api-key" className="flex items-center gap-2 font-medium text-sm">
              <KeyRound className="size-4 text-muted-foreground" />
              API key
            </label>
            <Input
              id="web-api-key"
              type="password"
              autoComplete="current-password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="cs-sk-..."
              aria-invalid={!!error}
              autoFocus
            />
            {error ? <p className="text-error-subtle-foreground text-sm">{error}</p> : null}
          </div>

          <Button type="submit" size="lg" className="w-full" loading={loading} disabled={!apiKey.trim()}>
            Sign in
          </Button>
        </form>

        <div className="mt-7 flex gap-3 border-border-subtle border-t pt-5 text-muted-foreground text-xs leading-5">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <p>Use this page through your private LAN or Tailscale network. Do not expose the gateway to the internet.</p>
        </div>
      </section>
    </main>
  )
}
