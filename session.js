import { STUN, decodeSignal, validClick, webUrl } from './protocol.js'
import { readSignals, isName, isSessionName, uuid } from './room-protocol.js'
import { beginPage, readPageChunk, sendPage } from './page-transfer.js'

export class WatchSession {
  constructor({
    onState = () => {},
    onClose = () => {},
    onData = () => {},
    onPage = () => {},
    onSent = () => {},
  } = {}) {
    this.onPage = onPage
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
  state() {
    return {
      id: this.id,
      session: this.session,
      phase: this.phase,
      status: this.status,
      isStreamingHost: this.isStreamingHost === true,
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
  async start({ session, name, host, partner, turn }) {
    if (!isSessionName(session) || ![name, host, partner].every(isName) || name === partner) {
      throw new Error('Некорректная комната')
    }
    if (this.phase !== 'idle') throw new Error('Сначала отключитесь от текущей комнаты')
    this.id = name
    this.session = session
    this.host = host
    this.partner = partner
    this.generation = 0
    this.rtcConfig = turn ? { iceServers: [...STUN.iceServers, turn] } : STUN
    this.transition('connection', 'Устанавливаем соединение')
    this.timer = setTimeout(() => this.fail('Время ожидания истекло. Создайте новое подключение'), 180000)
    if (host === name) await this.offer(partner)
  }
  async offer(partner) {
    const peer = this.peer(partner, true)
    await peer.pc.setLocalDescription(await peer.pc.createOffer())
    if (this.peers.get(partner) === peer) {
      this.signal(partner, 'offer', { description: peer.pc.localDescription.toJSON() })
    }
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
    if (this.peers.get(id) !== peer) return
    if (!peer.opened) {
      this.fail(reason)
      return
    }
    this.releasePeer(id)
    this.transition('reconnecting', 'Восстанавливаем соединение через комнату Avito…')
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.fail('Участник не ответил при восстановлении соединения'), 180000)
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
      p = { pc, candidates: [], channel: null }
    this.peers.set(id, p)
    p.timer = setTimeout(() => {
      if (this.peers.get(id) === p)
        this.fail('Участник не подключился за 3 минуты. Попробуйте новую комнату или TURN')
    }, 180000)
    pc.onicecandidate = ({ candidate }) => {
      if (this.peers.get(id) !== p) return
      try {
        this.signal(id, 'ice', { candidate: candidate?.toJSON() ?? null })
      } catch (e) {
        this.fail(e.message)
      }
    }
    const connectionFailure = () => {
      const stage = p.opened ? 'Открытый канал прервался' : 'Канал WebRTC не открылся'
      const detail = 'ICE: ' + pc.iceConnectionState + ', соединение: ' + pc.connectionState
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
    channel.binaryType = 'arraybuffer'
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
      if (this.peers.get(id) !== p) return
      try {
        if (data instanceof ArrayBuffer) {
          if (this.phase !== 'stable') throw new Error('Копия страницы до старта сеанса')
          const page = readPageChunk(p.pageTransfer, data)
          if (page) {
            delete p.pageTransfer
            this.isStreamingHost = false
            this.onPage(page)
          }
          return
        }
        if (typeof data !== 'string' || data.length > 12000) throw new Error('Некорректное сообщение')
        const m = JSON.parse(data)
        if (m.type === 'bye') {
          this.close('Участник отключился')
          return
        }
        if (m.type === 'start' && id === this.host && this.host !== this.id && this.negotiating) {
          this.ready()
          return
        }
        if (this.phase !== 'stable') throw new Error('Команда до старта просмотра')
        if (m.type === 'pageBegin') {
          p.pageTransfer = beginPage(m)
          return
        }
        this.validateData(m)
        if (this.host === this.id) this.broadcast(m, id)
        this.onData(m)
      } catch (e) {
        this.fail(e.message)
      }
    }
  }
  validateData(m) {
    webUrl(m.url)
    if (m.type !== 'click' || !uuid(m.pageId) || !validClick(m.event)) throw new Error('Неизвестная команда')
  }
  broadcast(m, except) {
    const targets = [...this.peers].filter(([id]) => id !== except)
    if (targets.some(([, p]) => p.channel?.readyState !== 'open' || p.channel.bufferedAmount > 65536))
      throw new Error('Канал не готов или перегружен')
    const wire = JSON.stringify(m)
    for (const [to, peer] of targets) {
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
    if (this.phase !== 'stable') throw new Error('Сначала установите соединение')
    this.validateData(m)
    this.broadcast(m)
  }
  async sharePage(id, page) {
    const [target] = this.peers
    if (this.phase !== 'stable' || !target) throw new Error('Сначала подключите второго участника')
    if (this.sendingPage) throw new Error('Дождитесь отправки предыдущей копии')
    this.sendingPage = true
    try {
      const [to, peer] = target
      const session = this.session
      const bytes = await sendPage(peer.channel, id, page)
      if (this.session === session && this.phase === 'stable') this.isStreamingHost = true
      this.onSent({
        time: new Date().toISOString(),
        session,
        from: this.id,
        to,
        payload: { type: 'page', id, bytes, omitted: page.omitted },
      })
    } finally {
      this.sendingPage = false
    }
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
    if (this.phase === 'idle' || this.phase === 'error') return
    for (const m of readSignals(text, this.session)) {
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
        this.generation = generation
        this.transition('reconnecting', 'Восстанавливаем соединение через комнату Avito…')
        clearTimeout(this.timer)
        this.timer = setTimeout(() => this.fail('Истекло время восстановления соединения'), 180000)
        this.signal(m.from, 'hello')
        continue
      }
      // Candidates and descriptions belong to one ICE generation.
      if (generation !== this.generation) continue
      if (m.type === 'reconnect' && this.host === this.id && p?.opened) {
        this.recover(m.from, p, 'Участник запросил переподключение')
        continue
      }
      if (m.type === 'hello' && this.host === this.id) {
        if (p || this.peers.size) continue
        await this.offer(m.from)
      } else if (m.type === 'offer' && this.host !== this.id) {
        if (p?.pc.remoteDescription) continue
        if (m.description?.type !== 'offer') throw new Error('Ожидается offer')
        p ??= this.peer(m.from, false)
        await p.pc.setRemoteDescription(decodeSignal(JSON.stringify({ v: 1, ...m.description })))
        for (const c of p.candidates) await p.pc.addIceCandidate(c)
        p.candidates = []
        await p.pc.setLocalDescription(await p.pc.createAnswer())
        if (this.peers.get(m.from) !== p) return
        this.signal(m.from, 'answer', { description: p.pc.localDescription.toJSON() })
      } else if (
        m.type === 'answer' &&
        this.host === this.id &&
        p?.pc.signalingState === 'have-local-offer'
      ) {
        if (m.description?.type !== 'answer') throw new Error('Ожидается answer')
        await p.pc.setRemoteDescription(decodeSignal(JSON.stringify({ v: 1, ...m.description })))
        for (const c of p.candidates) await p.pc.addIceCandidate(c)
        p.candidates = []
      } else if (m.type === 'ice') {
        if (!p && this.host !== this.id) p = this.peer(m.from, false)
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
  close(reason = 'Соединение закрыто', phase = 'idle') {
    const previous = this.session
    clearTimeout(this.timer)
    const peers = [...this.peers.values()]
    this.peers.clear()
    for (const p of peers) {
      clearTimeout(p.timer)
      clearTimeout(p.lostTimer)
      p.pc.close()
    }
    this.isStreamingHost = false
    this.transition(phase, reason)
    this.outbox = []
    this.seen.clear()
    this.session = null
    this.host = null
    this.onClose(previous)
  }
}
