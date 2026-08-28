import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const useMainWindowNavigation = vi.hoisted(() => vi.fn())

vi.mock('@renderer/hooks/tab', () => ({ useMainWindowNavigation }))
vi.mock('@renderer/components/ErrorBoundary', () => ({ ErrorBoundary: ({ children }: any) => children }))
vi.mock('@renderer/components/WindowFatalFallback', () => ({ WindowFatalFallback: () => null }))
vi.mock('@renderer/components/ThemeProvider', () => ({ ThemeProvider: ({ children }: any) => children }))
vi.mock('@renderer/components/CodeStyleProvider', () => ({ CodeStyleProvider: ({ children }: any) => children }))
vi.mock('@renderer/components/command', () => ({
  CommandContextKeyProvider: ({ children }: any) => children,
  CommandProvider: ({ children }: any) => children
}))
vi.mock('@renderer/components/layout/TabsProvider', () => ({ TabsProvider: ({ children }: any) => children }))
vi.mock('@renderer/components/layout/AppShell', () => ({ AppShell: () => <div>shell</div> }))
vi.mock('@renderer/components/ConversationNotificationRuntime', () => ({ ConversationNotificationRuntime: () => null }))
vi.mock('@renderer/components/PopupHost', () => ({ PopupHost: () => null }))
vi.mock('@renderer/components/ToastHost', () => ({ default: () => null }))

import WebApp from '../WebApp'

describe('WebApp', () => {
  it('mounts the main-window navigation consumer inside TabsProvider', () => {
    render(<WebApp />)
    expect(useMainWindowNavigation).toHaveBeenCalledOnce()
  })
})
