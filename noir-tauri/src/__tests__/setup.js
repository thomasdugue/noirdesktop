// setup.js — Global mocks for Jest (runs before each test file)
// Provides minimal window.__TAURI__ so state.js can import without error.

// === Configurable invoke mock ===
const invokeResponses = new Map()
globalThis.__setInvokeResponse = (cmd, response) => invokeResponses.set(cmd, response)
globalThis.__clearInvokeResponses = () => invokeResponses.clear()

globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (cmd, args) => {
        if (invokeResponses.has(cmd)) {
          const resp = invokeResponses.get(cmd)
          return typeof resp === 'function' ? resp(args) : resp
        }
        return undefined
      },
      convertFileSrc: (path) => path,
    },
    event: {
      listen: async () => () => {},
    },
  },
  innerWidth: 1280,
  innerHeight: 800,
  devicePixelRatio: 1,
};

// === localStorage stub ===
const storage = new Map()
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
}

// === Animation frame stubs ===
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0)
globalThis.cancelAnimationFrame = clearTimeout
globalThis.requestIdleCallback = (cb) => setTimeout(() => cb({ timeRemaining: () => 50 }), 0)

// === Minimal document stub ===
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => {
    let _text = ''
    return {
      get textContent() { return _text },
      set textContent(v) { _text = String(v ?? '') },
      get innerHTML() {
        return _text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
      },
      set innerHTML(v) { _text = v },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
      addEventListener() {},
      setAttribute() {},
      getAttribute() { return null },
      appendChild(child) { return child },
      insertBefore(child) { return child },
      remove() {},
      style: {},
      dataset: {},
      children: [],
      childNodes: [],
      firstChild: null,
      parentNode: null,
      isConnected: false,
      offsetWidth: 0,
      offsetHeight: 0,
      getContext: () => ({
        clearRect() {},
        beginPath() {},
        arc() {},
        fill() {},
        fillStyle: '',
        setTransform() {},
      }),
    }
  },
  createDocumentFragment: () => ({
    appendChild(child) { return child },
    children: [],
    childNodes: [],
  }),
  addEventListener() {},
  body: {
    appendChild(child) { return child },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    style: {},
  },
};

// === Minimal navigator stub ===
globalThis.navigator = { platform: 'MacIntel' };

// === Silence console noise in tests ===
const _origLog = console.log
const _origWarn = console.warn
globalThis.console.log = () => {}
globalThis.console.time = () => {}
globalThis.console.timeEnd = () => {}
// Keep console.error and console.warn for debugging test failures
