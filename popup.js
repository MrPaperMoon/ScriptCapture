import { roomLink } from './room-protocol.js'

const get = (id) => document.getElementById(id)
const roomInput = get('link')
const status = get('status')
const errorMessage = get('error')
const buttons = document.querySelectorAll('button')
let working = false
let roomUrl = ''
let linkEdited = false

roomInput.oninput = () => { linkEdited = true }
void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (!linkEdited) roomInput.value = roomLink(tab?.url)?.url ?? ''
}).catch(console.warn)

async function request(type) {
  const url = type === 'join' || type === 'create' ? roomInput.value : undefined
  const response = await chrome.runtime.sendMessage({ target: 'background', type, url })

  if (!response?.ok) {
    throw new Error(response?.error || 'Расширение недоступно')
  }

  return response
}

const phaseNames = {
  idle: 'IDLE',
  signaling: 'Signaling',
  connection: 'Connection',
  stable: 'Stable',
  streaming: 'Streaming',
  reconnecting: 'Reconnecting',
  error: 'Error',
}

function render({ state, streamingTab, warning, room, roomNote, name }) {
  const streaming = state.phase === 'streaming'
  const ready = state.phase === 'stable' || streaming
  const idle = state.phase === 'idle'
  const signaling = state.phase === 'signaling'

  status.textContent = phaseNames[state.phase] + ' · ' + name + ' · ' + state.status
  const canCopy = Boolean(room?.url) && (signaling || room.role === 'host')
  roomUrl = room?.url ?? ''
  get('setup').hidden = !idle || Boolean(room)
  get('ready').hidden = !ready
  get('capture').hidden = streaming
  get('pause').hidden = !streaming
  get('copy').hidden = streaming || !canCopy
  get('disconnect').hidden = !room && idle

  get('roomNote').textContent = streaming ? '' : roomNote || ''
  let hint = 'Смотрите видео вместе и управляйте просмотром с любого устройства.'
  if (streaming) {
    hint = streamingTab?.attached && streamingTab.pageId === state.stream.pageId
      ? 'Оба участника могут управлять страницей. ' + state.stream.url
      : 'Ждём загрузки страницы…'
  }

  get('site').textContent = warning || hint
}

async function refresh() {
  if (working) return

  try {
    render(await request('state'))
  } catch (error) {
    errorMessage.textContent = error.message
  }
}

async function act(type) {
  if (working) return

  working = true
  errorMessage.textContent = ''
  for (const button of buttons) button.disabled = true

  try {
    await request(type)
  } catch (error) {
    errorMessage.textContent = error.message
  } finally {
    working = false
    for (const button of buttons) button.disabled = false
    await refresh()
  }
}

for (const id of ['create', 'join', 'capture', 'pause', 'disconnect']) {
  get(id).onclick = () => act(id)
}

get('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(roomUrl)
    get('roomNote').textContent = 'Ссылка скопирована'
  } catch (error) {
    errorMessage.textContent = error.message
  }
}

void refresh()
setInterval(refresh, 700)
