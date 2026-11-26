// Injected into the selected top frame by chrome.scripting.
export async function capturePage(maxBytes) {
  const url = location.href
  const copy = document.documentElement.cloneNode(true)
  const originalImages = document.querySelectorAll('img')
  const images = copy.querySelectorAll('img')
  const assets = new Map()
  const work = []
  const timeout = AbortSignal.timeout(10000)
  let omitted = copy.querySelectorAll('iframe, frame, object, embed').length
  let assetBytes = 0
  let embeddedChars = 0

  for (const node of copy.querySelectorAll(
    'base, iframe, frame, object, embed, meta[http-equiv], link:not([rel~="stylesheet" i])',
  )) {
    node.remove()
  }
  for (const node of copy.querySelectorAll('input, textarea')) {
    node.removeAttribute('value')
    if (node.localName === 'textarea') node.textContent = ''
  }
  // Keep the cloned document from making requests as it is assembled.
  for (const node of copy.querySelectorAll('[srcset], [poster]')) {
    node.removeAttribute('srcset')
    node.removeAttribute('poster')
  }
  // Playback sessions and embedded streams cannot be copied with the HTML.
  for (const node of copy.querySelectorAll('video[src], audio[src], video source, audio source')) {
    if (!node.getAttribute('src')?.startsWith('data:')) {
      node.removeAttribute('src')
      ++omitted
    }
  }

  async function inline(raw, kind) {
    if (!raw) return ''
    if (raw.startsWith('data:')) return raw
    const source = new URL(raw, document.baseURI)
    if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password) return ''
    const key = kind + source.href
    if (assets.has(key)) return assets.get(key)
    if (assets.size >= 64) return ''
    const task = (async () => {
      const response = await fetch(source, {
        credentials: 'omit',
        cache: 'force-cache',
        referrerPolicy: 'no-referrer',
        signal: timeout,
      })
      if (!response.ok || !response.body) return ''
      const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      if (kind === 'image' && !mime.startsWith('image/')) return ''
      if (kind === 'script' && !/^(?:text|application)\/(?:x-)?(?:javascript|ecmascript)$/.test(mime))
        return ''
      if (kind === 'style' && mime !== 'text/css') return ''
      const reader = response.body.getReader()
      const parts = []
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (assetBytes + value.length > maxBytes / 2) return ''
          assetBytes += value.length
          parts.push(value)
        }
      } finally {
        void reader.cancel().catch(() => {})
      }
      return new Promise((resolve, reject) => {
        const file = new FileReader()
        file.onload = () => resolve(file.result)
        file.onerror = () => reject(file.error)
        file.readAsDataURL(new Blob(parts, { type: mime }))
      })
    })()
    assets.set(key, task)
    return task
  }

  function pack(node, attribute, kind, raw = node.getAttribute(attribute)) {
    node.removeAttribute(attribute)
    work.push(
      Promise.resolve()
        .then(() => inline(raw, kind))
        .catch(() => '')
        .then((data) => {
          if (data && embeddedChars + data.length <= maxBytes * 0.75) {
            embeddedChars += data.length
            node.setAttribute(attribute, data)
          } else {
            if (kind === 'script') node.setAttribute('type', 'application/octet-stream')
            ++omitted
          }
        }),
    )
  }
  for (let index = 0; index < images.length; ++index) {
    const raw = originalImages[index]?.currentSrc || images[index].getAttribute('src')
    if (raw) pack(images[index], 'src', 'image', raw)
  }
  for (const node of copy.querySelectorAll('link[href]')) pack(node, 'href', 'style')
  for (const node of copy.querySelectorAll('script[src]')) pack(node, 'src', 'script')
  await Promise.all(work)
  return { url, html: '<!doctype html>' + copy.outerHTML, omitted }
}
