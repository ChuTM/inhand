// WebSocketServer.swift — minimal loopback WebSocket server for frame push.
//
// The main InHand Student app's share windows connect to
// ws://127.0.0.1:7931/frames and receive binary JPEG frames. Only loopback
// peers are accepted. Server-side frames are never masked (RFC 6455 §5.1).

import Foundation
import Network
import CryptoKit

// Buffers the partial HTTP upgrade request while more bytes arrive.
private final class ConnState {
	var buffer = Data()
}

final class WebSocketServer {
	private var listener: NWListener?
	private let clientsLock = NSLock()
	private var clients: [NWConnection] = []
	private let queue = DispatchQueue(label: "inhand.capture.ws")

	private static let wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

	func start(port: UInt16 = 7931, path: String = "/frames") {
		do {
			let parameters = NWParameters.tcp
			parameters.requiredInterfaceType = .loopback
			let listener = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: port)!)
			self.listener = listener
			listener.newConnectionHandler = { [weak self] conn in
				self?.handleNewConnection(conn, expectedPath: path)
			}
			listener.stateUpdateHandler = { state in
				switch state {
				case .ready:
					ErrorLog.shared.log("ws listening on 127.0.0.1:\(port)\(path)")
				case .failed(let err):
					ErrorLog.shared.log("ws listener failed: \(err)")
				default:
					break
				}
			}
			listener.start(queue: queue)
		} catch {
			ErrorLog.shared.log("ws listener start error: \(error)")
		}
	}

	// --- Connection lifecycle -----------------------------------------------
	private func handleNewConnection(_ conn: NWConnection, expectedPath: String) {
		conn.start(queue: queue)
		readUpgrade(conn, expectedPath: expectedPath, state: ConnState())
	}

	private func readUpgrade(_ conn: NWConnection, expectedPath: String, state: ConnState) {
		conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
			guard let self = self else { return }
			if let data = data, !data.isEmpty {
				state.buffer.append(data)
			}
			if error != nil {
				conn.cancel()
				return
			}
			if let headerEnd = state.buffer.range(of: Data("\r\n\r\n".utf8)) {
				let header = String(decoding: state.buffer[..<headerEnd.lowerBound], as: UTF8.self)
				if let key = Self.secWebSocketKey(from: header),
				   Self.requestPath(from: header) == expectedPath {
					self.completeHandshake(conn, key: key)
					self.register(conn)
				} else {
					conn.cancel()
				}
				return
			}
			if isComplete {
				conn.cancel()
				return
			}
			// More header bytes may still arrive; keep reading.
			self.readUpgrade(conn, expectedPath: expectedPath, state: state)
		}
	}

	private func completeHandshake(_ conn: NWConnection, key: String) {
		let accept = Self.secWebSocketAccept(key: key)
		let response =
			"HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			"Sec-WebSocket-Accept: \(accept)\r\n" +
			"\r\n"
		conn.send(content: response.data(using: .utf8)!, completion: .contentProcessed { _ in })
	}

	private func register(_ conn: NWConnection) {
		clientsLock.lock()
		clients.append(conn)
		clientsLock.unlock()
		ErrorLog.shared.log("ws frame client connected, total \(clientsCount())")
		receiveControlFrames(conn)
	}

	// --- Inbound frames: only ping/pong/close matter -------------------------
	private func receiveControlFrames(_ conn: NWConnection) {
		conn.receive(minimumIncompleteLength: 2, maximumLength: 65536) { [weak self] data, _, isComplete, error in
			guard let self = self else { return }
			if error != nil || isComplete {
				self.drop(conn)
				return
			}
			guard let data = data, data.count >= 2 else {
				self.receiveControlFrames(conn)
				return
			}
			let opcode = data[0] & 0x0F
			var payload = Data()
			if data.count > 2 {
				payload = data.subdata(in: 2..<data.count)
			}
			switch opcode {
			case 0x8: // close
				self.drop(conn)
				return
			case 0x9: // ping -> pong
				self.sendPong(conn, payload: payload)
			default:
				break
			}
			self.receiveControlFrames(conn)
		}
	}

	private func sendPong(_ conn: NWConnection, payload: Data) {
		var frame = Data([0x8A])
		appendLength(&frame, payload.count)
		frame.append(payload)
		conn.send(content: frame, completion: .contentProcessed { _ in })
	}

	private func drop(_ conn: NWConnection) {
		clientsLock.lock()
		clients.removeAll { $0 === conn }
		clientsLock.unlock()
		conn.cancel()
	}

	// --- Broadcast ----------------------------------------------------------
	func broadcast(_ payload: Data) {
		var frame = Data([0x82]) // FIN + binary opcode
		appendLength(&frame, payload.count)
		frame.append(payload)

		clientsLock.lock()
		let snapshot = clients
		clientsLock.unlock()

		for conn in snapshot {
			conn.send(content: frame, completion: .contentProcessed { _ in })
		}
	}

	private func clientsCount() -> Int {
		clientsLock.lock()
		defer { clientsLock.unlock() }
		return clients.count
	}

	// --- RFC 6455 helpers ---------------------------------------------------
	private func appendLength(_ frame: inout Data, _ len: Int) {
		if len < 126 {
			frame.append(UInt8(len))
		} else if len <= 0xFFFF {
			frame.append(126)
			var v = UInt16(len).bigEndian
			withUnsafeBytes(of: &v) { frame.append(contentsOf: $0) }
		} else {
			frame.append(127)
			var v = UInt64(len).bigEndian
			withUnsafeBytes(of: &v) { frame.append(contentsOf: $0) }
		}
	}

	private static func secWebSocketKey(from header: String) -> String? {
		for line in header.split(separator: "\r\n") {
			let parts = line.split(separator: ":", maxSplits: 1)
			if parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "sec-websocket-key" {
				return parts[1].trimmingCharacters(in: .whitespaces)
			}
		}
		return nil
	}

	private static func requestPath(from header: String) -> String {
		let firstLine = header.split(separator: "\r\n").first ?? ""
		let parts = firstLine.split(separator: " ")
		if parts.count >= 2 {
			return String(parts[1])
		}
		return ""
	}

	private static func secWebSocketAccept(key: String) -> String {
		let input = key + wsGUID
		// RFC 6455 §4.2.2: SHA-1 of (key + GUID), base64-encoded.
		let digest = Data(Insecure.SHA1.hash(data: Data(input.utf8)))
		return digest.base64EncodedString()
	}
}
