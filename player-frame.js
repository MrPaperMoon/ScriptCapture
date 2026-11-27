import { captureDocumentClicks } from './content.js'
import { pointerConfig } from './protocol.js'

const frameSkip = pointerConfig.skip.replace('iframe,', '')
const worldName = 'ScriptCaptureClicks'
export const clickBinding = 'scriptCaptureClick'
const tabs = new Map()
const send = (target, method, params) => chrome.debugger.sendCommand(target, method, params)

async function configureCapture(tab, target) {
  const session = target.sessionId ?? ''
  if (!tab.scripts.has(session)) {
    const install = async () => {
      await send(target, 'Runtime.enable')
      await send(target, 'Runtime.addBinding', { name: clickBinding, executionContextName: worldName })
      const args = JSON.stringify([pointerConfig, clickBinding, tab.pageId])
      await send(target, 'Page.addScriptToEvaluateOnNewDocument', {
        worldName, runImmediately: true, source: '(' + captureDocumentClicks.toString() + ')(...' + args + ')',
      })
    }
    tab.scripts.set(session, install().catch(error => {
      tab.scripts.delete(session)
      throw error
    }))
  }
  await tab.scripts.get(session)
}

async function installInContext(tab, target, contextId) {
  await tab.scripts.get(target.sessionId ?? '')
  await send(target, 'Runtime.callFunctionOn', {
    executionContextId: contextId,
    functionDeclaration: captureDocumentClicks.toString(),
    arguments: [{ value: pointerConfig }, { value: clickBinding }, { value: tab.pageId }],
  })
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tab = tabs.get(source.tabId)
  if (!tab) return
  const session = source.sessionId ?? ''
  if (method === 'Target.attachedToTarget' && !source.sessionId && params.targetInfo.type === 'iframe') {
    const { sessionId, targetInfo } = params
    tab.children.set(targetInfo.targetId, sessionId)
    if (tab.pageId) {
      void configureCapture(tab, { tabId: source.tabId, sessionId }).catch(console.warn)
    }
  }
  if (method === 'Target.detachedFromTarget') {
    for (const [frameId, sessionId] of tab.children) {
      if (sessionId === params.sessionId) tab.children.delete(frameId)
    }
    tab.contexts.delete(params.sessionId)
    tab.scripts.delete(params.sessionId)
  }
  if (method === 'Runtime.executionContextCreated' && params.context.name === worldName) {
    if (!tab.contexts.has(session)) tab.contexts.set(session, new Map())
    tab.contexts.get(session).set(params.context.id, params.context.auxData?.frameId)
    // A cross-origin frame can acquire its isolated world while its renderer is changing.
    // Run the idempotent installer after the binding has arrived in that world.
    if (tab.pageId) void installInContext(tab, source, params.context.id).catch(() => {})
  }
  if (method === 'Runtime.executionContextDestroyed') {
    tab.contexts.get(session)?.delete(params.executionContextId)
  }
  if (method === 'Runtime.executionContextsCleared') tab.contexts.delete(session)
})

export function captureFrameId(source, contextId) {
  return tabs.get(source.tabId)?.contexts.get(source.sessionId ?? '')?.get(contextId)
}

export async function attachFrames(tabId, pageId) {
  const target = { tabId }
  await chrome.debugger.attach(target, '1.3')
  const tab = { pageId, children: new Map(), contexts: new Map(), scripts: new Map() }
  tabs.set(tabId, tab)
  try {
    if (pageId) await configureCapture(tab, target)
    // Only the root session auto-attaches. The listeners also guard against deeper documents.
    await send(target, 'Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe' }],
    })
    if (pageId) {
      await Promise.allSettled([...tab.children.values()].map(sessionId =>
        configureCapture(tab, { tabId, sessionId }),
      ))
    }
  } catch (error) {
    await detachFrames(tabId)
    throw error
  }
}

export async function detachFrames(tabId) {
  if (!tabs.delete(tabId)) return
  await chrome.debugger.detach({ tabId }).catch(() => {})
}
chrome.debugger.onDetach.addListener(({ tabId }) => tabs.delete(tabId))

export async function rootContext(tabId) {
  const target = { tabId }
  const { frameTree } = await send(target, 'Page.getFrameTree')
  const frameId = frameTree.frame.id
  const { executionContextId: contextId } = await send(target, 'Page.createIsolatedWorld', {
    frameId, worldName: 'ScriptCaptureFrames',
  })
  return { target, contextId, frameId }
}

function collectFrames(owner, skip, maxDepth) {
  const frames = []
  let selected = null
  for (const element of document.querySelectorAll('iframe')) {
    const path = []
    let node = element
    for (; node !== document.documentElement; node = node.parentElement) {
      if (!node.parentElement || node.matches(skip) || path.length === maxDepth) break
      const children = Array.from(node.parentElement.children).filter(child => !child.matches(skip))
      path.unshift([children.indexOf(node), node.localName, false])
    }
    if (node !== document.documentElement || !path.length) continue
    const raw = element.hasAttribute('srcdoc') ? 'about:srcdoc' : element.getAttribute('src') || 'about:blank'
    let url
    try {
      url = new URL(raw, document.baseURI)
    } catch {
      continue
    }
    if (url.username || url.password) continue
    const resource = url.protocol === 'about:' ? url.href : url.origin + url.pathname
    if (!['http:', 'https:'].includes(url.protocol) && !['about:blank', 'about:srcdoc'].includes(resource)) continue
    if (element === owner) selected = frames.length
    frames.push({ path, resource })
  }
  return { frames, selected }
}

export async function readStructure(root, frameId = root.frameId) {
  let owner
  if (frameId !== root.frameId) {
    const { backendNodeId } = await send(root.target, 'DOM.getFrameOwner', { frameId })
    const { object } = await send(root.target, 'DOM.resolveNode', {
      backendNodeId, executionContextId: root.contextId,
    })
    owner = object.objectId
  }
  try {
    const { result, exceptionDetails } = await send(root.target, 'Runtime.callFunctionOn', {
      executionContextId: root.contextId, functionDeclaration: collectFrames.toString(),
      arguments: [owner ? { objectId: owner } : { value: null }, { value: frameSkip }, { value: pointerConfig.maxDepth }],
      returnByValue: true,
    })
    if (exceptionDetails || !result?.value) throw new Error('Не удалось прочитать структуру iframe')
    return result.value
  } finally {
    if (owner) await send(root.target, 'Runtime.releaseObject', { objectId: owner }).catch(() => {})
  }
}

function findOwner(path, skip, resource) {
  let node = document.documentElement
  for (const [index, tag] of path) {
    node = Array.from(node.children).filter(child => !child.matches(skip))[index]
    if (node?.localName !== tag) return null
  }
  if (!(node instanceof HTMLIFrameElement)) return null
  const raw = node.hasAttribute('srcdoc') ? 'about:srcdoc' : node.getAttribute('src') ||
    (resource === 'about:blank' ? null : node.getAttribute('data-src')) || 'about:blank'
  const url = new URL(raw, document.baseURI)
  const current = url.protocol === 'about:' ? url.href : url.origin + url.pathname
  if (current !== resource) return null
  const rect = node.getBoundingClientRect()
  if (rect.height && (rect.bottom <= 0 || rect.top >= innerHeight)) {
    node.scrollIntoView({ block: 'center', behavior: 'instant' })
  }
  return node
}

export async function resolveFrame(root, frame) {
  const { target, contextId } = root
  const { result: owner } = await send(target, 'Runtime.callFunctionOn', {
    executionContextId: contextId, functionDeclaration: findOwner.toString(),
    arguments: [{ value: frame.path }, { value: frameSkip }, { value: frame.resource }],
  })
  if (!owner?.objectId) return null
  let frameId
  try {
    const { node } = await send(target, 'DOM.describeNode', { objectId: owner.objectId })
    frameId = node.frameId
  } finally {
    await send(target, 'Runtime.releaseObject', { objectId: owner.objectId }).catch(() => {})
  }
  if (!frameId) return null
  const sessionId = tabs.get(target.tabId)?.children.get(frameId)
  const child = sessionId ? { tabId: target.tabId, sessionId } : target
  try {
    const { executionContextId } = await send(child, 'Page.createIsolatedWorld', {
      frameId, worldName: 'ScriptCaptureFrames',
    })
    return { target: child, contextId: executionContextId }
  } catch {
    // The iframe may be moving to another renderer while its URL changes.
    return null
  }
}
