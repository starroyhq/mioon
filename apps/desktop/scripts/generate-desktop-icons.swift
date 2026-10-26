#!/usr/bin/env swift
// Compile the unmasked brand artwork with Apple's icon pipeline; do not draw
// our own rounded mask, padding, edge highlights or shadows.
import Foundation
import ImageIO

func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw NSError(domain: "MioonIcon", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}
let resources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("resources")
let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("mioon-icon-\(UUID().uuidString)")
try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: temporary) }
let sourceURL = resources.appendingPathComponent("icon-source.png")
let sourceData = try Data(contentsOf: sourceURL)
guard let source = CGImageSourceCreateWithData(sourceData as CFData, nil),
      let original = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fatalError("Cannot read the existing brand PNG") }
try require(original.width == 1024 && original.height == 1024, "Expected the original 1024px brand source image")

// The document schema follows Xcode's macOS Icon Composer template and Apple's
// Landmarks sample. The existing opaque, square artwork is used as one flat
// layer, with no extra material applied to the colored brand mark.
let document = temporary.appendingPathComponent("Mioon.icon")
let assets = document.appendingPathComponent("Assets")
let compiled = temporary.appendingPathComponent("compiled")
try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: compiled, withIntermediateDirectories: true)
try sourceData.write(to: assets.appendingPathComponent("Brand.png"))
let composition = """
{
  "fill": {"solid": "extended-srgb:0.00000,0.00000,0.00000,1.00000"},
  "groups": [{
    "layers": [{"image-name": "Brand.png", "name": "Mioon", "glass": false, "hidden": false, "opacity": 1}],
    "lighting": "individual", "specular": false,
    "shadow": {"kind": "neutral", "opacity": 0},
    "translucency": {"enabled": false, "value": 0.5}
  }],
  "supported-platforms": {"squares": ["macOS"]}
}
"""
try Data(composition.utf8).write(to: document.appendingPathComponent("icon.json"))
let compiler = Process()
compiler.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
// This is the icon asset export target, not the app's deployment target.
// actool targets >=10.13 emit only a partial ICNS and put higher resolutions
// in Assets.car. 10.12 requests the complete standalone ICNS used by Electron.
compiler.arguments = ["actool", document.path, "--compile", compiled.path,
    "--platform", "macosx", "--minimum-deployment-target", "10.12",
    "--app-icon", "Mioon", "--target-device", "mac",
    "--output-partial-info-plist", compiled.appendingPathComponent("partial.plist").path,
    "--output-format", "human-readable-text"]
try compiler.run()
compiler.waitUntilExit()
try require(compiler.terminationStatus == 0, "Apple actool failed; select a full Xcode installation with Icon Composer support")
let icnsURL = compiled.appendingPathComponent("Mioon.icns")
let icns = try Data(contentsOf: icnsURL)
func uint32(_ offset: Int) -> Int { icns[offset..<(offset + 4)].reduce(0) { ($0 << 8) | Int($1) } }
try require(icns.count >= 8 && String(data: icns.prefix(4), encoding: .ascii) == "icns" && uint32(4) == icns.count, "Invalid ICNS header")
var offset = 8, largest: Data?
var representations = Set<String>()
while offset < icns.count {
    try require(offset + 8 <= icns.count, "Truncated ICNS entry")
    let length = uint32(offset + 4)
    try require(length >= 8 && offset + length <= icns.count, "Invalid ICNS entry size")
    let type = String(data: icns[offset..<(offset + 4)], encoding: .ascii) ?? ""
    try require(representations.insert(type).inserted, "Duplicate ICNS image")
    if type == "ic10" {
        largest = icns.subdata(in: (offset + 8)..<(offset + length))
    }
    offset += length
}
try require(representations.isSuperset(of: ["ic04", "ic05", "ic07", "ic08", "ic09", "ic10", "ic11", "ic12", "ic13", "ic14"]), "Apple's standalone ICNS must retain all legacy and Retina sizes")
guard let fullPNG = largest,
      let renderedSource = CGImageSourceCreateWithData(fullPNG as CFData, nil),
      let rendered = CGImageSourceCreateImageAtIndex(renderedSource, 0, nil) else { fatalError("Apple's ICNS is missing its 1024px PNG") }
try require(rendered.width == 1024 && rendered.height == 1024, "Apple's largest icon must be 1024px")
try fullPNG.write(to: resources.appendingPathComponent("icon.png"), options: .atomic)
try icns.write(to: resources.appendingPathComponent("icon.icns"), options: .atomic)
print("Generated Apple-compiled icon.icns and its identical 1024px icon.png from the unmasked icon-source.png")
