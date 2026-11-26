// Runs in the page's MAIN world. Uses the Monaco/ShareDB component from the supplied HAR.
export async function avitoEditor(operation, text = '') {
  if (location.origin !== 'https://code.avito.ru') throw new Error('Не страница Avito')
  const roomId = location.pathname.split('/')[2]
  const root = document.querySelector('#app')?.__vue__
  const queue = root ? [root] : []
  if (!root) {
    for (const element of document.querySelectorAll(
      '.monaco-editor, .editors__code, .room-container, .layout',
    )) {
      for (let node = element; node; node = node.parentElement) {
        if (node.__vue__) queue.push(node.__vue__)
      }
    }
  }
  const visited = new Set()
  let component
  while (queue.length && visited.size < 1000) {
    const current = queue.shift()
    if (!current || visited.has(current)) continue
    visited.add(current)
    if (current.editor?.getModel && current.doc?.collection === 'docs' && current.doc.id === roomId) {
      component = current
      break
    }
    queue.push(current.$parent, ...(current.$children || []))
  }
  if (
    !component ||
    component.shareConn?.state !== 'connected' ||
    !component.doc.subscribed ||
    component.isClosed ||
    component.editingLimited
  ) {
    return {
      waiting: true,
      url: location.href,
      message: !component ? 'Открываем редактор комнаты Avito' : 'Редактор пока недоступен для записи',
    }
  }
  const model = component.editor.getModel()
  if (!model || typeof component.doc.data !== 'string') throw new Error('Редактор Avito изменился')
  if (component.doc.data.length > 1000000) throw new Error('Комната слишком большая. Создайте новую')
  if (operation === 'append' || operation === 'replace') {
    const length = model.getValueLength()
    const start = operation === 'replace' ? 0 : length
    if (typeof text !== 'string' || text.length > 120000 || start + text.length > 1000000)
      throw new Error('Слишком большое сообщение')
    // Monaco's edit handler submits the edit to ShareDB.
    const begin = model.getPositionAt(start)
    const end = model.getPositionAt(length)
    model.applyEdits([
      {
        range: {
          startLineNumber: begin.lineNumber,
          startColumn: begin.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        },
        text,
      },
    ])
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Avito не подтвердил запись за 10 секунд')), 10000)
      component.doc.whenNothingPending(() => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }
  const result = { text: component.doc.data, url: location.href }
  if (operation === 'readForJoin') {
    // On join the displayed Host can be available before it appears in the room snapshot.
    result.visibleHost = model.getValue().split(/\r?\n/)
      .findLast(line => line.length <= 1024 && /^\s*\[[^\]]+\]\s+Host\s*:/.test(line))
  }
  return result
}
