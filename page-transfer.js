import { webUrl } from './protocol.js'
import { uuid } from './room-protocol.js'

export const MAX_PAGE_BYTES = 4 * 1024 * 1024
const CHUNK_BYTES = 8 * 1024
const BUFFER_LIMIT = 128 * 1024

function pageData(page) {
  const url = webUrl(page?.url)
  if (
    typeof page.html !== 'string' ||
    !page.html ||
    page.html.length > MAX_PAGE_BYTES ||
    !Number.isSafeInteger(page.omitted) ||
    page.omitted < 0
  ) {
    throw new Error('Некорректная копия страницы')
  }
  return { url, html: page.html, omitted: page.omitted }
}

export async function sendPage(channel, id, page) {
  if (!uuid(id)) throw new Error('Некорректный идентификатор копии')
  const bytes = new TextEncoder().encode(JSON.stringify(pageData(page)))
  if (bytes.length > MAX_PAGE_BYTES) throw new Error('Копия страницы превышает 4 МиБ')
  if (channel.readyState !== 'open') throw new Error('Канал передачи закрыт')

  const deadline = Date.now() + 60000
  channel.bufferedAmountLowThreshold = BUFFER_LIMIT / 2
  // The ordered channel delivers the size header before the binary chunks.
  channel.send(JSON.stringify({ type: 'pageBegin', id, bytes: bytes.length }))
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    if (channel.bufferedAmount > BUFFER_LIMIT) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => finish(new Error('Передача страницы заняла больше минуты')),
          Math.max(0, deadline - Date.now()),
        )
        const drain = () => finish()
        const closed = () => finish(new Error('Канал передачи закрыт'))
        function finish(error) {
          clearTimeout(timeout)
          channel.removeEventListener('bufferedamountlow', drain)
          channel.removeEventListener('close', closed)
          if (error) reject(error)
          else resolve()
        }
        channel.addEventListener('bufferedamountlow', drain, { once: true })
        channel.addEventListener('close', closed, { once: true })
      })
    }
    if (channel.readyState !== 'open') throw new Error('Канал передачи закрыт')
    channel.send(bytes.subarray(offset, offset + CHUNK_BYTES))
  }
  return bytes.length
}

export function beginPage(message) {
  if (
    !uuid(message.id) ||
    !Number.isInteger(message.bytes) ||
    message.bytes < 1 ||
    message.bytes > MAX_PAGE_BYTES
  ) {
    throw new Error('Недопустимый размер копии страницы')
  }
  return { id: message.id, bytes: new Uint8Array(message.bytes), offset: 0 }
}

export function readPageChunk(transfer, chunk) {
  if (!transfer || chunk.byteLength !== Math.min(CHUNK_BYTES, transfer.bytes.length - transfer.offset)) {
    throw new Error('Неверная часть копии страницы')
  }
  transfer.bytes.set(new Uint8Array(chunk), transfer.offset)
  transfer.offset += chunk.byteLength
  if (transfer.offset !== transfer.bytes.length) return null
  const json = new TextDecoder('utf-8', { fatal: true }).decode(transfer.bytes)
  return { id: transfer.id, ...pageData(JSON.parse(json)) }
}
