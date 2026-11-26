const MAX_TEXT = 1000000
const COMMANDS = new Map([
  ['host', 'Host'],
  ['participant', 'Participant'],
  ['offer', 'Offer'],
  ['answer', 'Answer'],
  ['ice', 'Ice'],
  ['restart', 'Restart'],
  ['reconnect', 'Reconnect'],
  ['hello', 'Hello'],
])
const TYPES = new Map([...COMMANDS].map(([type, label]) => [label, type]))

export const uuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

export const isName = value => typeof value === 'string' &&
  /^[\p{L}\p{M}][\p{L}\p{M} .’'\-]{0,47}$/u.test(value)

export const isSessionName = value => typeof value === 'string' && /^[a-z0-9/_-]{1,100}$/i.test(value)

export function roomLink(url) {
  try {
    const parsed = new URL(url)
    const roomId = parsed.pathname.split('/')[2]
    if (
      parsed.origin !== 'https://code.avito.ru' ||
      parsed.username ||
      parsed.password ||
      !uuid(roomId) ||
      !['/r/' + roomId, '/r/' + roomId + '/'].includes(parsed.pathname)
    ) return null

    return { roomId, url: parsed.origin + '/r/' + roomId }
  } catch {
    return null
  }
}

export function signalLine(message) {
  const fields = ['message_id=' + message.id, 'session=' + message.session]
  if (message.to) fields.push('to=' + encodeURIComponent(message.to))
  if (message.hostId) fields.push('host_id=' + message.hostId)
  if (message.generation) fields.push('generation=' + message.generation)
  // Keep the browser's native SDP and ICE payloads intact.
  if (message.description) fields.push('rtc=' + JSON.stringify(message.description))
  if (message.type === 'ice') fields.push('rtc=' + JSON.stringify(message.candidate))
  return '[' + message.from + '] ' + COMMANDS.get(message.type) + ': ' + fields.join(' ') + '\n'
}

export function readSignals(text, session) {
  if (typeof text !== 'string' || text.length > MAX_TEXT) {
    throw new Error('Комната слишком большая. Создайте новую')
  }

  const messages = []
  // Monaco in Avito uses CRLF. Strip the terminator before matching the command.
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.length > 100000) continue
    const header = /^\[([^\]]+)\]\s+([A-Za-z]+)\s*:\s+(.+)$/.exec(rawLine.trim())
    if (!header || !isName(header[1])) continue
    const [, from, label, body] = header
    const type = TYPES.get(label)
    if (!type) continue

    try {
      const rtcStart = body.indexOf(' rtc=')
      const metadata = rtcStart === -1 ? body : body.slice(0, rtcStart)
      const fields = new Map(metadata.split(/\s+/).map(field => field.split('=')))
      if (!uuid(fields.get('message_id'))) continue
      const name = fields.get('session')
      if (!isSessionName(name) || (session && name !== session)) continue
      const to = fields.has('to') ? decodeURIComponent(fields.get('to')) : null
      if (type !== 'host' && !isName(to)) continue
      const generation = Number(fields.get('generation') ?? 0)
      if (!Number.isSafeInteger(generation) || generation < 0) continue

      const message = { type, from, to, session: name, id: fields.get('message_id'), generation }
      if (type === 'participant') {
        message.hostId = fields.get('host_id')
        if (!uuid(message.hostId)) continue
      }
      if (type === 'ice' || type === 'offer' || type === 'answer') {
        if (rtcStart === -1) continue
        const rtc = JSON.parse(body.slice(rtcStart + ' rtc='.length))
        if (type === 'ice') message.candidate = rtc
        else message.description = rtc
      }
      messages.push(message)
    } catch {
      // The editor also contains free text and diagnostic comments.
    }
  }

  return messages
}
