import { beforeEach, describe, expect, it, vi } from 'vitest'

const { platformState } = vi.hoisted(() => ({ platformState: { isWeb: false } }))

vi.mock('@renderer/utils/platform', () => ({
  get isWeb() {
    return platformState.isWeb
  }
}))

import {
  createFilePreviewTabTarget,
  getFilePreviewExtension,
  getFilePreviewFileName,
  getFilePreviewRefreshKey,
  getFilePreviewResourceUrl,
  normalizeFilePreviewPath,
  parseFilePreviewRouteSearch
} from '../filePreview'

beforeEach(() => {
  platformState.isWeb = false
})

describe('file preview paths', () => {
  it('canonicalizes POSIX paths and preserves the file name', () => {
    const path = normalizeFilePreviewPath('/tmp//workspace///./notes/../report.PDF')

    expect(path).toBe('/tmp/workspace/report.PDF')
    expect(getFilePreviewFileName(path)).toBe('report.PDF')
    expect(getFilePreviewExtension(path)).toBe('pdf')
  })

  it('canonicalizes Windows paths with either separator', () => {
    const path = normalizeFilePreviewPath('c:/Users/test/notes/../report.docx')

    expect(path).toBe('C:\\Users\\test\\report.docx')
    expect(getFilePreviewFileName(path)).toBe('report.docx')
  })

  it('preserves Unicode bytes without NFC normalization (an NFC rewrite would ENOENT on Linux)', () => {
    // Byte-faithful, like the rest of the path layer: an NFD-composed name is NOT
    // rewritten to NFC, so the preview path still reaches the file on
    // normalization-sensitive filesystems. See canonicalizeFilePath and
    // docs/references/file/file-manager-architecture.md \u00a71.2.
    expect(normalizeFilePreviewPath('/tmp/Cafe\u0301.md')).toBe('/tmp/Cafe\u0301.md')
  })

  it.each(['', 'notes/report.md', './report.md', 'file:///tmp/report.md', '/tmp/bad\0name.md'])(
    'rejects invalid local path %j',
    (path) => {
      expect(() => normalizeFilePreviewPath(path)).toThrow()
    }
  )

  it('does not treat a dotfile or extensionless file as having an extension', () => {
    expect(getFilePreviewExtension('/tmp/.gitignore')).toBeNull()
    expect(getFilePreviewExtension('/tmp/LICENSE')).toBeNull()
  })
})

describe('file preview route target', () => {
  it('builds a canonical encoded route and basename title', () => {
    const target = createFilePreviewTabTarget('/tmp/My Files/notes/../report #1.md')

    expect(target).toEqual({
      filePath: '/tmp/My Files/report #1.md',
      title: 'report #1.md',
      url: '/app/file-preview?path=%2Ftmp%2FMy+Files%2Freport+%231.md'
    })
  })

  it('uses an authenticated HTTP resource URL on web and a file URL on desktop', () => {
    const filePath = '/Volumes/Data/Files/image #1.png'

    expect(getFilePreviewResourceUrl(filePath, 2)).toBe('file:///Volumes/Data/Files/image%20%231.png')

    platformState.isWeb = true
    expect(getFilePreviewResourceUrl(filePath, 2)).toBe(
      '/web/api/file-content?path=%2FVolumes%2FData%2FFiles%2Fimage+%231.png&v=2'
    )
  })

  it('builds the same URL for lexically equivalent paths', () => {
    expect(createFilePreviewTabTarget('/tmp/notes/../report.md').url).toBe(
      createFilePreviewTabTarget('/tmp/report.md').url
    )
  })

  it('parses valid search paths and contains invalid route input', () => {
    expect(parseFilePreviewRouteSearch({ path: '/tmp/notes/../report.md' })).toEqual({
      path: '/tmp/report.md'
    })
    expect(parseFilePreviewRouteSearch({ path: 'relative/report.md' })).toEqual({ path: undefined })
    expect(parseFilePreviewRouteSearch({})).toEqual({ path: undefined })
  })

  it('accepts only non-negative safe integer refresh keys', () => {
    expect(getFilePreviewRefreshKey({ filePreviewRefreshKey: 3 })).toBe(3)
    expect(getFilePreviewRefreshKey({ filePreviewRefreshKey: -1 })).toBe(0)
    expect(getFilePreviewRefreshKey({ filePreviewRefreshKey: 1.5 })).toBe(0)
    expect(getFilePreviewRefreshKey({ filePreviewRefreshKey: '3' })).toBe(0)
    expect(getFilePreviewRefreshKey(undefined)).toBe(0)
  })
})
