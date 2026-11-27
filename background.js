import { webUrl, validFrameResource, validPointer } from './protocol.js'
import { roomLink, signalLine, readSignals, uuid } from './room-protocol.js'
import { avitoEditor } from './avito-editor.js'
import { captureFrameId, clickBinding, readStructure, rootContext } from './player-frame.js'
import {
  attachStreamingTab, bindStreamingTab, clearStreamingTab, getStreamingTab, replayRemotePointer,
} from './remote-site.js'
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
let siteOperations = Promise.resolve()

function runSiteOperation(operation) {
  const pending = siteOperations.then(operation)
  siteOperations = pending.catch(() => {})
  return pending
}

async function stopStreaming({ pageId, session }, warning) {
  if (warning) await chrome.storage.session.set({ warning })
  try {
    await rtc({ type: 'stopStreaming', pageId, session })
  } finally {
    await clearStreamingTab(pageId)
  }
}

async function updateStreamingTab(tabId) {
  const site = await getStreamingTab()
  if (site?.tabId !== tabId) return
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!tab) return stopStreaming(site)
  if (tab.url !== site.url) {
    if (!site.attached && (tab.pendingUrl === site.url || tab.status !== 'complete')) return
    return stopStreaming(site, 'Вкладка перешла на другой URL. Стриминг приостановлен.')
  }
  if (site.attached) return
  try {
    await attachStreamingTab(site)
    await rtc({ type: 'siteReady', pageId: site.pageId, session: site.session })
  } catch (error) {
    await stopStreaming(site, 'Не удалось подключить вкладку: ' + error.message)
  }
}
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
  await runSiteOperation(async () => {
    const connection = (await rtc({ type: 'state' })).state
    if (connection.session !== state.session || connection.phase !== 'stable')
      throw new Error('Соединение прервалось')
    if ((await chrome.tabs.get(tab.id)).url !== url)
      throw new Error('Вкладка изменилась во время запуска Capture')
    const pageId = crypto.randomUUID()
    const site = await bindStreamingTab({ pageId, url, session: state.session }, tab.id)
    try {
      await attachStreamingTab(site)
      const { frames } = await readStructure(await rootContext(tab.id))
      if ((await chrome.tabs.get(tab.id)).url !== url)
        throw new Error('Вкладка изменилась во время запуска Capture')
      await rtc({ type: 'shareSite', pageId, url, frames, session: state.session })
    } catch (error) {
      await clearStreamingTab(pageId)
      throw error
    }
  })
}

async function applyRemoteClick(message) {
  // A click on a player tab can start a new iframe navigation on the receiver.
  for (let attempt = 0; attempt < 21; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 250))
    const result = await runSiteOperation(async () => {
      const site = await getStreamingTab()
      if (!site?.attached || site.pageId !== message.pageId || site.session !== message.session) return
      try {
        return await replayRemotePointer(site, message)
      } catch (error) {
        await stopStreaming(site, 'Воспроизведение остановлено: ' + error.message)
      }
    })
    if (result !== false) return
  }
  if (isDebuggabel) {
    const room = await getRoom()
    void appendDebug(room, 'Pointer target missing: ' + JSON.stringify(message.event.path))
  }
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
    if (m.type === 'roomTick') await tick(sender)
    return {}
  }
  if (sender.url === chrome.runtime.getURL('offscreen.html')) {
    if (m.type === 'remotePointer' && validPointer(m.event)) {
      await applyRemoteClick(m)
      return {}
    }
    if (m.type === 'debugState' || m.type === 'debugSent') {
      const labels = {
        connection: 'Connection', reconnecting: 'Reconnecting', stable: 'Stable',
        streaming: 'Streaming', error: 'Error', idle: 'IDLE',
      }
      let text = m.text
      if (m.type === 'debugState') text = 'State changed to ' + labels[m.phase] + ' — ' + m.status
      if (m.type === 'debugSent') {
        const data = m.record.payload
        if (data.type === 'pointer') text = 'On ' + data.event.type + ' - ' + JSON.stringify(data.event.path)
        else if (data.type === 'site') text = 'Sent site ' + data.pageId
        else if (data.type === 'structure') text = 'Sent frame structure (' + data.frames.length + ' iframes)'
        else text = 'Sent ' + data.type
      }
      await appendDebug(m.room, text)
      return {}
    }
    if (m.type === 'closed') {
      await runSiteOperation(async () => {
        const current = (await rtc({ type: 'state' })).state
        if (current.session && current.session !== m.session) return
        const room = await getRoom()
        if (current.phase === 'idle' && room?.session === m.session) {
          await chrome.storage.session.remove(['room', 'roomNote'])
        }
        await chrome.storage.session.remove('warning')
        await clearStreamingTab()
      })
      return {}
    }
    if (m.type === 'streamStopped' && uuid(m.pageId)) {
      await runSiteOperation(() => clearStreamingTab(m.pageId))
      return {}
    }
    if (m.type === 'remoteSite' && uuid(m.pageId)) {
      const url = webUrl(m.url)
      if (roomLink(url)) throw new Error('Адрес комнаты нельзя открыть для просмотра')
      await runSiteOperation(async () => {
        const { state } = await rtc({ type: 'state' })
        if (state.session !== m.session || state.stream?.pageId !== m.pageId) return
        const stream = { pageId: m.pageId, url, session: m.session }
        await chrome.storage.session.remove('warning')
        let site
        try {
          site = await bindStreamingTab(stream)
        } catch (error) {
          await stopStreaming(stream, 'Не удалось открыть сайт: ' + error.message)
          return
        }
        await updateStreamingTab(site.tabId)
      })
    }
    return {}
  }
  if (sender.url !== chrome.runtime.getURL('popup.html')) throw new Error('Недопустимый источник')
  if (m.type === 'create') await openRoom('host')
  else if (m.type === 'join') await openRoom('participant', m.url)
  else if (m.type === 'capture') {
    await chrome.storage.session.remove('warning')
    await shareActivePage().catch(async error => {
      await chrome.storage.session.set({ warning: error.message })
      throw error
    })
  } else if (m.type === 'pause') {
    await runSiteOperation(async () => {
      const { state } = await rtc({ type: 'state' })
      if (state.stream) await stopStreaming({ ...state.stream, session: state.session })
    })
  } else if (m.type === 'disconnect') {
    await chrome.storage.session.remove(['room', 'roomNote'])
    await rtc(m)
  } else if (m.type !== 'state') throw new Error('Неизвестная команда')
  const stored = await chrome.storage.session.get(['streamingTab', 'warning', 'room', 'roomNote'])
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
  void runSiteOperation(async () => {
    const site = await getStreamingTab()
    if (site?.tabId === tabId) await stopStreaming(site)
  }).catch(console.warn)
})
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.status && !change.url) return
  void runSiteOperation(() => updateStreamingTab(tabId)).catch(console.warn)
})
chrome.debugger.onDetach.addListener(({ tabId }) => {
  void runSiteOperation(async () => {
    const site = await getStreamingTab()
    if (site?.tabId === tabId && site.attached) {
      await stopStreaming(site, 'Chrome отключил отладчик. Стриминг приостановлен.')
    }
  }).catch(console.warn)
})

let forwardingClicks = Promise.resolve()
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== 'Runtime.bindingCalled' || params.name !== clickBinding || params.payload.length > 12000) return
  const frameId = captureFrameId(source, params.executionContextId)
  if (!frameId) return
  forwardingClicks = forwardingClicks.then(async () => {
    const capture = await getStreamingTab()
    if (!capture?.attached || source.tabId !== capture.tabId) return
    const { pageId, event, document } = JSON.parse(params.payload)
    if (pageId !== capture.pageId || event?.type !== 'click' || !validPointer(event)) return
    if ((await chrome.tabs.get(capture.tabId)).url !== capture.url) return
    const root = await rootContext(capture.tabId)
    const { frames, selected } = await readStructure(root, frameId)
    if (frameId !== root.frameId && (selected === null || !validFrameResource(document))) return
    await rtc({
      type: 'captureClick', session: capture.session, pageId, frames, frame: selected, document, event,
    })
  }).catch(console.warn)
})
