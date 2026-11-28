import { WatchSession } from './session.js'
import { captureDevice, deviceName, devicePermission, devicePermissions } from './media-devices.js'
import { previewPort, servePreview } from './media-preview.js'

const notify = (type, data = {}) =>
  chrome.runtime.sendMessage({ target: 'background', ...data, type }).catch(() => {})
let receivedSite
let sentStructure
const remoteAudio = document.getElementById('remote-audio')
const previews = new Map()
let audioTrack

function updateMedia() {
  const next = session.remoteTrack('audio')
  if (next !== audioTrack) {
    audioTrack = next
    remoteAudio.srcObject = next ? new MediaStream([next]) : null
    if (next) void remoteAudio.play().catch(console.warn)
  }
  for (const refresh of previews.values()) void refresh().catch(console.warn)
}

async function replayPending(site) {
  if (!site.ready || site.replaying) return
  site.replaying = true
  while (receivedSite === site && site.ready && site.events.length) {
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
  onMedia: updateMedia,
  onState: () => {
    sentStructure = null
  },
  onClose: (id, hadAnswer) => {
    receivedSite = null
    void notify('closed', { session: id, hadAnswer })
  },
  onStop: (pageId, sessionId, closeReceiver) => {
    receivedSite = null
    void notify('streamStopped', { session: sessionId, pageId, closeReceiver })
  },
  onSite: ({ pageId, url, frames }) => {
    sentStructure = null
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
    if (site.suspended) return
    const frame = message.frame === null ? null : site.frames[message.frame]
    if (frame === undefined) return
    if (site.events.length < 256) site.events.push({ frame, document: message.document, event: message.event })
    void replayPending(site)
  },
})
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== previewPort || port.sender?.url !== chrome.runtime.getURL('popup.html')) return
  const refresh = servePreview(port, () => session.remoteTrack('video'), () => previews.delete(port))
  previews.set(port, refresh)
})

async function toggleDevice(kind, expectedSession, granted) {
  if (!Object.hasOwn(deviceName, kind) || !session.canSendMedia(kind) ||
      (expectedSession && session.session !== expectedSession)) throw new Error('Соединение изменилось')
  if (session.localMedia[kind]) {
    if (!granted) await session.setMedia(kind, null)
    return
  }
  const current = session.session
  if (!granted && await devicePermission(kind) !== 'granted') return { kind, session: current }
  let track
  try {
    track = await captureDevice(kind)
    if (session.session !== current) throw new Error('Соединение изменилось')
    await session.setMedia(kind, track)
  } catch (error) {
    track?.stop()
    if (!granted && error.name === 'NotAllowedError') return { kind, session: current }
    if (error.name === 'NotFoundError') throw new Error('Устройство не найдено: ' + deviceName[kind])
    throw error
  }
}

async function command(message) {
  let permission
  switch (message.type) {
    case 'start':
      try {
        await session.start(message)
      } catch (error) {
        session.fail(error.message)
        throw error
      }
      break
    case 'disconnect':
      try {
        if (session.connected) session.broadcast({ type: 'bye' })
      } finally {
        await session.disconnect()
      }
      break
    case 'captureClick': {
      if (message.session !== session.session || message.pageId !== session.stream?.pageId) break
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
      receivedSite = { pageId: message.pageId, session: session.session, ready: true, frames: [], events: [] }
      break
    case 'siteUnavailable':
      if (receivedSite?.pageId !== message.pageId || receivedSite.session !== message.session) break
      receivedSite.suspended = true
      receivedSite.ready = false
      receivedSite.events.length = 0
      sentStructure = null
      break
    case 'siteReady':
      if (receivedSite?.pageId !== message.pageId || receivedSite.session !== message.session) break
      receivedSite.suspended = false
      receivedSite.ready = true
      void replayPending(receivedSite)
      break
    case 'stopStreaming':
      if (message.session === session.session && message.pageId === session.stream?.pageId) {
        session.send({ type: 'stop', pageId: message.pageId, closeReceiver: message.closeReceiver })
      }
      break
    case 'roomText': {
      const current = session.session
      try {
        await session.receive(message.text)
      } catch (error) {
        if (session.session !== current) break
        session.fail(error.message)
        throw error
      }
      break
    }
    case 'ack':
      session.outbox = session.outbox.filter((item) => !message.ids.includes(item.id))
      break
    case 'toggleDevice':
      permission = await toggleDevice(message.kind, message.session, message.granted)
      break
    case 'mediaPermissions':
      return { permissions: await devicePermissions() }
    case 'toggleSpeaker':
      if (!session.connected) throw new Error('Нет соединения')
      remoteAudio.muted = !remoteAudio.muted
      if (!remoteAudio.muted && audioTrack) await remoteAudio.play()
      break
    case 'state':
      break
    default:
      throw new Error('Неизвестная команда')
  }

  const state = session.state()
  state.media.speaker = !remoteAudio.muted
  return { state, outbox: session.outbox, permission }
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
