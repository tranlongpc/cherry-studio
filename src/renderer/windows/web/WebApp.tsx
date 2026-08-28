import { CodeStyleProvider } from '@renderer/components/CodeStyleProvider'
import { CommandContextKeyProvider, CommandProvider } from '@renderer/components/command'
import { ConversationNotificationRuntime } from '@renderer/components/ConversationNotificationRuntime'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { AppShell } from '@renderer/components/layout/AppShell'
import { TabsProvider } from '@renderer/components/layout/TabsProvider'
import { PopupHost } from '@renderer/components/PopupHost'
import { ThemeProvider } from '@renderer/components/ThemeProvider'
import ToastHost from '@renderer/components/ToastHost'
import { WindowFatalFallback } from '@renderer/components/WindowFatalFallback'
import { useMainWindowNavigation } from '@renderer/hooks/tab'

function WebWindowRuntime(): null {
  useMainWindowNavigation()
  return null
}

function WebApp(): React.ReactElement {
  return (
    <ErrorBoundary fallbackComponent={WindowFatalFallback}>
      <ThemeProvider>
        <CodeStyleProvider>
          <CommandContextKeyProvider>
            <CommandProvider>
              <TabsProvider>
                <AppShell />
                <WebWindowRuntime />
                <ConversationNotificationRuntime />
                <PopupHost />
                <ToastHost />
              </TabsProvider>
            </CommandProvider>
          </CommandContextKeyProvider>
        </CodeStyleProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default WebApp
