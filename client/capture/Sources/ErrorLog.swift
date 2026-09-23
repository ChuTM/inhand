// ErrorLog.swift — persist capture helper diagnostics to disk.
//
// The helper is spawned with stdio ignored, so console output is lost. Errors
// are appended to ~/Library/Application Support/InHand Capture/capture-error.log
// so the teacher can diagnose a silent no-frames helper.

import Foundation

final class ErrorLog {
	static let shared = ErrorLog()

	private let dirPath: String
	private let filePath: String
	private let lock = NSLock()
	private let iso = ISO8601DateFormatter()

	init() {
		dirPath = NSHomeDirectory() + "/Library/Application Support/InHand Capture"
		filePath = dirPath + "/capture-error.log"
		iso.formatOptions = [.withInternetDateTime]
	}

	func log(_ message: String) {
		lock.lock()
		defer { lock.unlock() }
		do {
			try FileManager.default.createDirectory(atPath: dirPath, withIntermediateDirectories: true)
		} catch {
			return
		}
		let line = iso.string(from: Date()) + " " + message + "\n"
		if let data = line.data(using: .utf8) {
			if let handle = FileHandle(forWritingAtPath: filePath) {
				defer { try? handle.close() }
				handle.seekToEndOfFile()
				handle.write(data)
			} else {
				try? data.write(to: URL(fileURLWithPath: filePath))
			}
		}
	}
}
