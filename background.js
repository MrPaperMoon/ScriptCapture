import { webUrl, validFrameResource, validPointer } from './protocol.js'
import { roomLink, signalLine, readSignals, uuid } from './room-protocol.js'
import { avitoEditor } from './avito-editor.js'
import { captureFrameId, clickBinding, detachFrames, readStructure, rootContext } from './player-frame.js'
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

async function stopStreaming({ pageId, session }, warning, closeReceiver = false) {
  if (warning) await chrome.storage.session.set({ warning })
  try {
    await rtc({ type: 'stopStreaming', pageId, session, closeReceiver })
  } finally {
    await clearStreamingTab(pageId, closeReceiver)
  }
}

async function disconnectRoom() {
  const room = await getRoom()
  await chrome.storage.session.remove(['room', 'roomNote'])
  try {
    const { state } = await rtc({ type: 'state' })
    if (room?.role === 'host' || ['stable', 'streaming', 'reconnecting'].includes(state.phase)) {
      await recordHostLeft(room)
    }
    await rtc({ type: 'disconnect' })
  } finally {
    await clearStreamingTab()
  }
}

async function suspendStreamingTab(site, tabId = site.tabId) {
  await chrome.storage.session.set({ streamingTab: { ...site, tabId, attached: false } })
  await detachFrames(site.tabId)
  await rtc({ type: 'siteUnavailable', pageId: site.pageId, session: site.session })
}

async function updateStreamingTab(tabId) {
  const site = await getStreamingTab()
  if (site?.tabId !== tabId) return
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!tab) return
  if (tab.discarded) {
    if (site.attached) await suspendStreamingTab(site)
    return
  }
  if (tab.url !== site.url) {
    if (!site.attached && (tab.pendingUrl === site.url || tab.status !== 'complete')) return
    return stopStreaming(site, 'Вкладка перешла на другой URL. Стриминг приостановлен.')
  }
  if (site.attached || tab.status !== 'complete' || tab.pendingUrl) return
  try {
    await attachStreamingTab(site)
    await rtc({ type: 'siteReady', pageId: site.pageId, session: site.session })
  } catch (error) {
    const current = await chrome.tabs.get(tabId).catch(() => null)
    if (!current || current.discarded || current.status !== 'complete') return
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
  let attachment
  for (let attempt = 0; attempt < 21; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 250))
    const result = await runSiteOperation(async () => {
      const site = await getStreamingTab()
      if (!site?.attached || site.pageId !== message.pageId || site.session !== message.session ||
          (attachment && site.attachment !== attachment)) return
      attachment = site.attachment
      try {
        return await replayRemotePointer(site, message)
      } catch (error) {
        const tab = await chrome.tabs.get(site.tabId).catch(() => null)
        if (tab && !tab.discarded) await stopStreaming(site, 'Воспроизведение остановлено: ' + error.message)
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
  const value = typeof input === 'string' ? input.trim() : ''
  const existingRoom = roomLink(value)
  if (!existingRoom && (value || role === 'participant')) {
    throw new Error('Введите ссылку вида https://code.avito.ru/r/…')
  }
  if (await getRoom() || (await rtc({ type: 'state' })).state.phase !== 'idle') {
    throw new Error('Сначала отключитесь от текущей комнаты')
  }

  const link = existingRoom ?? await createAvitoRoom()
  const [active] = existingRoom ? await chrome.tabs.query({ active: true, currentWindow: true }) : []
  const tab = roomLink(active?.url)?.url === link.url ? active : await chrome.tabs.create({ url: link.url })
  const room = {
    tabId: tab.id,
    url: link.url,
    role,
    name: await identity,
    id: crypto.randomUUID(),
  }
  if (role === 'host') {
    room.sessionName = newSessionName()
    room.reuse = Boolean(existingRoom)
  }

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

async function beginConnection(room, host) {
  if ((await getRoom())?.id !== room.id) return
  if (room.role !== 'host' && room.name === host.from) room.name = newName(host.from)
  delete room.departedHostId
  room.session = host.session
  room.hostId = host.id
  await chrome.storage.session.set({ room, roomNote: '' })
  const { turn } = await chrome.storage.session.get('turn')
  await rtc({
    type: 'start',
    session: host.session,
    hostId: host.id,
    name: room.name,
    host: host.from,
    turn,
    room: { tabId: room.tabId, url: room.url, name: room.name },
  })
}

async function recordHostLeft(room) {
  const hostId = room?.hostId ?? (room?.role === 'host' ? room.id : null)
  const session = room?.session ?? room?.sessionName
  if (!hostId || !session) return
  try {
    const tab = await chrome.tabs.get(room.tabId)
    if (roomLink(tab.url)?.url !== room.url) return
    const snapshot = await editor(room.tabId, 'read')
    if (snapshot.waiting) return
    const messages = readSignals(snapshot.text, session)
    if (messages.some(message => message.type === 'hostLeft' && message.hostId === hostId)) return
    if (!messages.some(message => message.type === 'host' && message.id === hostId)) return
    await editor(room.tabId, 'append', '\n' + signalLine({
      type: 'hostLeft', id: crypto.randomUUID(), from: room.name, session, hostId,
    }))
  } catch (error) {
    console.warn(error)
  }
}

let roomCheck

function checkRoomAt(room, time) {
  if (roomCheck?.id === room.id && roomCheck.time <= time) return
  clearTimeout(roomCheck?.timer)
  const timer = setTimeout(async () => {
    roomCheck = null
    const current = await getRoom()
    if (current?.id !== room.id || current.error) return
    if (ticking) checkRoomAt(room, Date.now() + 50)
    else void tick({ frameId: 0, tab: { id: current.tabId } })
  }, Math.max(0, time - Date.now()))
  roomCheck = { id: room.id, timer, time }
}

async function enrollHost(room, messages) {
  const host = messages.find(message => message.type === 'host' && message.id === room.id)
  if (!host) {
    if (room.hostWriteRequested) return
    if (messages.some(message => message.type === 'host' && message.session === room.sessionName)) {
      room.sessionName = room.sessionName.slice(0, 63) + '-' + room.id
    }
    room.hostWriteRequested = true
    await chrome.storage.session.set({ room, roomNote: 'Ожидаем запись Host в комнате…' })
    const previous = room.reuse ? activeHost(messages) : null
    const close = previous ? signalLine({
      type: 'hostLeft', id: crypto.randomUUID(), from: room.name,
      session: previous.session, hostId: previous.id,
    }) : ''
    const line = signalLine({ type: 'host', id: room.id, from: room.name, session: room.sessionName })
    const log = isDebuggabel ? debugLine(room.name, 'State changed to Signaling') : ''
    const append = room.reuse || room.election
    const result = await editor(room.tabId, append ? 'append' : 'replace', (append ? '\n' : '') + close + line + log)
    if (result.waiting && (await getRoom())?.id === room.id) {
      delete room.hostWriteRequested
      await chrome.storage.session.set({ room, roomNote: result.message })
    }
    return
  }

  const active = activeHost(messages)
  if (active?.id === host.id) return beginConnection(room, host)
  room.role = 'participant'
  await enrollParticipant(room, messages)
}

function activeHost(messages) {
  let host
  for (const message of messages) {
    if (!host && message.type === 'host') host = message
    else if (message.type === 'hostLeft' && message.hostId === host?.id && message.session === host.session) {
      host = undefined
    }
  }
  return host
}

async function waitForHost(room, messages) {
  const lastElection = messages.findLast(message => ['host', 'hostLeft', 'nominated_host'].includes(message.type))
  room.election = { after: lastElection?.id, waitUntil: Date.now() + 1000 }
  await chrome.storage.session.set({ room, roomNote: 'Ожидаем хоста…' })
  checkRoomAt(room, room.election.waitUntil)
}

async function enrollParticipant(room, messages) {
  const host = activeHost(messages)
  if (host) {
    if (host.id === room.departedHostId) {
      return recordHostLeft({ ...room, hostId: host.id, session: host.session })
    }
    return beginConnection(room, host)
  }

  const round = room.election
  if (!round) return waitForHost(room, messages)
  if (Date.now() < round.waitUntil) return
  if (!round.nominationId) {
    const nominationId = crypto.randomUUID()
    const result = await editor(room.tabId, 'append', '\n' + signalLine({
      type: 'nominated_host', id: nominationId, from: room.name,
    }))
    if ((await getRoom())?.id !== room.id) return
    if (result.waiting) {
      await chrome.storage.session.set({ roomNote: result.message })
      return
    }
    round.nominationId = nominationId
    round.waitUntil = Date.now() + 500
    await chrome.storage.session.set({ room, roomNote: 'Выбираем хоста…' })
    checkRoomAt(room, round.waitUntil)
    return
  }

  const after = round.after ? messages.findLastIndex(message => message.id === round.after) : -1
  const first = messages.slice(after + 1).find(message => message.type === 'nominated_host')
  if (first?.id === round.nominationId) {
    room.role = 'host'
    room.sessionName = newSessionName()
    await chrome.storage.session.set({ room, roomNote: 'Начинаем новую сессию как хост…' })
    await enrollHost(room, messages)
  } else if (Date.now() >= round.waitUntil + 5000) {
    // The winner may have closed the tab before publishing Host. Start after its nomination.
    await waitForHost(room, messages)
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
    if (tab.discarded || roomLink(tab.url)?.url !== room.url) return
    const snapshot = await editor(room.tabId, 'read')
    if (snapshot.waiting) {
      await chrome.storage.session.set({ roomNote: snapshot.message })
      return
    }
    if (!room.session) {
      const messages = readSignals(snapshot.text)
      if (room.role === 'host') await enrollHost(room, messages)
      else await enrollParticipant(room, messages)
    } else await exchangeSignals(room, snapshot.text)
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
    if (room?.tabId === sender.tab.id && !room.error) {
      // The room tab may be backgrounded and its content timer throttled.
      checkRoomAt(room, Date.now() + 400)
    }
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
        signaling: 'Signaling', connection: 'Connection', reconnecting: 'Reconnecting', stable: 'Stable',
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
        if (current.phase === 'signaling' && !current.session && room?.session && room.session === m.session) {
          const waiting = {
            tabId: room.tabId, url: room.url, name: room.name, role: 'participant',
            id: crypto.randomUUID(), departedHostId: room.hostId,
          }
          await chrome.storage.session.set({ room: waiting, roomNote: 'Ожидаем участника…' })
          checkRoomAt(waiting, Date.now())
        } else if (current.phase === 'error' && room?.session && room.session === m.session &&
            (room.role === 'host' || m.hadAnswer)) {
          await recordHostLeft(room)
        }
        await chrome.storage.session.remove('warning')
        await clearStreamingTab()
      })
      return {}
    }
    if (m.type === 'streamStopped' && uuid(m.pageId)) {
      await runSiteOperation(() => clearStreamingTab(m.pageId, m.closeReceiver === true))
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
  if (m.type === 'create' || m.type === 'join') {
    await runSiteOperation(() => openRoom(m.type === 'create' ? 'host' : 'participant', m.url))
  } else if (m.type === 'capture') {
    await chrome.storage.session.remove('warning')
    await shareActivePage().catch(async error => {
      await chrome.storage.session.set({ warning: error.message })
      throw error
    })
  } else if (m.type === 'pause') {
    await runSiteOperation(async () => {
      const { state } = await rtc({ type: 'state' })
      if (state.stream) await stopStreaming({ ...state.stream, session: state.session }, undefined, true)
    })
  } else if (m.type === 'disconnect') await runSiteOperation(disconnectRoom)
  else if (m.type !== 'state') throw new Error('Неизвестная команда')
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
chrome.tabs.onRemoved.addListener((tabId) => {
  void runSiteOperation(async () => {
    const [room, site] = await Promise.all([getRoom(), getStreamingTab()])
    if (room?.tabId === tabId || site?.tabId === tabId) await disconnectRoom()
  }).catch(console.warn)
})
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.status && !change.url && change.discarded === undefined) return
  void runSiteOperation(() => updateStreamingTab(tabId)).catch(console.warn)
})
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void runSiteOperation(async () => {
    const [room, site] = await Promise.all([getRoom(), getStreamingTab()])
    if (room?.tabId === removedTabId) {
      const replacement = { ...room, tabId: addedTabId }
      await chrome.storage.session.set({ room: replacement })
      checkRoomAt(replacement, Date.now())
    }
    if (site?.tabId === removedTabId) {
      await suspendStreamingTab(site, addedTabId)
      await updateStreamingTab(addedTabId)
    }
  }).catch(console.warn)
})
chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  void runSiteOperation(async () => {
    const site = await getStreamingTab()
    if (site?.tabId === tabId && site.attached) {
      if (reason === 'target_closed') await suspendStreamingTab(site)
      else await stopStreaming(site, 'Chrome отключил отладчик. Стриминг приостановлен.')
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
