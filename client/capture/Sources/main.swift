// main.swift — InHand Capture helper entry point.
//
// A tiny loopback frame server (no UI, no dock icon). The main InHand Student
// app probes 127.0.0.1:7931 to decide whether the helper is up, then share
// windows connect to ws://127.0.0.1:7931/frames to receive JPEG frames.
//
//   INHAND_CAPTURE_MOCK=1  -> synthetic frames (permission-less testing)

import Foundation

let env = ProcessInfo.processInfo.environment
let mock = env["INHAND_CAPTURE_MOCK"] == "1"

ErrorLog.shared.log("swift helper started mock=\(mock) pid=\(ProcessInfo.processInfo.processIdentifier)")

let server = WebSocketServer()
server.start(port: 7931, path: "/frames")

if mock {
	MockEngine.shared.start(broadcast: server.broadcast)
} else {
	CaptureEngine.shared.start(broadcast: server.broadcast)
}

// Keep the process alive forever; the listener keeps its own queues running.
dispatchMain()
