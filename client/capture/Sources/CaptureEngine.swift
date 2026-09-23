// CaptureEngine.swift — real screen capture via ScreenCaptureKit.
//
// Owns the macOS Screen Recording grant. Requests BGRA pixel buffers
// (compatible across SDKs) and JPEG-encodes each frame with ImageIO.

import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreVideo

final class CaptureEngine: NSObject, SCStreamOutput {
	static let shared = CaptureEngine()

	private var stream: SCStream?
	private var broadcast: ((Data) -> Void)?
	private var started = false

	func start(broadcast: @escaping (Data) -> Void) {
		self.broadcast = broadcast
		guard !started else { return }
		started = true
		Task {
			do {
				let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
				guard let display = content.displays.first else {
					ErrorLog.shared.log("no display available")
					return
				}
				let config = SCStreamConfiguration()
				config.width = Int(CGDisplayPixelsWide(display.displayID))
				config.height = Int(CGDisplayPixelsHigh(display.displayID))
				config.minimumFrameInterval = CMTime(value: 1, timescale: 15)
				config.capturesAudio = false
				config.showsCursor = true
				config.queueDepth = 5
				config.pixelFormat = kCVPixelFormatType_32BGRA

				let filter = SCContentFilter(display: display, excludingWindows: [])
				let stream = SCStream(filter: filter, configuration: config, delegate: nil)
				self.stream = stream
				try await stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: .global(qos: .userInitiated))
				try await stream.startCapture()
				ErrorLog.shared.log("capture started \(config.width)x\(config.height) fps=15 type=screen")
			} catch {
				ErrorLog.shared.log("capture start failed: \(error)")
				started = false
			}
		}
	}

	func stop() {
		Task {
			try? await stream?.stopCapture()
			stream = nil
			started = false
		}
	}

	// MARK: SCStreamOutput

	func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
		guard type == .screen else { return }
		guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
		guard let image = pixelBufferToCGImage(pixelBuffer) else { return }
		guard let jpeg = JPEG.encode(image) else { return }
		broadcast?(jpeg)
	}

	private func pixelBufferToCGImage(_ pixelBuffer: CVPixelBuffer) -> CGImage? {
		CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
		defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
		guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return nil }
		let width = CVPixelBufferGetWidth(pixelBuffer)
		let height = CVPixelBufferGetHeight(pixelBuffer)
		let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
		let colorSpace = CGColorSpaceCreateDeviceRGB()
		let bitmapInfo = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.noneSkipFirst.rawValue
		guard let ctx = CGContext(
			data: base,
			width: width,
			height: height,
			bitsPerComponent: 8,
			bytesPerRow: bytesPerRow,
			space: colorSpace,
			bitmapInfo: bitmapInfo
		) else { return nil }
		return ctx.makeImage()
	}
}
