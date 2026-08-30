import { useEffect, useState } from 'react'

const FAILED_FAVICON_CACHE_PREFIX = 'failed_favicon_'
const FAILED_FAVICON_CACHE_DURATION = 24 * 60 * 60 * 1000

const isUrlFailedRecently = (url: string): boolean => {
  const cacheKey = `${FAILED_FAVICON_CACHE_PREFIX}${url}`
  const cachedTimestamp = localStorage.getItem(cacheKey)

  if (!cachedTimestamp) return false

  const timestamp = parseInt(cachedTimestamp, 10)
  const now = Date.now()

  if (now - timestamp < FAILED_FAVICON_CACHE_DURATION) {
    return true
  }

  localStorage.removeItem(cacheKey)
  return false
}

const markUrlAsFailed = (url: string): void => {
  const cacheKey = `${FAILED_FAVICON_CACHE_PREFIX}${url}`
  localStorage.setItem(cacheKey, Date.now().toString())
}

interface FallbackFaviconProps {
  hostname: string
  alt: string
}

const getFaviconUrls = (hostname: string) => [
  `https://icon.horse/icon/${hostname}`,
  `https://favicon.splitbee.io/?url=${hostname}`,
  `https://favicon.im/${hostname}`,
  `https://${hostname}/favicon.ico`
]

const FallbackFavicon: React.FC<FallbackFaviconProps> = ({ hostname, alt }) => {
  type FaviconState =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'failed' }
    | { status: 'loaded'; src: string }

  const [faviconState, setFaviconState] = useState<FaviconState>({ status: 'idle' })

  useEffect(() => {
    const faviconUrls = getFaviconUrls(hostname)
    const src = faviconUrls.find((url) => !isUrlFailedRecently(url)) ?? faviconUrls[0]
    setFaviconState({ status: 'loaded', src })
  }, [hostname])

  const handleError = () => {
    if (faviconState.status === 'loaded') {
      markUrlAsFailed(faviconState.src)
      const faviconUrls = getFaviconUrls(hostname)
      const currentIndex = faviconUrls.indexOf(faviconState.src)
      const src = faviconUrls.slice(currentIndex + 1).find((url) => !isUrlFailedRecently(url))
      if (src) {
        setFaviconState({ status: 'loaded', src })
        return
      }
    }
    setFaviconState({ status: 'failed' })
  }

  if (faviconState.status === 'failed') {
    return (
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-[4px] bg-primary/15 font-bold text-[10px] text-primary">
        {hostname.charAt(0).toUpperCase()}
      </span>
    )
  }

  if (faviconState.status === 'loaded') {
    return <img src={faviconState.src} alt={alt} onError={handleError} className="h-4 w-4 rounded-[4px] bg-muted" />
  }

  return <span className="inline-block h-4 w-4 rounded-[4px] bg-muted" />
}

export default FallbackFavicon
