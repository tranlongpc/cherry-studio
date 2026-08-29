import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/utils/platform', () => ({ isWeb: true }))

import { HtmlArtifactPreviewSurface } from '../HtmlArtifactPreviewSurface'

describe('HtmlArtifactPreviewSurface on web', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', { randomUUID: () => 'preview-id' })
  })

  it('runs authorized HTML in an isolated browser iframe instead of an Electron webview', () => {
    render(
      <HtmlArtifactPreviewSurface
        html="<main>Preview</main><script>document.body.dataset.ready = 'true'</script>"
        title="common.html_preview"
        authorized
      />
    )

    const iframe = screen.getByTitle('common.html_preview')
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-forms')
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(iframe.getAttribute('srcdoc')).toContain('parent.postMessage')
    expect(iframe.getAttribute('srcdoc')).toContain("document.body.dataset.ready = 'true'")
    expect(screen.queryByTestId('interactive-html-webview')).not.toBeInTheDocument()
  })
})
