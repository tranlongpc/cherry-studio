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

function WebApp(): React.ReactElement {
  return (
    <ErrorBoundary fallbackComponent={WindowFatalFallback}>
      <ThemeProvider>
        <CodeStyleProvider>
          <CommandContextKeyProvider>
            <CommandProvider>
              <TabsProvider>
                <AppShell />
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
