import { roomLink } from './room-protocol.js'
import { previewDescription, previewPort } from './media-preview.js'

const get = (id) => document.getElementById(id)
const roomInput = get('link')
const status = get('status')
const errorMessage = get('error')
const buttons = document.querySelectorAll('button')
let working = false
let roomUrl = ''
let linkEdited = false
let preview
const remoteVideo = get('remote-video')
const noVideoSignal = get('no-video-signal')

roomInput.oninput = () => { linkEdited = true }
void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (!linkEdited) roomInput.value = roomLink(tab?.url)?.url ?? ''
}).catch(console.warn)

async function request(type, kind) {
  const url = type === 'join' || type === 'create' ? roomInput.value : undefined
  const response = await chrome.runtime.sendMessage({ target: 'background', type, url, kind })

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

function updateVideoSignal() {
  const track = remoteVideo.srcObject?.getVideoTracks()[0]
  noVideoSignal.hidden = track?.readyState === 'live' && !track.muted &&
    remoteVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
}

remoteVideo.onloadeddata = updateVideoSignal

function stopPreview() {
  if (!preview) return
  const { pc, port } = preview
  preview = null
  pc.close()
  port.disconnect()
  remoteVideo.srcObject = null
  updateVideoSignal()
}

async function startPreview() {
  const pc = new RTCPeerConnection()
  const port = chrome.runtime.connect({ name: previewPort })
  preview = { pc, port }
  pc.addTransceiver('video', { direction: 'recvonly' })
  pc.ontrack = ({ track }) => {
    if (preview?.pc === pc) remoteVideo.srcObject = new MediaStream([track])
  }
  port.onDisconnect.addListener(() => {
    if (preview?.pc === pc) stopPreview()
  })
  port.onMessage.addListener(async (answer) => {
    try {
      await pc.setRemoteDescription(answer)
    } catch (error) {
      if (preview?.pc === pc) {
        stopPreview()
        errorMessage.textContent = error.message
      }
    }
  })
  try {
    const offer = await previewDescription(pc)
    if (preview?.pc === pc) port.postMessage(offer)
  } catch (error) {
    if (preview?.pc === pc) {
      stopPreview()
      errorMessage.textContent = error.message
    }
  }
}

function renderControl(id, enabled, available, icon, title) {
  const button = get(id)
  button.disabled = working || !available
  button.setAttribute('aria-pressed', String(enabled))
  button.title = title
  button.querySelector('img').src = 'icons/' + icon + '.svg'
}

function renderMedia(media, ready) {
  const { microphone, speaker, camera, remoteCamera, audioAvailable, videoAvailable } = media
  renderControl('microphone', microphone, audioAvailable, microphone ? 'mic' : 'mic_off',
    microphone ? 'Выключить микрофон' : 'Включить микрофон')
  renderControl('speaker', speaker, ready, speaker ? 'volume_up' : 'volume_off',
    speaker ? 'Выключить звук собеседника' : 'Включить звук собеседника')
  renderControl('camera', camera, videoAvailable, camera ? 'camera_video' : 'camera_video_off',
    camera ? 'Выключить камеру' : 'Включить камеру')

  const receiveVideo = ready && remoteCamera
  get('call-video').hidden = !ready || (!camera && !remoteCamera)
  if (receiveVideo && !preview) void startPreview()
  if (!receiveVideo) stopPreview()
  updateVideoSignal()
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
  renderMedia(state.media, ready)

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

async function act(type, kind) {
  if (working) return

  working = true
  errorMessage.textContent = ''
  for (const button of buttons) button.disabled = true

  try {
    await request(type, kind)
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
get('microphone').onclick = () => act('toggleDevice', 'audio')
get('speaker').onclick = () => act('toggleSpeaker')
get('camera').onclick = () => act('toggleDevice', 'video')

get('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(roomUrl)
    get('roomNote').textContent = 'Ссылка скопирована'
  } catch (error) {
    errorMessage.textContent = error.message
  }
}

void refresh()
void request('prepareMedia').catch(error => { errorMessage.textContent = error.message })
setInterval(refresh, 700)
