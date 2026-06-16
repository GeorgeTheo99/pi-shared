// Generate a 1024x1024 placeholder app icon with CoreGraphics (no PIL/ImageMagick).
//   swift gen-placeholder-icon.swift /path/to/icon-1024.png
// Produces a simple house glyph on an indigo gradient. Replace with real art later.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon-1024.png"
let size = 1024
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                    bytesPerRow: 0, space: cs,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!

// Background gradient (deep indigo)
let colors = [CGColor(red: 0.10, green: 0.11, blue: 0.20, alpha: 1),
              CGColor(red: 0.20, green: 0.16, blue: 0.42, alpha: 1)] as CFArray
let grad = CGGradient(colorsSpace: cs, colors: colors, locations: [0, 1])!
ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: 1024), end: CGPoint(x: 1024, y: 0), options: [])

// House mark (warm accent)
ctx.setFillColor(CGColor(red: 0.99, green: 0.79, blue: 0.32, alpha: 1))
let cx = 512.0
ctx.move(to: CGPoint(x: cx, y: 760))
ctx.addLine(to: CGPoint(x: 300, y: 540))
ctx.addLine(to: CGPoint(x: 724, y: 540))
ctx.closePath(); ctx.fillPath()
ctx.addPath(CGPath(roundedRect: CGRect(x: 360, y: 300, width: 304, height: 260),
                   cornerWidth: 28, cornerHeight: 28, transform: nil))
ctx.fillPath()
// Door cut-out
ctx.setFillColor(CGColor(red: 0.13, green: 0.13, blue: 0.26, alpha: 1))
ctx.addPath(CGPath(roundedRect: CGRect(x: 476, y: 300, width: 72, height: 150),
                   cornerWidth: 16, cornerHeight: 16, transform: nil))
ctx.fillPath()

let img = ctx.makeImage()!
let url = URL(fileURLWithPath: out) as CFURL
let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, img, nil)
CGImageDestinationFinalize(dest)
print("wrote \(out)")
