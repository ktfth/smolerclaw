/**
 * Network tool implementation: fetch_url with SSRF protection
 */
import { MAX_OUTPUT, truncate } from './helpers'
import { checkSsrf, stripHtml } from './security'

export async function toolFetchUrl(input: Record<string, unknown>): Promise<string> {
  const url = input.url as string
  const method = (input.method as string) || 'GET'
  const headers = (input.headers as Record<string, string>) || {}
  const body = input.body as string | undefined

  // URL validation
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return 'Error: URL must start with http:// or https://'
  }

  // SSRF protection: block private/internal hostnames
  const ssrfErr = checkSsrf(url)
  if (ssrfErr) return ssrfErr

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)

    const resp = await fetch(url, {
      method,
      redirect: 'manual', // prevent redirect-based SSRF
      headers: {
        'User-Agent': 'smolerclaw/1.0',
        'Accept': 'text/html, application/json, text/plain, */*',
        ...headers,
      },
      body: body && method !== 'GET' && method !== 'HEAD' ? body : undefined,
      signal: controller.signal,
    })
    clearTimeout(timeout)

    // Handle redirects manually (max 5 hops, re-check SSRF on each)
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location')
      if (!location) return `Status: ${resp.status} (redirect with no location header)`
      const redirErr = checkSsrf(location)
      if (redirErr) return `Redirect blocked: ${redirErr}`
      return `Status: ${resp.status} -> Redirect to: ${location}\n(Use fetch_url on the redirect target if needed)`
    }

    const status = `${resp.status} ${resp.statusText}`
    const contentType = resp.headers.get('content-type') || ''

    if (method === 'HEAD') {
      const headerLines = [...resp.headers.entries()]
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
      return `Status: ${status}\n${headerLines}`
    }

    // Check content-length before reading body
    const contentLength = resp.headers.get('content-length')
    if (contentLength && Number(contentLength) > MAX_OUTPUT * 2) {
      return `Status: ${status}\n\nError: response body too large (${contentLength} bytes). Max is ${MAX_OUTPUT * 2} bytes.`
    }

    const text = await resp.text()

    // For HTML, extract readable text (strip tags)
    if (contentType.includes('text/html')) {
      const clean = stripHtml(text)
      return truncate(`Status: ${status}\n\n${clean}`)
    }

    return truncate(`Status: ${status}\n\n${text}`)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return 'Error: Request timed out after 30 seconds.'
    }
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}
