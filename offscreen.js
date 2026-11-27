import { isDebuggabel } from './config.js'
import { WatchSession } from './session.js'

const notify = (type, data = {}) =>
  chrome.runtime.sendMessage({ target: 'background', ...data, type }).catch(() => {})
let debugRoom
let receivedSite
let sentStructure

async function replayPending(site) {
  if (!site.ready || site.replaying) return
  site.replaying = true
  while (receivedSite === site && site.events.length) {
    const click = site.events.shift()
    await notify('remotePointer', {
      pageId: site.pageId,
      session: site.session,
      ...click,
    })
  }
  site.replaying = false
}

const session = new WatchSession({
  onState: (phase, status) => {
    sentStructure = null
    if (isDebuggabel && debugRoom) void notify('debugState', { phase, status, room: debugRoom })
  },
  onSent: (record) => {
    if (isDebuggabel) void notify('debugSent', { record, room: debugRoom })
  },
  onClose: (id) => {
    receivedSite = null
    void notify('closed', { session: id })
  },
  onSite: ({ pageId, url, frames }) => {
    receivedSite = { pageId, session: session.session, frames, events: [] }
    void notify('remoteSite', { session: session.session, pageId, url })
  },
  onData: (message) => {
    const site = receivedSite
    if (message.pageId !== site?.pageId) return
    if (message.type === 'structure') {
      site.frames = message.frames
      return
    }
    const frame = message.frame === null ? null : site.frames[message.frame]
    if (frame === undefined) return
    if (site.events.length < 256) site.events.push({ frame, document: message.document, event: message.event })
    void replayPending(site)
  },
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
    case 'captureClick': {
      if (message.session !== session.session || !session.isStreamingHost) return {}
      const { pageId, frames, frame, document, event } = message
      const fingerprint = JSON.stringify(frames)
      if (fingerprint !== sentStructure) {
        session.send({ type: 'structure', pageId, frames })
        sentStructure = fingerprint
      }
      session.send({ type: 'pointer', pageId, frame, document, event })
      break
    }
    case 'shareSite':
      if (message.session !== session.session) throw new Error('Соединение изменилось')
      session.send({ type: 'site', pageId: message.pageId, url: message.url, frames: message.frames })
      sentStructure = JSON.stringify(message.frames)
      receivedSite = null
      break
    case 'siteReady':
      if (receivedSite?.pageId !== message.pageId || receivedSite.session !== message.session) break
      receivedSite.ready = true
      void replayPending(receivedSite)
      break
    case 'stopReplay':
      if (receivedSite?.pageId === message.pageId) receivedSite = null
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
  serial = operation.catch(() => {})
  operation.then(
    (result) => respond({ ok: true, ...result }),
    (e) => respond({ ok: false, error: e.message }),
  )
  return true
})
