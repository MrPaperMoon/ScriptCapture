export const STUN = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
export function webUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Некорректный URL')
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Разрешены только HTTP(S) URL без пароля')
  return url.href
}
export const pointerConfig = {
  types: [
    'pointerover', 'pointerenter', 'pointerdown', 'pointermove', 'pointerrawupdate', 'pointerup',
    'pointercancel', 'pointerout', 'pointerleave', 'gotpointercapture', 'lostpointercapture',
    'click', 'auxclick', 'contextmenu',
  ],
  numberArgs: [
    'button', 'buttons', 'detail', 'pointerId', 'width', 'height', 'pressure', 'tangentialPressure',
    'tiltX', 'tiltY', 'twist', 'screenX', 'screenY', 'movementX', 'movementY',
  ],
  optionalNumberArgs: ['altitudeAngle', 'azimuthAngle'],
  flagArgs: ['bubbles', 'cancelable', 'composed', 'isPrimary', 'ctrlKey', 'altKey', 'shiftKey', 'metaKey'],
  // Resource and metadata elements do not count toward a widget's position.
  skip: 'base,frame,iframe,object,embed,meta,link,script,style,title',
  excluded: 'a[href],form,input,textarea,select,[contenteditable]:not([contenteditable="false"])',
  maxDepth: 48,
}

function validElementPath(path) {
  return Array.isArray(path) && path.length <= pointerConfig.maxDepth && path.every(step =>
    Array.isArray(step) && step.length === 3 &&
    Number.isSafeInteger(step[0]) && step[0] >= 0 &&
    typeof step[1] === 'string' && step[1].length > 0 && step[1].length <= 80 &&
    typeof step[2] === 'boolean',
  )
}

export function validFrameResource(resource) {
  if (['about:blank', 'about:srcdoc'].includes(resource)) return true
  if (typeof resource !== 'string' || resource.length > 2048) return false
  try {
    const url = new URL(webUrl(resource))
    return resource === url.origin + url.pathname
  } catch {
    return false
  }
}

function validFrame(frame) {
  if (!validElementPath(frame?.path) || frame.path.at(-1)?.[1] !== 'iframe' ||
      frame.path.some(step => step[2])) return false
  return validFrameResource(frame.resource)
}

export function validStructure(frames) {
  return Array.isArray(frames) && frames.length <= 128 && frames.every(validFrame)
}

export function validPointer(event) {
  const args = event?.args
  const bounded = (value) => Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
  return (
    pointerConfig.types.includes(event?.type) &&
    validElementPath(event.path) &&
    (event.relatedPath === null || validElementPath(event.relatedPath)) &&
    bounded(event.x) &&
    bounded(event.y) &&
    Boolean(args) &&
    typeof args.pointerType === 'string' &&
    args.pointerType.length <= 32 &&
    typeof args.hasView === 'boolean' &&
    pointerConfig.numberArgs.every(key => bounded(args[key])) &&
    pointerConfig.optionalNumberArgs.every(key => args[key] === undefined || bounded(args[key])) &&
    pointerConfig.flagArgs.every(key => typeof args[key] === 'boolean')
  )
}
export function decodeSignal(text) {
  if (typeof text !== 'string' || text.length > 100000) throw new Error('Слишком большой код')
  const value = JSON.parse(text)
  if (
    value.v !== 1 ||
    !['offer', 'answer'].includes(value.type) ||
    typeof value.sdp !== 'string' ||
    !value.sdp.startsWith('v=0')
  )
    throw new Error('Неверный код подключения')
  const media = [...value.sdp.matchAll(/^m=(\S+) /gm)].map(match => match[1])
  if (!media.includes('application') || new Set(media).size !== media.length ||
      media.some(kind => !['application', 'audio', 'video'].includes(kind)))
    throw new Error('Ожидаются DataChannel и до одной дорожки аудио и видео')
  return { type: value.type, sdp: value.sdp }
}
