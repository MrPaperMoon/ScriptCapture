;(() => {
  if (globalThis.watchClicksInstalled) return
  globalThis.watchClicksInstalled = true
  let captureUrl, pageId
  const topFrame = window === window.top
  const framePath = () => location.origin + location.pathname
  const excluded = 'a[href],form,input,textarea,select,[contenteditable]:not([contenteditable="false"])'

  function selectorFor(element) {
    const parts = []
    for (let node = element; node && parts.length < 48; node = node.parentElement) {
      if (
        node.id &&
        /^[a-zA-Z_][\w-]{0,79}$/.test(node.id) &&
        document.querySelectorAll('#' + node.id).length === 1
      ) {
        parts.unshift('#' + node.id)
        return parts.join('>')
      }
      if (!/^[a-z][a-z0-9-]*$/i.test(node.localName)) return null
      const siblings = node.parentElement?.children
      const index = siblings ? Array.prototype.indexOf.call(siblings, node) + 1 : 1
      parts.unshift(node.localName + ':nth-child(' + index + ')')
      if (node === document.documentElement) return parts.join('>')
    }
    return null
  }
  const fraction = (coordinate, start, length) =>
    length ? Math.max(0, Math.min(1, (coordinate - start) / length)) : 0.5

  window.addEventListener(
    'click',
    (event) => {
      if (
        !captureUrl ||
        (topFrame && location.href !== captureUrl) ||
        !event.isTrusted ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.metaKey
      )
        return
      const node = event.target
      if (!(node instanceof Element) || node.closest(excluded)) return
      const selector = selectorFor(node)
      if (!selector) return
      const rect = node.getBoundingClientRect()
      const click = {
        selector,
        tag: node.localName,
        frame: framePath(),
        top: topFrame,
        x: fraction(event.clientX, rect.left, rect.width),
        y: fraction(event.clientY, rect.top, rect.height),
        pointerType: event.pointerType || 'mouse',
        detail: event.detail,
        pointerId: event.pointerId ?? 1,
        isPrimary: event.isPrimary ?? true,
        pressure: event.pressure ?? 0,
      }
      void chrome.runtime
        .sendMessage({ target: 'background', type: 'click', pageId, event: click })
        .catch(() => {})
    },
    true,
  )

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'capture') {
      captureUrl = message.url
      pageId = message.pageId
    }
  })
})()
