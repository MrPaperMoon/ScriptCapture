const get = (id) => document.getElementById(id)
const roomInput = get('link')
const status = get('status')
const errorMessage = get('error')
const buttons = document.querySelectorAll('button')
let working = false

async function request(type) {
  const url = type === 'join' ? roomInput.value : undefined
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

  status.textContent = phaseNames[state.phase] + ' · ' + name + ' · ' + state.status
  const canCopy = room?.role === 'host' && Boolean(room.url)
  get('setup').hidden = streaming || (ready && !canCopy)
  get('ready').hidden = !ready
  get('capture').hidden = streaming
  get('pause').hidden = !streaming
  get('join').hidden = !idle || Boolean(room)
  get('create').hidden = !idle || Boolean(room)
  get('copy').hidden = !canCopy
  get('disconnect').hidden = !room && idle

  roomInput.readOnly = Boolean(room)
  if (room) roomInput.value = room.url ?? ''

  get('roomNote').textContent = roomNote || ''
  let hint = 'Capture on site передаёт клики страницы и её прямых iframe.'
  if (streaming) {
    hint = streamingTab?.attached && streamingTab.pageId === state.stream.pageId
      ? 'Оба участника могут управлять страницей. ' + state.stream.url
      : 'Подключаем вкладку сайта.'
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
    await navigator.clipboard.writeText(roomInput.value)
    get('roomNote').textContent = 'Ссылка скопирована'
  } catch (error) {
    errorMessage.textContent = error.message
  }
}

void refresh()
setInterval(refresh, 700)
