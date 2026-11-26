import { webUrl, validClick } from './protocol.js'
import { roomLink, signalLine, readSignals, uuid } from './room-protocol.js'
import { avitoEditor } from './avito-editor.js'
import { capturePage } from './capture-page.js'
import { MAX_PAGE_BYTES } from './page-transfer.js'
import { newName, newSessionName } from './identity.js'
import { isDebuggabel } from './config.js'

const identity = chrome.storage.session.get('displayName').then(async ({ displayName }) => {
  if (displayName) return displayName
  const name = newName()
  await chrome.storage.session.set({ displayName: name })
  return name
})
let creating
let ticking = false

async function rtc(message) {
  if (!(await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length) {
    creating ??= chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['WEB_RTC'],
        justification: 'Keep the WebRTC data connections alive when popup and signaling tab close',
      })
      .finally(() => {
        creating = null
      })
    await creating
  }
  const result = await chrome.runtime.sendMessage({ ...message, target: 'offscreen' })
  if (!result?.ok) throw new Error(result?.error || 'WebRTC недоступен')
  return result
}
const getRoom = async () => (await chrome.storage.session.get('room')).room
const getCapture = async () => (await chrome.storage.session.get('capture')).capture
async function editor(tabId, operation, text = '') {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: avitoEditor,
    args: [operation, text],
  })
  if (!result?.result) throw new Error('Не удалось прочитать редактор Avito')
  return result.result
}
async function shareActivePage() {
  const { state } = await rtc({ type: 'state' })
  if (state.phase !== 'stable') throw new Error('Нет соединения')
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = webUrl(tab?.url)
  if (roomLink(url)) throw new Error('Выберите вкладку страницы, которую хотите отправить')
  const [snapshot] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: capturePage,
    args: [MAX_PAGE_BYTES],
  })
  const page = snapshot?.result
  if (page?.url !== url || !snapshot.documentId) throw new Error('Не удалось снять копию выбранной страницы')

  // Bind clicks to the captured document. The tab ID survives navigation.
  const target = { tabId: tab.id, documentIds: [snapshot.documentId] }
  await chrome.scripting.executeScript({ target, files: ['content.js'] })
  const pageId = crypto.randomUUID()
  const result = await rtc({ type: 'sharePage', pageId, page, session: state.session })
  if (result.state.phase !== 'stable' || result.state.session !== state.session)
    throw new Error('Соединение прервалось')
  await chrome.storage.session.set({
    capture: { tabId: tab.id, documentId: snapshot.documentId, url, pageId },
  })
  await chrome.tabs.sendMessage(tab.id, { type: 'capture', url, pageId }, { documentId: snapshot.documentId })
}
async function openRoom(role, input) {
  const existingRoom = role === 'participant' ? roomLink(input?.trim()) : null
  if (role === 'participant' && !existingRoom) {
    throw new Error('Введите ссылку вида https://code.avito.ru/r/…')
  }
  if (await getRoom() || (await rtc({ type: 'state' })).state.phase !== 'idle') {
    throw new Error('Сначала отключитесь от текущей комнаты')
  }

  const link = existingRoom ?? await createAvitoRoom()
  const tab = await chrome.tabs.create({ url: link.url })
  const room = {
    tabId: tab.id,
    url: link.url,
    role,
    name: await identity,
    id: crypto.randomUUID(),
  }
  if (role === 'host') room.sessionName = newSessionName()

  await chrome.storage.session.set({ room, roomNote: 'Открываем комнату Avito…' })
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['room.js'] }).catch(() => {})
  void tick({ frameId: 0, tab })
}

async function createAvitoRoom() {
  // Only Avito can allocate the UUID that its room route will accept.
  const response = await fetch('https://code.avito.ru/web/1/code/room', {
    method: 'POST',
    credentials: 'omit',
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error('Avito не создал комнату (HTTP ' + response.status + ')')

  const { room } = await response.json()
  if (!uuid(room?.id)) throw new Error('Avito не вернул UUID комнаты')
  return roomLink('https://code.avito.ru/r/' + room.id)
}

function declaration(room, host) {
  return {
    type: room.role,
    from: room.name,
    id: room.id,
    session: room.sessionName,
    to: host?.from,
    hostId: host?.id,
  }
}

function selectedParticipant(messages, host) {
  return messages.find(message => message.type === 'participant' &&
    message.hostId === host.id && message.session === host.session &&
    message.to === host.from && message.from !== host.from)
}

async function beginConnection(room, host, participant) {
  room.session = host.session
  await chrome.storage.session.set({ room, roomNote: '' })
  const { turn } = await chrome.storage.session.get('turn')
  await rtc({
    type: 'start',
    session: host.session,
    name: room.name,
    host: host.from,
    partner: room.role === 'host' ? participant.from : host.from,
    turn,
    room: { tabId: room.tabId, url: room.url, name: room.name },
  })
}

async function enroll(room, snapshot) {
  const messages = readSignals(snapshot.text)
  if (room.role === 'host') {
    const isOwnHost = (message) =>
      message.type === 'host' && message.session === room.sessionName &&
      message.from === room.name && message.id === room.id
    const host = messages.find(isOwnHost)

    if (!host) {
      if (room.hostWriteRequested) {
        await chrome.storage.session.set({ roomNote: 'Ожидаем запись Host в комнате…' })
        return
      }

      // Clearing the room is a one-time action, even if a later read doesn't contain Host.
      room.hostWriteRequested = true
      await chrome.storage.session.set({ room, roomNote: 'Ожидаем запись Host в комнате…' })

      const line = signalLine(declaration(room))
      const log = isDebuggabel ? debugLine(room.name, 'State changed to Signaling') : ''
      const result = await editor(room.tabId, 'replace', line + log)
      if (result.waiting && (await getRoom())?.id === room.id) {
        delete room.hostWriteRequested
        await chrome.storage.session.set({ room, roomNote: result.message })
      }
      return
    }

    const participant = selectedParticipant(messages, host)
    if (participant) await beginConnection(room, host, participant)
    else await chrome.storage.session.set({ roomNote: 'Ожидаем участника. Скопируйте ссылку на комнату.' })
    return
  }

  const visibleHost = readSignals(snapshot.visibleHost ?? '').find(message => message.type === 'host')
  const host = messages.findLast(message => message.type === 'host') ?? visibleHost
  if (!host) {
    const roomNote = snapshot.text.trim() || snapshot.visibleHost
      ? 'В комнате есть текст, но расширение не распознало запись Host.'
      : 'Ожидаем хоста… Общий документ пока пуст.'
    await chrome.storage.session.set({ roomNote })
    return
  }

  const participant = selectedParticipant(messages, host)
  if (participant) {
    if (participant.id !== room.id) throw new Error('В комнате уже есть участник')
    await beginConnection(room, host, participant)
    return
  }

  const roomNote = 'Хост ' + host.from + ' найден. Ожидаем запись Participant в общей комнате…'
  if (room.announcedHost === host.id) {
    await chrome.storage.session.set({ roomNote })
    return
  }
  if (room.name === host.from) room.name = newName(host.from)
  room.sessionName = host.session
  room.announcedHost = host.id

  // Persist the announcement before writing so an uncertain response cannot duplicate it.
  await chrome.storage.session.set({ room, roomNote })
  const log = isDebuggabel ? debugLine(room.name, 'State changed to Signaling') : ''
  const result = await editor(room.tabId, 'append', '\n' + signalLine(declaration(room, host)) + log)
  if (result.waiting) {
    delete room.announcedHost
    await chrome.storage.session.set({ room, roomNote: result.message })
  }
}

async function exchangeSignals(room, text) {
  const { outbox } = await rtc({ type: 'roomText', text })
  if (!outbox.length) return
  const existing = new Set(readSignals(text, room.session).map(message => message.id))
  const ids = []
  let lines = ''
  for (const message of outbox) {
    const line = existing.has(message.id) ? '' : signalLine(message)
    if (lines.length + line.length > 119999) break
    lines += line
    ids.push(message.id)
  }
  if (lines && (await editor(room.tabId, 'append', '\n' + lines)).waiting) return
  if (ids.length) await rtc({ type: 'ack', ids })
}

async function tick(sender) {
  if (sender.frameId !== 0 || ticking) return
  ticking = true
  let room
  try {
    room = await getRoom()
    if (!room || room.tabId !== sender.tab.id || room.error) return

    const tab = await chrome.tabs.get(room.tabId)
    if (roomLink(tab.url)?.url !== room.url) return
    const operation = !room.session && room.role === 'participant' ? 'readForJoin' : 'read'
    const snapshot = await editor(room.tabId, operation)
    if (snapshot.waiting) {
      await chrome.storage.session.set({ roomNote: snapshot.message })
      return
    }
    if (!room.session) await enroll(room, snapshot)
    else await exchangeSignals(room, snapshot.text)
  } catch (error) {
    if (!room || (await getRoom())?.id !== room.id) return
    if (room.session && (await rtc({ type: 'state' })).state.phase !== 'error') {
      // A temporary failure to append SDP or ICE can be retried on the next tick.
      await chrome.storage.session.set({ roomNote: error.message })
      return
    }
    if (!room.session) void appendDebug(room, 'State changed to Error: ' + error.message)
    await chrome.storage.session.set({ room: { ...room, error: error.message }, roomNote: '' })
  } finally {
    ticking = false
  }
}

let debugWrites = Promise.resolve()

function debugLine(name, text) {
  return '// [' + name + '] ' + text.replace(/[\r\n]/g, ' ').slice(0, 4000) + '\n'
}

function appendDebug(room, text) {
  if (!isDebuggabel || !room?.url) return Promise.resolve()
  debugWrites = debugWrites.then(async () => {
    const tab = await chrome.tabs.get(room.tabId)
    if (roomLink(tab.url)?.url !== room.url) return
    await editor(room.tabId, 'append', '\n' + debugLine(room.name, text))
  }).catch(error => chrome.storage.session.set({ warning: 'Ошибка записи журнала WebRTC: ' + error.message }))
  return debugWrites
}

async function handle(m, sender) {
  if (sender.tab) {
    if (m.type === 'roomTick') {
      await tick(sender)
      return {}
    }
    if (m.type !== 'click' || !validClick(m.event)) return {}
    const capture = await getCapture()
    if (
      !capture ||
      m.pageId !== capture.pageId ||
      sender.tab.id !== capture.tabId ||
      sender.frameId !== 0 ||
      sender.documentId !== capture.documentId ||
      sender.url !== capture.url
    )
      return {}
    const url = new URL(sender.url)
    if (!m.event.top || m.event.frame !== url.origin + url.pathname) return {}
    await rtc({
      type: 'send',
      payload: { type: 'click', pageId: capture.pageId, url: capture.url, event: m.event },
    })
    return {}
  }
  if (sender.url === chrome.runtime.getURL('offscreen.html')) {
    if (m.type === 'debugState' || m.type === 'debugSent' || m.type === 'debugEvent') {
      const labels = { connection: 'Connection', reconnecting: 'Reconnecting', stable: 'Stable', error: 'Error', idle: 'IDLE' }
      let text = m.text
      if (m.type === 'debugState') text = 'State changed to ' + labels[m.phase] + ' — ' + m.status
      if (m.type === 'debugSent') {
        const data = m.record.payload
        if (data.type === 'click') text = 'On click - ' + data.event.selector
        else if (data.type === 'page') text = 'Sent page ' + data.id + ' (' + data.bytes + ' bytes)'
        else text = 'Sent ' + data.type
      }
      await appendDebug(m.room, text)
      return {}
    }
    const current = (await rtc({ type: 'state' })).state
    if (current.session && current.session !== m.session) return {}
    if (m.type === 'closed') {
      const room = await getRoom()
      if (current.phase === 'idle' && room?.session === m.session) {
        await chrome.storage.session.remove(['room', 'roomNote'])
      }
      await chrome.storage.session.remove(['capture', 'warning'])
      return {}
    }
    if (current.phase !== 'stable') return {}
    if (m.type === 'remotePage' && uuid(m.pageId)) {
      await chrome.storage.session.remove('capture')
      await chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') + '#' + m.pageId })
    }
    return {}
  }
  if (sender.url !== chrome.runtime.getURL('popup.html')) throw new Error('Недопустимый источник')
  if (m.type === 'create') await openRoom('host')
  else if (m.type === 'join') await openRoom('participant', m.url)
  else if (m.type === 'capture') await shareActivePage()
  else if (m.type === 'disconnect') {
    await chrome.storage.session.remove(['room', 'roomNote'])
    await rtc(m)
  } else if (m.type !== 'state') throw new Error('Неизвестная команда')
  const stored = await chrome.storage.session.get(['capture', 'warning', 'room', 'roomNote'])
  const { state } = await rtc({ type: 'state' })
  if (stored.room?.error) {
    state.phase = 'error'
    state.status = stored.room.error
  } else if (stored.room && state.phase === 'idle') {
    state.phase = 'signaling'
    state.status = stored.room.role === 'host' ? 'Вы хост' : 'Вы участник'
  }
  return { ...stored, state, name: stored.room?.name ?? await identity }
}
chrome.runtime.onMessage.addListener((m, sender, respond) => {
  if (m.target !== 'background' || sender.id !== chrome.runtime.id) return
  handle(m, sender).then(
    (data) => respond({ ok: true, ...data }),
    (error) => respond({ ok: false, error: error.message }),
  )
  return true
})
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const room = await getRoom()
  if (room?.tabId === tabId) {
    await chrome.storage.session.remove(['room', 'roomNote'])
    await rtc({ type: 'disconnect' }).catch(() => {})
  }
})
