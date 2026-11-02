// Executes the SSR-bundled scene-ids.cjs under a happy-dom window.
//
// The scene modules import the playground mock, which reads window.electronAPI
// at module load (same contract as playground.tsx). Only module SCOPE is
// evaluated here — no component renders — so a plain happy-dom window is a
// faithful stand-in. Output: one JSON array on stdout, parsed by build.py.
const { Window } = require('happy-dom')

const dom = new Window({ url: 'http://localhost/scene-ids' })
globalThis.window = dom
globalThis.document = dom.document
globalThis.navigator = dom.navigator
globalThis.localStorage = dom.localStorage
globalThis.sessionStorage = dom.sessionStorage
globalThis.customElements = dom.customElements
globalThis.HTMLElement = dom.HTMLElement
globalThis.HTMLIFrameElement = dom.HTMLIFrameElement
globalThis.getComputedStyle = dom.getComputedStyle.bind(dom)
globalThis.requestAnimationFrame = cb => setTimeout(cb, 0)
globalThis.cancelAnimationFrame = id => clearTimeout(id)
globalThis.matchMedia = dom.window.matchMedia
  ? dom.window.matchMedia.bind(dom.window)
  : () => ({ matches: false, addEventListener() {}, removeEventListener() {} })

// Some bundled animation libraries construct matrix objects at module scope;
// happy-dom does not ship these. The runner only evaluates module scope, so a
// minimal identity-matrix surface is enough (no rendering happens here).
if (typeof globalThis.DOMMatrix === 'undefined') {
  class StubDOMMatrix {
    constructor() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0 }
    translate() { return this }
    scale() { return this }
    rotate() { return this }
    multiply() { return this }
  }
  globalThis.DOMMatrix = StubDOMMatrix
  globalThis.DOMMatrixReadOnly = StubDOMMatrix
}
if (typeof globalThis.Path2D === 'undefined') {
  globalThis.Path2D = class { moveTo() {} lineTo() {} closePath() {} }
}

require(process.env.POLO_BASELINE_SCENE_DIST
  ? require('node:path').resolve(__dirname, process.env.POLO_BASELINE_SCENE_DIST, 'scene-ids.cjs')
  : './dist-scene-ids/scene-ids.cjs')
