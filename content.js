// Chrome creates a fresh isolated world on each document navigation.
export function captureDocumentClicks(config, binding, pageId) {
  if (window !== top && parent !== top) return
  if (globalThis.scriptCapturePageId === pageId || typeof globalThis[binding] !== 'function') return
  globalThis.scriptCaptureClicks?.abort()
  const controller = new AbortController()
  globalThis.scriptCaptureClicks = controller
  globalThis.scriptCapturePageId = pageId

  function pathTo(element) {
    if (!(element instanceof Element)) return null
    const path = []
    let node = element
    while (node !== document.documentElement) {
      const parent = node.parentNode
      if (!parent?.children || node.matches(config.skip) || path.length === config.maxDepth) return null
      const index = Array.from(parent.children).filter(child => !child.matches(config.skip)).indexOf(node)
      if (index < 0) return null
      const inShadow = parent instanceof ShadowRoot
      path.unshift([index, node.localName, inShadow])
      node = inShadow ? parent.host : parent
      if (!(node instanceof Element)) return null
    }
    return path
  }

  window.addEventListener('click', event => {
    if (!document.documentElement || !(event instanceof PointerEvent) || !event.isTrusted) return
    const node = event.composedPath()[0]
    if (!(node instanceof Element)) return
    for (let ancestor = node; ancestor; ancestor = ancestor.getRootNode().host) {
      if (ancestor.closest(config.excluded)) return
    }
    const path = pathTo(node)
    if (!path) return
    const rect = node.getBoundingClientRect()
    const args = {}
    for (const key of config.numberArgs) args[key] = event[key]
    for (const key of config.optionalNumberArgs) {
      if (Number.isFinite(event[key])) args[key] = event[key]
    }
    for (const key of config.flagArgs) args[key] = event[key]
    args.pointerType = event.pointerType
    args.hasView = event.view === window
    globalThis[binding]?.(JSON.stringify({
      pageId,
      document: location.protocol === 'about:' ? location.href : location.origin + location.pathname,
      event: {
        type: 'click',
        path,
        relatedPath: pathTo(event.relatedTarget),
        x: (event.clientX - rect.left) / (rect.width || 1),
        y: (event.clientY - rect.top) / (rect.height || 1),
        args,
      },
    }))
  }, { capture: true, signal: controller.signal })
}
