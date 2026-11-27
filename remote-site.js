import { pointerConfig } from './protocol.js'
import { attachFrames, detachFrames, resolveFrame, rootContext } from './player-frame.js'

export const getStreamingTab = async () => (await chrome.storage.session.get('streamingTab')).streamingTab

export async function clearStreamingTab(pageId) {
  const site = await getStreamingTab()
  if (!site || (pageId && site.pageId !== pageId)) return
  await chrome.storage.session.remove('streamingTab')
  await detachFrames(site.tabId)
}

export async function bindStreamingTab({ pageId, url, session }, tabId) {
  await clearStreamingTab()
  if (tabId === undefined) {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    tabId = active?.url === url ? active.id : (await chrome.tabs.create({ url })).id
  }
  const site = { tabId, pageId, url, session }
  await chrome.storage.session.set({ streamingTab: site })
  return site
}

export async function attachStreamingTab(site) {
  await attachFrames(site.tabId, site.pageId)
  await chrome.storage.session.set({ streamingTab: { ...site, attached: true } })
}

// Executed in the receiving document's isolated world.
function dispatchPointer(url, main, config, pointer) {
  if (document.readyState === 'loading') return false
  const resource = location.protocol === 'about:' ? location.href : location.origin + location.pathname
  if ((main ? location.href : resource) !== url) return false

  function resolvePath(path) {
    let node = document.documentElement
    for (const [index, tag, inShadow] of path) {
      const parent = inShadow ? node.shadowRoot : node
      if (!parent) return null
      const children = Array.from(parent.children).filter(child => !child.matches(config.skip))
      node = children[index]
      if (node?.localName !== tag) return null
    }
    return node
  }

  const node = resolvePath(pointer.path)
  if (!node) return false
  for (let ancestor = node; ancestor; ancestor = ancestor.getRootNode().host) {
    if (ancestor.closest(config.excluded)) return false
  }

  const beforeScroll = node.getBoundingClientRect()
  if (main && (beforeScroll.bottom <= 0 || beforeScroll.top >= innerHeight ||
      beforeScroll.right <= 0 || beforeScroll.left >= innerWidth)) {
    node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
  }
  const rect = node.getBoundingClientRect()
  const args = {
    pointerType: pointer.args.pointerType,
    view: pointer.args.hasView ? window : null,
    relatedTarget: pointer.relatedPath && resolvePath(pointer.relatedPath),
    clientX: rect.left + (rect.width || 1) * pointer.x,
    clientY: rect.top + (rect.height || 1) * pointer.y,
  }
  for (const key of config.numberArgs) args[key] = pointer.args[key]
  for (const key of config.optionalNumberArgs) args[key] = pointer.args[key]
  for (const key of config.flagArgs) args[key] = pointer.args[key]
  node.dispatchEvent(new PointerEvent(pointer.type, args))
  return true
}

export async function replayRemotePointer(site, { event, frame, document }) {
  if ((await chrome.tabs.get(site.tabId)).url !== site.url) return false
  try {
    const root = await rootContext(site.tabId)
    const context = frame ? await resolveFrame(root, frame) : root
    if (!context) return false
    const { result } = await chrome.debugger.sendCommand(context.target, 'Runtime.callFunctionOn', {
      functionDeclaration: dispatchPointer.toString(),
      executionContextId: context.contextId,
      arguments: [
        { value: frame ? document : site.url }, { value: !frame }, { value: pointerConfig }, { value: event },
      ],
      returnByValue: true,
      // A user clicked on the sender. The player may need activation to start audio.
      userGesture: true,
    })
    return result?.value === true
  } catch (error) {
    if (/context|session.*not found|frame.*not found|inspected target navigated/i.test(error.message)) return false
    throw error
  }
}
