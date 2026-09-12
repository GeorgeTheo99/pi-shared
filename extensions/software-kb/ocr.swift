// Optional offline OCR helper: macOS system frameworks only. Writes one string per PDF page.
import AppKit
import PDFKit
import Vision

func extract() throws {
    guard CommandLine.arguments.count == 3,
          let document = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1])),
          document.pageCount > 0, document.pageCount <= 100 else {
        throw NSError(domain: "SoftwareKB", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid PDF or excessive page count"])
    }
    var pages: [String] = []
    for index in 0..<document.pageCount {
        let text: String = try autoreleasepool {
            guard let page = document.page(at: index) else {
                throw NSError(domain: "SoftwareKB", code: 2)
            }
            let bounds = page.bounds(for: .mediaBox)
            guard bounds.width > 0, bounds.height > 0 else {
                throw NSError(domain: "SoftwareKB", code: 3)
            }
            let scale = 2400 / max(bounds.width, bounds.height)
            let image = page.thumbnail(of: NSSize(width: bounds.width * scale, height: bounds.height * scale), for: .mediaBox)
            guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                throw NSError(domain: "SoftwareKB", code: 4)
            }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["en-US"]
            request.usesLanguageCorrection = true
            try VNImageRequestHandler(cgImage: cgImage).perform([request])
            return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        }
        pages.append(text)
    }
    let data = try JSONSerialization.data(withJSONObject: pages)
    try data.write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: .atomic)
}

do {
    try extract()
} catch {
    fputs("OCR failed: \(error.localizedDescription)\n", stderr)
    exit(1)
}
