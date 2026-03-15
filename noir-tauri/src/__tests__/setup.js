// setup.js — Global mocks for Jest (runs before each test file)
// Provides minimal window.__TAURI__ so state.js can import without error.

globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async () => {},
      convertFileSrc: (path) => path,
    },
    event: {
      listen: async () => () => {},
    },
  },
};

// Minimal document stub for modules that reference DOM at import time
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    addEventListener() {},
    setAttribute() {},
    appendChild() {},
    style: {},
  }),
  addEventListener() {},
};

// Minimal navigator stub
globalThis.navigator = { platform: 'MacIntel' };
