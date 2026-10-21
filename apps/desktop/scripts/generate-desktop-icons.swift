#!/usr/bin/env swift
// Derive shared desktop framing from the existing brand image without redrawing it.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw NSError(domain: "MioonIcon", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}
let resources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("resources")
let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("mioon-icon-\(UUID().uuidString)")
try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: temporary) }
let sourceURL = resources.appendingPathComponent("icon-source.png")
guard let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
      let original = CGImageSourceCreateImageAtIndex(source, 0, nil),
      let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { fatalError("Cannot read the existing brand PNG") }
try require(original.width == 1024 && original.height == 1024, "Expected the original 1024px brand source image")

func context(_ size: Int) throws -> CGContext {
    guard let result = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
        bytesPerRow: size * 4, space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else {
        throw NSError(domain: "MioonIcon", code: 2)
    }
    result.interpolationQuality = .high
    result.setShouldAntialias(true)
    return result
}
func png(_ image: CGImage) throws -> Data {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
        throw NSError(domain: "MioonIcon", code: 3)
    }
    CGImageDestinationAddImage(destination, image, nil)
    try require(CGImageDestinationFinalize(destination), "Could not encode icon PNG")
    return data as Data
}
// AgentKib's macOS image occupies about 80% of its canvas. A continuous
// fourth-order superellipse gives the black tile rounded, tangent corners.
let canvas = try context(1024)
let plate = CGRect(x: 102.4, y: 102.4, width: 819.2, height: 819.2)
let mask = CGMutablePath()
for step in 0...2048 {
    let angle = Double(step) * 2 * Double.pi / 2048
    let cosine = cos(angle), sine = sin(angle)
    let point = CGPoint(x: plate.midX + plate.width / 2 * copysign(sqrt(abs(cosine)), cosine),
                        y: plate.midY + plate.height / 2 * copysign(sqrt(abs(sine)), sine))
    if step == 0 { mask.move(to: point) } else { mask.addLine(to: point) }
}
mask.closeSubpath()
canvas.addPath(mask)
canvas.clip()
canvas.draw(original, in: plate)
guard let framed = canvas.makeImage(), let pixels = canvas.data else { fatalError("Cannot render macOS icon") }
let rgba = pixels.assumingMemoryBound(to: UInt8.self)
try require(rgba[3] == 0 && rgba[(512 * 1024 + 512) * 4 + 3] == 255, "Icon must have transparent corners and an opaque center")

let iconset = temporary.appendingPathComponent("Mioon.iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
let fullPNG = try png(framed)
for (name, size) in [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024)
] {
    let data: Data
    if size == 1024 { data = fullPNG }
    else {
        let scaled = try context(size)
        scaled.draw(framed, in: CGRect(x: 0, y: 0, width: size, height: size))
        guard let image = scaled.makeImage() else { fatalError("Cannot downsample icon") }
        data = try png(image)
    }
    try data.write(to: iconset.appendingPathComponent(name))
}
let icnsURL = temporary.appendingPathComponent("icon.icns")
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["--convert", "icns", "--output", icnsURL.path, iconset.path]
try iconutil.run()
iconutil.waitUntilExit()
try require(iconutil.terminationStatus == 0, "iconutil failed")
let icns = try Data(contentsOf: icnsURL)
func uint32(_ offset: Int) -> Int { icns[offset..<(offset + 4)].reduce(0) { ($0 << 8) | Int($1) } }
try require(icns.count >= 8 && String(data: icns.prefix(4), encoding: .ascii) == "icns" && uint32(4) == icns.count, "Invalid ICNS header")
var offset = 8, largest: Data?
while offset < icns.count {
    try require(offset + 8 <= icns.count, "Truncated ICNS entry")
    let length = uint32(offset + 4)
    try require(length >= 8 && offset + length <= icns.count, "Invalid ICNS entry size")
    if String(data: icns[offset..<(offset + 4)], encoding: .ascii) == "ic10" {
        try require(largest == nil, "Duplicate ICNS 1024px image")
        largest = icns.subdata(in: (offset + 8)..<(offset + length))
    }
    offset += length
}
try require(largest == fullPNG, "ICNS and Dock PNG must contain identical 1024px PNG bytes")
try fullPNG.write(to: resources.appendingPathComponent("icon.png"), options: .atomic)
try icns.write(to: resources.appendingPathComponent("icon.icns"), options: .atomic)
print("Generated shared desktop icon.png and icon.icns from the unchanged icon-source.png")
