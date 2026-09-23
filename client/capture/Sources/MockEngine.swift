// MockEngine.swift — synthetic frame generator for CI / permission-less tests.
//
// Set INHAND_CAPTURE_MOCK=1 in the helper's env to run this instead of real
// capture. Paints an animated frame with CoreGraphics, encodes JPEG via
// ImageIO, and pushes it over the same path as real frames.

import Foundation
import CoreGraphics
import ImageIO
import CoreText
import AppKit
import UniformTypeIdentifiers

final class MockEngine {
	static let shared = MockEngine()

	private var timer: DispatchSourceTimer?
	private var broadcast: ((Data) -> Void)?

	func start(broadcast: @escaping (Data) -> Void) {
		self.broadcast = broadcast
		let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
		timer.schedule(deadline: .now(), repeating: 0.1)
		timer.setEventHandler { [weak self] in
			self?.renderAndPush()
		}
		self.timer = timer
		timer.resume()
		ErrorLog.shared.log("mock mode on")
	}

	private func renderAndPush() {
		let width = 640
		let height = 360
		guard let ctx = CGContext(
			data: nil,
			width: width,
			height: height,
			bitsPerComponent: 8,
			bytesPerRow: width * 4,
			space: CGColorSpaceCreateDeviceRGB(),
			bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
		) else { return }

		let t = Date().timeIntervalSinceReferenceDate
		ctx.setFillColor(CGColor(red: 0.06, green: 0.12, blue: 0.19, alpha: 1))
		ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))

		// Moving color block.
		let hue = (t * 60).truncatingRemainder(dividingBy: 360)
		let x = (t * 50).truncatingRemainder(dividingBy: Double(width - 80))
		ctx.setFillColor(NSColor(hue: hue / 360, saturation: 0.8, brightness: 0.6, alpha: 1).cgColor)
		ctx.fill(CGRect(x: x, y: 120, width: 80, height: 80))

		// White label with elapsed seconds.
		drawText("CAPTURE MOCK \(Int(t))", x: 20, y: 60, size: 24, ctx: ctx)

		guard let image = ctx.makeImage() else { return }
		guard let data = JPEG.encode(image) else { return }
		broadcast?(data)
	}

	private func drawText(_ text: String, x: CGFloat, y: CGFloat, size: CGFloat, ctx: CGContext) {
		let font = CTFontCreateWithName("Menlo" as CFString, size, nil)
		let attrs = [
			kCTFontAttributeName: font,
			kCTForegroundColorAttributeName: CGColor(red: 1, green: 1, blue: 1, alpha: 1),
		] as CFDictionary
		let attrStr = CFAttributedStringCreate(nil, text as CFString, attrs)!
		let line = CTLineCreateWithAttributedString(attrStr)
		ctx.textPosition = CGPoint(x: x, y: y)
		CTLineDraw(line, ctx)
	}

}
