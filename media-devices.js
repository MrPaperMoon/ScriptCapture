export const deviceName = { audio: 'микрофон', video: 'камера' }

export async function devicePermission(kind) {
  const name = kind === 'audio' ? 'microphone' : 'camera'
  return (await navigator.permissions.query({ name }).catch(() => null))?.state ?? 'prompt'
}

export async function devicePermissions() {
  const [audio, video] = await Promise.all([devicePermission('audio'), devicePermission('video')])
  return { audio, video }
}

export async function captureDevice(kind) {
  const media = await navigator.mediaDevices.getUserMedia(kind === 'audio'
    ? { audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false }
    : { audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { max: 24 } } })
  return media.getTracks()[0]
}
