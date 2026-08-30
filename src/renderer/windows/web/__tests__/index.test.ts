import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const indexPath = resolve(process.cwd(), 'src/renderer/windows/web/index.html')

describe('web document', () => {
  it('declares a loadable PNG favicon', async () => {
    const html = await readFile(indexPath, 'utf8')
    const document = new DOMParser().parseFromString(html, 'text/html')
    const iconLink = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')

    expect(iconLink).not.toBeNull()
    expect(iconLink?.type).toBe('image/png')

    const iconPath = resolve(indexPath, '..', iconLink?.getAttribute('href') ?? '')
    const icon = await readFile(iconPath)

    expect([...icon.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  })
})
