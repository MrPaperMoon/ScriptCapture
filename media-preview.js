export const previewPort = 'watch-together-video-preview'

// The popup needs a separate receiver because runtime messages cannot carry MediaStreamTracks.
// Gather host candidates before sending SDP so there is no separate ICE message queue.
export async function previewDescription(pc) {
  await pc.setLocalDescription()
  if (pc.iceGatheringState !== 'complete') {
    await new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer)
        pc.removeEventListener('icegatheringstatechange', change)
        resolve()
      }
      const change = () => {
        if (pc.iceGatheringState === 'complete') finish()
      }
      const timer = setTimeout(finish, 1500)
      pc.addEventListener('icegatheringstatechange', change)
    })
  }
  return pc.localDescription?.toJSON()
}

export function servePreview(port, remoteTrack, onClose) {
  const pc = new RTCPeerConnection()
  let transceiver
  const refresh = async () => {
    if (!transceiver || pc.signalingState === 'closed') return
    const track = remoteTrack()
    if (transceiver.sender.track !== track) await transceiver.sender.replaceTrack(track)
  }
  port.onDisconnect.addListener(() => {
    pc.close()
    onClose()
  })
  port.onMessage.addListener(async (offer) => {
    try {
      if (offer?.type !== 'offer' || pc.remoteDescription) return
      await pc.setRemoteDescription(offer)
      const transceivers = pc.getTransceivers()
      if (transceivers.length !== 1 || transceivers[0].receiver.track.kind !== 'video') {
        throw new Error('Некорректное подключение предпросмотра')
      }
      transceiver = transceivers[0]
      transceiver.direction = 'sendonly'
      await refresh()
      const answer = await previewDescription(pc)
      if (pc.signalingState !== 'closed') port.postMessage(answer)
    } catch (error) {
      if (pc.signalingState === 'closed') return
      console.warn(error)
      pc.close()
      onClose()
      port.disconnect()
    }
  })
  return refresh
}
