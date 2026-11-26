;(() => {
  if (globalThis.watchRoomTimer) return
  let pending = false
  async function tick() {
    if (pending) return
    pending = true
    try {
      await chrome.runtime.sendMessage({ target: 'background', type: 'roomTick' })
    } catch {
      /* Extension may have been reloaded. */
    } finally {
      pending = false
    }
  }

  void tick()
  globalThis.watchRoomTimer = setInterval(tick, 800)
})()
