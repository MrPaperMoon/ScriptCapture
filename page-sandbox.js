const notice = document.getElementById('notice')
let preview
let loaded = false
const pending = []
let replayId = 0
const replays = new Map()

// This function is serialized into the copied document. It cannot use variables from this file.
function listenForClicks() {
  window.addEventListener('message', ({ source, data }) => {
    if (source !== window.parent || data?.type !== 'click') return

    const click = data.event
    const matches = document.querySelectorAll(click.selector)
    const node = matches[0]
    const excluded = 'a[href],form,input,textarea,select,[contenteditable]:not([contenteditable="false"])'
    if (matches.length !== 1 || node.localName !== click.tag || node.closest(excluded)) {
      window.parent.postMessage({ type: 'replayResult', id: data.id, applied: false }, '*')
      return
    }

    const rect = node.getBoundingClientRect()
    const event = new PointerEvent('click', {
      bubbles: true,
      composed: true,
      cancelable: true,
      view: window,
      button: 0,
      buttons: 0,
      detail: click.detail,
      pointerType: click.pointerType,
      pointerId: click.pointerId,
      isPrimary: click.isPrimary,
      pressure: click.pressure,
      clientX: rect.left + rect.width * click.x,
      clientY: rect.top + rect.height * click.y,
    })
    node.dispatchEvent(event)
    window.parent.postMessage({ type: 'replayResult', id: data.id, applied: true }, '*')
  })
}

function replay(event) {
  // Limit diagnostic feedback to events the extension actually dispatched.
  if (replays.size >= 32) replays.delete(replays.keys().next().value)
  const id = ++replayId
  replays.set(id, event.selector)
  preview.contentWindow.postMessage({ type: 'click', id, event }, '*')
}

function render(html) {
  const page = new DOMParser().parseFromString(html, 'text/html')
  const setup = page.createElement('script')
  setup.textContent = '(' + listenForClicks.toString() + ')()'

  // Apply the policy before any copied markup so page scripts run in isolation.
  const policy = page.createElement('meta')
  policy.httpEquiv = 'Content-Security-Policy'
  policy.content = [
    "default-src 'none'",
    "script-src 'unsafe-inline' data:",
    "style-src 'unsafe-inline' data:",
    'img-src data:',
    'media-src data:',
    'font-src data:',
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
  page.head.prepend(policy, setup)

  preview = document.createElement('iframe')
  preview.title = 'Копия сайта'
  preview.setAttribute('sandbox', 'allow-scripts')
  preview.srcdoc = '<!doctype html>' + page.documentElement.outerHTML
  preview.addEventListener(
    'load',
    () => {
      loaded = true
      for (const event of pending.splice(0)) {
        replay(event)
      }
    },
    { once: true },
  )
  document.body.append(preview)
}

window.addEventListener('message', ({ source, data }) => {
  if (preview && source === preview.contentWindow && data?.type === 'replayResult') {
    const selector = replays.get(data.id)
    if (!selector || typeof data.applied !== 'boolean') return
    replays.delete(data.id)
    notice.textContent = 'Клик пропущен: элемент отсутствует в копии.'
    notice.hidden = data.applied === true
    if (!data.applied) {
      window.parent.postMessage({ type: 'selectorMissing', selector }, '*')
    }
    return
  }
  if (source !== window.parent) return

  if (data?.type === 'render' && !preview) {
    render(data.html)
  } else if (data?.type === 'click' && preview) {
    if (loaded) {
      replay(data.event)
    } else if (pending.length < 32) {
      pending.push(data.event)
    }
  }
})

window.parent.postMessage({ type: 'sandboxReady' }, '*')
