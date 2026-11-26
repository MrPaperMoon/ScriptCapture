import { isDebuggabel } from './config.js'
import { WatchSession } from './session.js'

const notify = (type, data = {}) =>
  chrome.runtime.sendMessage({ target: 'background', ...data, type }).catch(() => {})
let debugRoom
let receivedPage
let viewer

function clearPage() {
  viewer?.disconnect()
  viewer = null
  receivedPage = null
}

const session = new WatchSession({
  onState: (phase, status) => {
    if (isDebuggabel && debugRoom) void notify('debugState', { phase, status, room: debugRoom })
  },
  onSent: (record) => {
    if (isDebuggabel) void notify('debugSent', { record, room: debugRoom })
  },
  onClose: (id) => {
    clearPage()
    void notify('closed', { session: id })
  },
  onPage: (page) => {
    clearPage()
    receivedPage = { page, clicks: [] }
    void notify('remotePage', { session: session.session, pageId: page.id })
  },
  onData: (message) => {
    const page = receivedPage?.page
    if (!page || message.pageId !== page.id || message.url !== page.url || !message.event.top) return
    if (viewer) {
      try {
        viewer.postMessage({ type: 'click', event: message.event })
        return
      } catch {
        viewer = null
      }
    }
    if (receivedPage.clicks.length < 32) receivedPage.clicks.push(message.event)
  },
})
// A viewer can only attach to the copy named in its extension tab.
chrome.runtime.onConnect.addListener((port) => {
  if (
    !receivedPage ||
    port.name !== 'page-viewer:' + receivedPage.page.id ||
    port.sender?.url?.split('#')[0] !== chrome.runtime.getURL('viewer.html')
  )
    return
  viewer?.disconnect()
  viewer = port
  port.onDisconnect.addListener(() => {
    if (viewer === port) viewer = null
  })
  port.onMessage.addListener((message) => {
    if (!isDebuggabel || viewer !== port || message.type !== 'selectorMissing' ||
        typeof message.selector !== 'string') return
    void notify('debugEvent', {
      room: debugRoom,
      text: 'On selector looking error: no element with query ' + message.selector + ' was found',
    })
  })
  port.postMessage({ type: 'page', page: receivedPage.page })
  for (const event of receivedPage.clicks) port.postMessage({ type: 'click', event })
  receivedPage.clicks.length = 0
})
async function command(message) {
  switch (message.type) {
    case 'start':
      debugRoom = message.room
      try {
        await session.start(message)
      } catch (error) {
        session.fail(error.message)
        throw error
      }
      break
    case 'disconnect':
      try {
        if (session.phase === 'stable') session.broadcast({ type: 'bye' })
      } finally {
        session.close()
      }
      break
    case 'send':
      session.send(message.payload)
      break
    case 'sharePage':
      if (message.session !== session.session) throw new Error('Соединение изменилось')
      await session.sharePage(message.pageId, message.page)
      break
    case 'roomText':
      try {
        await session.receive(message.text)
      } catch (error) {
        session.fail(error.message)
        throw error
      }
      break
    case 'ack':
      session.outbox = session.outbox.filter((item) => !message.ids.includes(item.id))
      break
    case 'state':
      break
    default:
      throw new Error('Неизвестная команда')
  }

  return { state: session.state(), outbox: session.outbox }
}

let serial = Promise.resolve()
chrome.runtime.onMessage.addListener((m, sender, respond) => {
  if (m.target !== 'offscreen' || sender.id !== chrome.runtime.id || sender.tab) return
  const operation = serial.then(() => command(m))
  // A long transfer must not block disconnect or signaling.
  if (m.type !== 'sharePage') serial = operation.catch(() => {})
  operation.then(
    (result) => respond({ ok: true, ...result }),
    (e) => respond({ ok: false, error: e.message }),
  )
  return true
})
