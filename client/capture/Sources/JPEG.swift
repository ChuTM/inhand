// JPEG.swift — shared JPEG encoding for both capture and mock engines.

import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

enum JPEG {
	/// Encode a CGImage to JPEG bytes.
	static func encode(_ image: CGImage, quality: CGFloat = 0.7) -> Data? {
		let data = NSMutableData()
		guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
			return nil
		}
		CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
		guard CGImageDestinationFinalize(dest) else { return nil }
		return data as Data
	}
}
