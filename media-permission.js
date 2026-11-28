import { devicePermissions } from './media-devices.js'

const allow = document.getElementById('allow-device')
const skip = document.getElementById('skip')
const errorMessage = document.getElementById('permission-error')
const kinds = ['audio', 'video']
const labels = { granted: 'Разрешено', denied: 'Заблокировано', prompt: 'Нужен доступ', unavailable: 'Не найдено' }

async function inspectDevices(granted = []) {
  const [permissions, devices] = await Promise.all([devicePermissions(), navigator.mediaDevices.enumerateDevices()])
  for (const kind of kinds) {
    const present = devices.some(device => device.kind === kind + 'input')
    const state = granted.includes(kind) ? 'granted' : permissions[kind]
    permissions[kind] = !present && state === 'prompt' ? 'unavailable' : state
    const status = document.getElementById(kind + '-status')
    status.dataset.status = permissions[kind]
    status.textContent = labels[permissions[kind]]
  }
  allow.textContent = kinds.every(kind => permissions[kind] === 'granted') ? 'Готово' : 'Разрешить доступ'
  return permissions
}

async function finish(data) {
  const response = await chrome.runtime.sendMessage({ target: 'background', type: 'finishMediaPermissions', ...data })
  if (!response?.ok) throw new Error(response?.error ?? 'Расширение недоступно')
}

function showError(error) {
  errorMessage.textContent = error.name === 'NotAllowedError'
    ? 'Разрешите доступ в настройках Chrome и системы, затем повторите попытку.'
    : error.name === 'NotReadableError' ? 'Chrome не удалось открыть устройство. Проверьте, не занято ли оно другим приложением.' : error.message
  errorMessage.hidden = false
}

allow.onclick = async () => {
  allow.disabled = true
  errorMessage.hidden = true
  try {
    const permissions = await inspectDevices()
    const granted = kinds.filter(kind => permissions[kind] === 'granted')
    const audio = permissions.audio === 'prompt'
    const video = permissions.video === 'prompt'
    if (audio || video) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video })
      for (const track of stream.getTracks()) {
        granted.push(track.kind)
        track.stop()
      }
    }
    await inspectDevices(granted)
    if (!granted.length) throw new Error('Проверьте подключение устройств и доступ к ним в настройках Chrome.')
    await finish({ granted })
  } catch (error) {
    await inspectDevices().catch(console.warn)
    showError(error)
    allow.disabled = false
  }
}

skip.onclick = () => void finish({ skip: true }).catch(showError)
void inspectDevices().then(() => { allow.disabled = false }).catch(showError)
