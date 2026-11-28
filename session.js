import { STUN, decodeSignal, validFrameResource, validPointer, validStructure, webUrl } from './protocol.js'
import { readSignals, isName, isSessionName, uuid } from './room-protocol.js'

export class WatchSession {
  constructor({
    onState = () => {},
    onClose = () => {},
    onData = () => {},
    onSite = () => {},
    onStop = () => {},
    onSent = () => {},
  } = {}) {
    this.onSite = onSite
    this.onStop = onStop
    this.onSent = onSent
    this.onState = onState
    this.onClose = onClose
    this.onData = onData
    this.peers = new Map()
    this.seen = new Set()
    this.outbox = []
    this.phase = 'idle'
    this.status = 'Готов к подключению'
  }
  get negotiating() {
    return this.phase === 'connection' || this.phase === 'reconnecting'
  }
  get connected() {
    return this.phase === 'stable' || this.phase === 'streaming'
  }
  state() {
    return {
      id: this.id,
      session: this.session,
      phase: this.phase,
      status: this.status,
      stream: this.stream ?? null,
      peers: this.peers.size,
      connected: [...this.peers.values()].filter((p) => p.channel?.readyState === 'open').length,
    }
  }
  transition(phase, status) {
    const changed = this.phase !== phase
    this.phase = phase
    this.status = status
    if (changed) this.onState(phase, status)
  }
  startStream({ pageId, url }) {
    this.stream = { pageId, url: webUrl(url) }
    this.transition('streaming', 'Клики синхронизируются')
  }
  endStream(closeReceiver = false) {
    if (!this.stream) return
    const { pageId } = this.stream
    this.stream = null
    this.onStop(pageId, this.session, closeReceiver)
  }
  pauseStream(closeReceiver) {
    this.endStream(closeReceiver)
    this.transition('stable', 'Стриминг приостановлен')
  }
  async start({ session, name, host, hostId, turn }) {
    if (!isSessionName(session) || ![name, host].every(isName)) {
      throw new Error('Некорректная комната')
    }
    if (this.phase !== 'idle' && !(this.phase === 'signaling' && !this.session)) {
      throw new Error('Сначала отключитесь от текущей комнаты')
    }
    this.id = name
    this.session = session
    this.host = host
    this.hostId = hostId
    this.partner = host === name ? null : host
    this.generation = 0
    this.rtcConfig = turn ? { iceServers: [...STUN.iceServers, turn] } : STUN
    if (host === name) {
      this.transition('signaling', 'Ожидаем участника. Скопируйте ссылку на комнату.')
      return
    }
    this.transition('connection', 'Устанавливаем соединение')
    this.timer = setTimeout(() => this.fail('Время ожидания истекло. Создайте новое подключение'), 180000)
    await this.offer(host)
  }
  async offer(partner) {
    const peer = this.peer(partner, true)
    await peer.pc.setLocalDescription(await peer.pc.createOffer())
    if (this.peers.get(partner) === peer) {
      this.publishDescription(partner, peer, 'offer')
    }
  }
  publishDescription(id, peer, type) {
    this.signal(id, type, { description: peer.pc.localDescription.toJSON() })
    for (const candidate of peer.localCandidates) this.signal(id, 'ice', { candidate })
    peer.localCandidates = null
  }
  signal(to, type, data = {}) {
    if (this.phase === 'idle' || this.phase === 'error') return
    if (this.outbox.length >= 200) throw new Error('Слишком много сообщений подключения')
    this.outbox.push({
      session: this.session,
      id: crypto.randomUUID(),
      from: this.id,
      to,
      type,
      generation: this.generation,
      ...data,
    })
  }
  releasePeer(id) {
    const previous = this.peers.get(id)
    if (!previous) return
    this.peers.delete(id)
    clearTimeout(previous.timer)
    clearTimeout(previous.lostTimer)
    previous.pc.close()
  }
  recover(id, peer, reason) {
    if (this.peers.get(id) !== peer || peer.closing) return
    if (!peer.opened) {
      this.connectionFailed(reason)
      return
    }
    this.releasePeer(id)
    this.endStream()
    this.transition('reconnecting', 'Восстанавливаем соединение через комнату Avito…')
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.connectionFailed('Участник не ответил при восстановлении соединения'), 180000)
    if (this.host === this.id) {
      this.generation++
      this.signal(id, 'restart')
    } else {
      this.signal(id, 'reconnect')
    }
  }
  peer(id, initiator) {
    if (this.peers.size) throw new Error('Оба места заняты')
    const pc = new RTCPeerConnection(this.rtcConfig),
      p = { pc, candidates: [], localCandidates: [], channel: null }
    this.peers.set(id, p)
    p.timer = setTimeout(() => {
      if (this.peers.get(id) === p)
        this.connectionFailed('Участник не подключился за 3 минуты. Попробуйте новую комнату или TURN')
    }, 180000)
    pc.onicecandidate = ({ candidate }) => {
      if (this.peers.get(id) !== p) return
      try {
        const value = candidate?.toJSON() ?? null
        if (p.localCandidates) p.localCandidates.push(value)
        else this.signal(id, 'ice', { candidate: value })
      } catch (e) {
        this.fail(e.message)
      }
    }
    const connectionFailure = () => {
      const stage = p.opened ? 'Открытый канал прервался' : 'Канал WebRTC не открылся'
      const dtls = pc.sctp?.transport?.state ?? 'недоступно'
      const detail = 'ICE: ' + pc.iceConnectionState + ', DTLS: ' + dtls + ', соединение: ' + pc.connectionState
      const suggestion =
        this.rtcConfig === STUN && pc.iceConnectionState === 'failed'
          ? '. В этой сети может потребоваться TURN'
          : ''
      return stage + ' (' + detail + ')' + suggestion
    }
    pc.onconnectionstatechange = () => {
      if (this.peers.get(id) !== p) return
      if (['failed', 'closed'].includes(pc.connectionState)) this.recover(id, p, connectionFailure())
      if (pc.connectionState === 'disconnected')
        p.lostTimer ??= setTimeout(() => this.recover(id, p, connectionFailure()), 15000)
      else {
        clearTimeout(p.lostTimer)
        p.lostTimer = null
      }
    }
    pc.ondatachannel = ({ channel }) => this.bind(id, p, channel)
    if (initiator) this.bind(id, p, pc.createDataChannel('watch-together', { ordered: true }))
    return p
  }
  bind(id, p, channel) {
    if (p.channel || channel.label !== 'watch-together') {
      channel.close()
      return
    }
    p.channel = channel
    channel.onopen = () => {
      if (this.peers.get(id) !== p) return
      p.opened = true
      clearTimeout(p.timer)
      if (this.host === this.id) this.finish()
    }
    channel.onclose = () => {
      if (this.peers.get(id) === p) this.recover(id, p, 'Участник отключился')
    }
    channel.onerror = () => {
      if (this.peers.get(id) === p) this.recover(id, p, 'Ошибка DataChannel')
    }
    channel.onmessage = ({ data }) => {
      if (this.peers.get(id) !== p || p.closing) return
      try {
        if (typeof data !== 'string' || data.length > 65536) throw new Error('Некорректное сообщение')
        const m = JSON.parse(data)
        if (m.type === 'bye') {
          this.close('Ожидаем участника…', 'signaling')
          return
        }
        if (m.type === 'start' && id === this.host && this.host !== this.id && this.negotiating) {
          this.ready()
          return
        }
        if (!this.connected) throw new Error('Команда до старта просмотра')
        this.validateData(m)
        if (m.type === 'site') {
          // Simultaneous Capture requests converge on the same stream on both peers.
          if (this.stream && this.stream.pageId <= m.pageId) return
          this.endStream()
          this.startStream(m)
          this.onSite({ ...this.stream, frames: m.frames })
          return
        }
        if (m.pageId !== this.stream?.pageId) return
        if (m.type === 'stop') {
          this.pauseStream(m.closeReceiver)
          return
        }
        this.onData(m)
      } catch (e) {
        this.fail(e.message)
      }
    }
  }
  validateData(m) {
    if (!uuid(m.pageId)) throw new Error('Некорректный идентификатор сайта')
    if (m.type === 'stop' && (m.closeReceiver === undefined || typeof m.closeReceiver === 'boolean')) return
    if (m.type === 'site' || m.type === 'structure') {
      if (m.type === 'site') webUrl(m.url)
      if (!validStructure(m.frames)) throw new Error('Некорректная структура iframe')
      return
    }
    const validFrame = m.frame === null ||
      (Number.isInteger(m.frame) && m.frame >= 0 && m.frame < 128 && validFrameResource(m.document))
    if (m.type !== 'pointer' || !validFrame || m.event?.type !== 'click' || !validPointer(m.event)) {
      throw new Error('Неизвестная команда')
    }
  }
  broadcast(m) {
    if ([...this.peers.values()].some(p => p.channel?.readyState !== 'open' ||
        (!['stop', 'bye'].includes(m.type) && p.channel.bufferedAmount > 65536)))
      throw new Error('Канал не готов или перегружен')
    const wire = JSON.stringify(m)
    if (new TextEncoder().encode(wire).length > 65536) throw new Error('Сообщение превышает лимит DataChannel')
    for (const [to, peer] of this.peers) {
      peer.channel.send(wire)
      this.onSent({
        time: new Date().toISOString(),
        session: this.session,
        from: this.id,
        to,
        payload: JSON.parse(wire),
      })
    }
  }
  send(m) {
    if (m.type === 'site' ? this.phase !== 'stable' : this.stream?.pageId !== m.pageId)
      throw new Error('Состояние стриминга изменилось')
    this.validateData(m)
    this.broadcast(m)
    if (m.type === 'site') this.startStream(m)
    if (m.type === 'stop') this.pauseStream(m.closeReceiver)
  }
  finish() {
    if (this.host !== this.id || !this.negotiating) throw new Error('Ожидаем создателя комнаты')
    if (!this.peers.size) throw new Error('Ожидаем хотя бы одного участника')
    this.broadcast({ type: 'start' })
    this.ready()
  }
  ready() {
    clearTimeout(this.timer)
    this.transition('stable', 'Соединение установлено')
  }
  async receive(text) {
    if (!this.session || this.phase === 'error') return
    const session = this.session
    const messages = readSignals(text, session)
    // An open DataChannel still receives bye. During handshake, the editor is the only notification path.
    if (!this.connected && this.hostId && messages.some(m =>
      m.type === 'hostLeft' && m.session === session && m.hostId === this.hostId)) {
      this.connectionFailed('Попытка подключения завершена')
      return
    }
    for (const m of messages) {
      if (this.session !== session) return
      if (this.partner && m.from !== this.partner) continue
      if (m.to !== this.id || m.from === this.id || this.seen.has(m.id)) continue
      if (this.host !== this.id && m.from !== this.host) continue
      if (this.seen.size >= 5000) throw new Error('Слишком много сообщений в комнате')
      this.seen.add(m.id)
      let p = this.peers.get(m.from)
      const generation = m.generation ?? 0
      if (
        m.type === 'restart' &&
        m.from === this.host &&
        Number.isSafeInteger(generation) &&
        generation === this.generation + 1
      ) {
        this.releasePeer(m.from)
        this.endStream()
        this.generation = generation
        this.transition('reconnecting', 'Восстанавливаем соединение через комнату Avito…')
        clearTimeout(this.timer)
        this.timer = setTimeout(() => this.fail('Истекло время восстановления соединения'), 180000)
        await this.offer(m.from)
        continue
      }
      // Candidates and descriptions belong to one ICE generation.
      if (generation !== this.generation) continue
      if (m.type === 'reconnect' && this.host === this.id && p?.opened) {
        this.recover(m.from, p, 'Участник запросил переподключение')
        continue
      }
      if (m.type === 'offer' && this.host === this.id) {
        if (p?.pc.remoteDescription) continue
        if (m.description?.type !== 'offer') throw new Error('Ожидается offer')
        p ??= this.peer(m.from, false)
        await p.pc.setRemoteDescription(decodeSignal(JSON.stringify({ v: 1, ...m.description })))
        if (this.peers.get(m.from) !== p) return
        this.partner = m.from
        if (this.phase === 'signaling') this.transition('connection', 'Устанавливаем соединение')
        for (const c of p.candidates) await p.pc.addIceCandidate(c)
        p.candidates = []
        await p.pc.setLocalDescription(await p.pc.createAnswer())
        if (this.peers.get(m.from) !== p) return
        this.publishDescription(m.from, p, 'answer')
      } else if (
        m.type === 'answer' &&
        this.host !== this.id &&
        p?.pc.signalingState === 'have-local-offer'
      ) {
        if (m.description?.type !== 'answer') throw new Error('Ожидается answer')
        await p.pc.setRemoteDescription(decodeSignal(JSON.stringify({ v: 1, ...m.description })))
        for (const c of p.candidates) await p.pc.addIceCandidate(c)
        p.candidates = []
      } else if (m.type === 'ice') {
        if (!p) continue
        if (
          m.candidate !== null &&
          (!m.candidate || typeof m.candidate.candidate !== 'string' || m.candidate.candidate.length > 4096)
        )
          throw new Error('Неверный ICE-кандидат')
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(m.candidate)
        else {
          if (p.candidates.length >= 128) throw new Error('Слишком много ICE-кандидатов')
          p.candidates.push(m.candidate)
        }
      }
    }
  }
  fail(reason) {
    this.close(reason, 'error')
  }
  connectionFailed(reason) {
    if (this.host === this.id) this.close(reason + '. Ожидаем участника…', 'signaling')
    else this.fail(reason)
  }
  async disconnect() {
    const peer = this.peers.values().next().value
    try {
      if (this.connected && peer?.channel?.readyState === 'open') {
        const channel = peer.channel
        peer.closing = true
        // Closing the DataChannel lets WebRTC flush the queued bye before closing the peer.
        await new Promise(resolve => {
          const timer = setTimeout(finish, 1000)
          function finish() {
            clearTimeout(timer)
            channel.removeEventListener('close', finish)
            resolve()
          }
          channel.addEventListener('close', finish, { once: true })
          channel.close()
        })
      }
    } finally {
      this.close()
    }
  }
  close(reason = 'Соединение закрыто', phase = 'idle') {
    const previous = this.session
    const hadAnswer = phase === 'error' && this.host !== this.id &&
      Boolean(this.peers.get(this.host)?.pc.remoteDescription)
    clearTimeout(this.timer)
    for (const id of this.peers.keys()) this.releasePeer(id)
    this.endStream()
    this.transition(phase, reason)
    this.outbox = []
    this.seen.clear()
    this.session = null
    this.host = null
    this.hostId = null
    this.partner = null
    this.onClose(previous, hadAnswer)
  }
}
