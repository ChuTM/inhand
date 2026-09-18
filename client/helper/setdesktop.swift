// InHand wallpaper setter.
//
// Sets the desktop picture for every screen using the public NSWorkspace
// API. Unlike AppleScript automation ("System Events"), this does NOT require
// a macOS Automation/Accessibility permission grant, so it works reliably on
// managed student machines where the app runs invisible from launchd.
//
// Usage: setdesktop /absolute/path/to/image.heic
// Exit:   0 success, 1 NSWorkspace error, 2 bad arguments.

import AppKit
import Foundation

guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write(Data("usage: setdesktop <absolute-image-path>\n".utf8))
    exit(2)
}

let path = CommandLine.arguments[1]
guard path.hasPrefix("/") else {
    FileHandle.standardError.write(Data("error: path must be absolute\n".utf8))
    exit(2)
}

let url = URL(fileURLWithPath: path)
guard FileManager.default.fileExists(atPath: path) else {
    FileHandle.standardError.write(Data("error: file not found: \(path)\n".utf8))
    exit(1)
}

var lastError: Error?
for screen in NSScreen.screens {
    do {
        try NSWorkspace.shared.setDesktopImageURL(url, for: screen, options: [:])
    } catch {
        lastError = error
    }
}

if let err = lastError {
    FileHandle.standardError.write(Data("error: \(err.localizedDescription)\n".utf8))
    exit(1)
}
exit(0)
