// Global DOM & Browser Mocks for node vitest environment
if (typeof window === 'undefined') {
  const globalAny: any = globalThis

  // localStorage mock
  const localStorageMock = (() => {
    let store: Record<string, string> = {}
    return {
      getItem: (key: string) => store[key] || null,
      setItem: (key: string, value: string) => { store[key] = value.toString() },
      removeItem: (key: string) => { delete store[key] },
      clear: () => { store = {} }
    }
  })()

  globalAny.localStorage = localStorageMock
  globalAny.window = globalThis

  // matchMedia mock
  globalAny.window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })

  // document mock
  globalAny.document = {
    createElement: (tag: string) => {
      if (tag === 'canvas') {
        return {
          getContext: () => ({
            fillRect: () => {},
            clearRect: () => {},
            getImageData: () => ({ data: new Uint8Array(4) }),
            putImageData: () => {},
            createImageData: () => [],
            setTransform: () => {},
            drawImage: () => {},
            save: () => {},
            restore: () => {},
            beginPath: () => {},
            moveTo: () => {},
            lineTo: () => {},
            closePath: () => {},
            stroke: () => {},
            translate: () => {},
            scale: () => {},
            rotate: () => {},
            arc: () => {},
            fill: () => {},
          }),
          width: 800,
          height: 600,
          style: {},
          addEventListener: () => {},
          removeEventListener: () => {},
        }
      }
      return {
        style: {},
        appendChild: () => {},
        removeChild: () => {},
        setAttribute: () => {},
        getAttribute: () => null,
        addEventListener: () => {},
        removeEventListener: () => {},
      }
    },
    body: {
      appendChild: () => {},
      removeChild: () => {},
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
}
