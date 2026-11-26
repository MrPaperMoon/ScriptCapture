export const STUN = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
export function webUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Некорректный URL')
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Разрешены только HTTP(S) URL без пароля')
  return url.href
}
export function validClick(e) {
  if (
    !e ||
    typeof e.selector !== 'string' ||
    e.selector.length > 2048 ||
    !/^(?:#[a-zA-Z_][\w-]{0,79}|[a-z][a-z0-9-]*:nth-child\([1-9]\d*\))(?:>[a-z][a-z0-9-]*:nth-child\([1-9]\d*\)){0,47}$/i.test(
      e.selector,
    )
  )
    return false
  if (typeof e.frame !== 'string' || e.frame.length > 2048) return false
  try {
    const frame = new URL(webUrl(e.frame))
    if (frame.origin + frame.pathname !== e.frame) return false
  } catch {
    return false
  }
  const unit = (n) => Number.isFinite(n) && n >= 0 && n <= 1
  return (
    typeof e.top === 'boolean' &&
    typeof e.tag === 'string' &&
    /^[a-z][a-z0-9-]{0,79}$/i.test(e.tag) &&
    unit(e.x) &&
    unit(e.y) &&
    unit(e.pressure) &&
    ['mouse', 'touch', 'pen'].includes(e.pointerType) &&
    Number.isInteger(e.detail) &&
    e.detail >= 0 &&
    e.detail <= 255 &&
    Number.isSafeInteger(e.pointerId) &&
    typeof e.isPrimary === 'boolean'
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
  if (/^m=(audio|video) /m.test(value.sdp) || !/^m=application /m.test(value.sdp))
    throw new Error('Разрешён только DataChannel')
  return { type: value.type, sdp: value.sdp }
}
