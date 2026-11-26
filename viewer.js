const status = document.getElementById('status')
const sandbox = document.getElementById('sandbox')
const port = chrome.runtime.connect({ name: 'page-viewer:' + location.hash.slice(1) })
let page
let opened = false
let sandboxReady = false
const pending = []

function forward(event) {
  sandbox.contentWindow.postMessage({ type: 'click', event }, '*')
}

// The copy and sandbox can arrive in either order. Keep clicks behind the render message.
function renderWhenReady() {
  if (!page || opened || !sandboxReady) return
  opened = true
  status.textContent = 'Локальная копия · ' + new URL(page.url).host
  if (page.omitted) status.textContent += ' · пропущено ресурсов и фреймов: ' + page.omitted
  sandbox.contentWindow.postMessage({ type: 'render', html: page.html }, '*')
  page = null
  for (const event of pending.splice(0)) forward(event)
}

window.addEventListener('message', ({ source, data }) => {
  if (source !== sandbox.contentWindow) return
  if (data?.type === 'sandboxReady') {
    sandboxReady = true
    renderWhenReady()
  } else if (data?.type === 'selectorMissing' && typeof data.selector === 'string') {
    port.postMessage({ type: 'selectorMissing', selector: data.selector.slice(0, 2048) })
  }
})

port.onMessage.addListener((message) => {
  if (message.type === 'page') {
    page = message.page
    renderWhenReady()
  } else if (message.type === 'click') {
    if (opened) forward(message.event)
    else if (pending.length < 32) pending.push(message.event)
  }
})
port.onDisconnect.addListener(() => {
  status.textContent = 'Сеанс передачи копии завершён.'
  page = null
  pending.length = 0
  sandbox.remove()
})
sandbox.src = 'page-sandbox.html'
