#!/usr/bin/env swift
// Deterministically export the existing body for native status/tray surfaces.
// Runtime builds consume committed assets and do not require Swift or Xcode.
import Foundation
import CoreGraphics
import ImageIO
import CryptoKit

func require(_ value: @autoclosure () -> Bool, _ message: String) throws {
    if !value() { throw NSError(domain: "MioonTrayIcon", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}
let desktop = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let resources = desktop.appendingPathComponent("resources/tray")
let sourcePath = "apps/web/src/assets/mioon-mark.png"
let masterData = try Data(contentsOf: desktop.deletingLastPathComponent().appendingPathComponent("web/src/assets/mioon-mark.png"))
guard let source = CGImageSourceCreateWithData(masterData as CFData, nil),
      let master = CGImageSourceCreateImageAtIndex(source, 0, nil),
      let space = CGColorSpace(name: CGColorSpace.sRGB) else { fatalError("Cannot read existing brand body") }

func context(_ width: Int, _ height: Int) -> CGContext {
    guard let value = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                              space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fatalError("Cannot create RGBA bitmap") }
    return value
}
func pixels(_ value: CGContext) -> [UInt8] {
    guard let bytes = value.data else { fatalError("Cannot read RGBA bitmap") }
    return Array(UnsafeBufferPointer(start: bytes.assumingMemoryBound(to: UInt8.self), count: value.width * value.height * 4))
}
func image(_ bytes: [UInt8], _ width: Int, _ height: Int) -> CGImage {
    guard let provider = CGDataProvider(data: Data(bytes) as CFData),
          let result = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
                              space: space, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                              provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) else { fatalError("Cannot create image") }
    return result
}

let original = context(master.width, master.height)
original.draw(master, in: CGRect(x: 0, y: 0, width: master.width, height: master.height))
var cleaned = pixels(original)
// Use the largest 8-connected alpha>4 component as the existing ribbon's core.
// Keep its original pixels plus their one-pixel antialias fringe. This drops
// detached dots; it neither traces, fills nor erodes the stronger body edge.
let pixelCount = master.width * master.height
var visited = [Bool](repeating: false, count: pixelCount), largest = [Int]()
for seed in 0..<pixelCount {
    if visited[seed] || cleaned[seed * 4 + 3] <= 4 { continue }
    var component = [seed], cursor = 0
    visited[seed] = true
    while cursor < component.count {
        let current = component[cursor], x = current % master.width, y = current / master.width
        cursor += 1
        for dy in -1...1 {
            for dx in -1...1 {
                let nextX = x + dx, nextY = y + dy
                if nextX < 0 || nextX >= master.width || nextY < 0 || nextY >= master.height { continue }
                let next = nextY * master.width + nextX
                if !visited[next] && cleaned[next * 4 + 3] > 4 {
                    visited[next] = true; component.append(next)
                }
            }
        }
    }
    if component.count > largest.count { largest = component }
}
try require(!largest.isEmpty, "Existing brand body is empty")
var retained = [Bool](repeating: false, count: pixelCount)
for pixel in largest {
    let x = pixel % master.width, y = pixel / master.width
    for dy in -1...1 {
        for dx in -1...1 {
            let nextX = x + dx, nextY = y + dy
            if nextX >= 0 && nextX < master.width && nextY >= 0 && nextY < master.height {
                retained[nextY * master.width + nextX] = true
            }
        }
    }
}
var minX = master.width, minY = master.height, maxX = -1, maxY = -1, removed = 0
for y in 0..<master.height {
    for x in 0..<master.width {
        let offset = (y * master.width + x) * 4
        if !retained[y * master.width + x] {
            if cleaned[offset + 3] > 0 { removed += 1 }
            for channel in 0..<4 { cleaned[offset + channel] = 0 }
        } else if cleaned[offset + 3] > 0 {
            minX = min(minX, x); maxX = max(maxX, x)
            minY = min(minY, y); maxY = max(maxY, y)
        }
    }
}
try require(maxX > minX && maxY > minY, "Tray body is empty")
let bounds = CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
guard let body = image(cleaned, master.width, master.height).cropping(to: bounds) else { fatalError("Cannot crop tray body") }

func raster(_ size: Int) -> [UInt8] {
    let output = context(size, size)
    let padding = Double(size) / 18 // One logical point on the 18pt menu icon.
    let scale = min((Double(size) - padding * 2) / Double(body.width), (Double(size) - padding * 2) / Double(body.height))
    let width = Double(body.width) * scale, height = Double(body.height) * scale
    output.interpolationQuality = .high
    output.draw(body, in: CGRect(x: (Double(size) - width) / 2, y: (Double(size) - height) / 2, width: width, height: height))
    return pixels(output)
}
func png(_ bytes: [UInt8], _ size: Int, _ dpi: Int) -> Data {
    let output = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(output, "public.png" as CFString, 1, nil) else { fatalError("Cannot encode PNG") }
    CGImageDestinationAddImage(destination, image(bytes, size, size), [kCGImagePropertyDPIWidth: dpi, kCGImagePropertyDPIHeight: dpi] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { fatalError("PNG encoding failed") }
    return output as Data
}
for (size, dpi, suffix) in [(18, 72, ""), (36, 144, "@2x")] {
    let color = raster(size)
    var template = color
    for offset in stride(from: 0, to: template.count, by: 4) {
        template[offset] = 0; template[offset + 1] = 0; template[offset + 2] = 0
    }
    // Both variants use the exact same raster's alpha. macOS tints this mask;
    // an independently prepared silhouette could drift from the color body.
    try png(color, size, dpi).write(to: resources.appendingPathComponent("tray-color\(suffix).png"), options: .atomic)
    try png(template, size, dpi).write(to: resources.appendingPathComponent("trayTemplate\(suffix).png"), options: .atomic)
}

func little16(_ value: Int) -> Data { Data([UInt8(value & 255), UInt8((value >> 8) & 255)]) }
func little32(_ value: Int) -> Data { Data([UInt8(value & 255), UInt8((value >> 8) & 255), UInt8((value >> 16) & 255), UInt8((value >> 24) & 255)]) }
let sizes = [16, 20, 24, 32, 48, 64]
let frames = sizes.map { png(raster($0), $0, 72) }
var ico = little16(0) + little16(1) + little16(sizes.count)
var offset = 6 + sizes.count * 16
for (index, size) in sizes.enumerated() {
    ico.append(contentsOf: [UInt8(size), UInt8(size), 0, 0])
    ico.append(little16(1)); ico.append(little16(32))
    ico.append(little32(frames[index].count)); ico.append(little32(offset))
    offset += frames[index].count
}
for frame in frames { ico.append(frame) }
try ico.write(to: resources.appendingPathComponent("tray.ico"), options: .atomic)
let digest = SHA256.hash(data: masterData).map { String(format: "%02x", $0) }.joined()
let manifest: [String: Any] = ["version": 1, "sourcePath": sourcePath, "sourceSHA256": digest, "sourceWidth": master.width, "sourceHeight": master.height,
                            "componentAlphaGreaterThan": 4, "connectivity": 8, "antialiasFringePixels": 1,
                            "corePixels": largest.count, "removedDetachedPixels": removed, "bodyBounds": [minX, minY, maxX - minX + 1, maxY - minY + 1],
                            "logicalSize": 18, "macPixels": [18, 36], "macDpi": [72, 144], "icoSizes": sizes]
try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]).write(to: resources.appendingPathComponent("manifest.json"), options: .atomic)
print("Exported 18pt/36px template and color PNGs with identical alpha, plus six-frame color ICO")
