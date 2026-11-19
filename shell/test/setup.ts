// Test preload: registers happy-dom (preserving Bun's native fetch/WebSocket) and SolidJS transform.

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import "./transform"

const nativeFetch = globalThis.fetch
const nativeRequest = globalThis.Request
const nativeResponse = globalThis.Response
const nativeHeaders = globalThis.Headers
const nativeWebSocket = globalThis.WebSocket

GlobalRegistrator.register({ url: "http://localhost:4791/", width: 1280, height: 800 })

globalThis.fetch = nativeFetch
globalThis.Request = nativeRequest
globalThis.Response = nativeResponse
globalThis.Headers = nativeHeaders
globalThis.WebSocket = nativeWebSocket
