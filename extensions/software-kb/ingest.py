#!/usr/bin/env python3
"""Explicit offline ingestion of user-provided PDFs; never downloads or publishes text."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

MAX_PDF = 128 * 1024 * 1024
MAX_TEXT = 32 * 1024 * 1024
MAX_INDEX = 64 * 1024 * 1024
MAX_PAGE_UNITS = 1024 * 1024  # Match JavaScript string.length in corpus.ts (UTF-16 units).


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run(command):
    result = subprocess.run(command, capture_output=True, timeout=180)
    if result.returncode:
        raise ValueError(f"{Path(command[0]).name} failed (exit {result.returncode})")
    return result


def extract(pdf, scratch, ocr):
    info = run(["pdfinfo", str(pdf)]).stdout.decode("utf-8", errors="replace")
    count = next((int(line.split(":", 1)[1]) for line in info.splitlines() if line.startswith("Pages:")), 0)
    if not 1 <= count <= 10000:
        raise ValueError("Invalid or excessive PDF page count")
    text_file = scratch / "pages.txt"
    result = run(["pdftotext", "-enc", "UTF-8", str(pdf), str(text_file)])
    if text_file.stat().st_size > MAX_TEXT:
        raise ValueError("Extracted text exceeds 32 MiB")
    pages = text_file.read_text(encoding="utf-8").split("\f")
    if pages and not pages[-1].strip():
        pages.pop()
    if len(pages) != count:
        raise ValueError("Extracted page count does not match pdfinfo")
    method = "pdftotext"
    if sum(len(p.strip()) for p in pages) < 80 and ocr:
        if sys.platform != "darwin" or not shutil.which("swift"):
            raise ValueError("OCR requires macOS with Swift/Vision; rerun without --ocr to report needs_ocr")
        if count > 100:
            raise ValueError("OCR is limited to 100 pages per document")
        ocr_file = scratch / "ocr.json"
        run(["swift", str(Path(__file__).with_name("ocr.swift")), str(pdf), str(ocr_file)])
        if ocr_file.stat().st_size > MAX_TEXT:
            raise ValueError("OCR text exceeds 32 MiB")
        pages = json.loads(ocr_file.read_text())
        if not isinstance(pages, list) or len(pages) != count or not all(isinstance(p, str) for p in pages):
            raise ValueError("Invalid OCR page output")
        method = "apple-vision-ocr"
    records = [{"page": i + 1, "text": text.strip()} for i, text in enumerate(pages) if text.strip()]
    if any(len(page["text"].encode("utf-16-le")) // 2 > MAX_PAGE_UNITS for page in records):
        raise ValueError("Extracted page exceeds 1,048,576 UTF-16 units")
    status = "indexed" if sum(len(p["text"]) for p in records) >= 80 else "needs_ocr"
    return {"status": status, "page_count": count, "pages": records if status == "indexed" else [],
            "method": method, "warning": "pdftotext reported warnings" if result.stderr else None}


def ingest(root, ocr=False):
    root = Path(root).resolve()
    catalog_bytes = (root / "sources.json").read_bytes()
    mappings_bytes = (root / "documents.json").read_bytes()
    sources = {s["id"] for s in json.loads(catalog_bytes)["sources"]}
    mappings = json.loads(mappings_bytes)["documents"]
    if not isinstance(mappings, list) or len(mappings) > 200:
        raise ValueError("Expected at most 200 document mappings")
    seen = set()
    for mapping in mappings:
        name = mapping["file"]
        if not isinstance(name, str) or Path(name).name != name or not name.endswith(".pdf") or name in seen:
            raise ValueError("Invalid or duplicate PDF filename")
        if mapping["source_id"] not in sources:
            raise ValueError("Unknown source id")
        seen.add(name)
    input_dir = root / "corpus" / "pdf-downloads"
    private = root / "private"
    if private.is_symlink() or input_dir.is_symlink():
        raise ValueError("Private/input directories must not be symlinks")
    private.mkdir(mode=0o700, exist_ok=True)
    os.chmod(private, 0o700)
    documents = []
    for mapping in mappings:
        pdf = input_dir / mapping["file"]
        doc = {**mapping, "status": "missing", "pages": [], "page_count": 0,
               "completeness": "unverified", "redistribution_rights": "unverified"}
        try:
            if not pdf.exists():
                documents.append(doc)
                continue
            if pdf.is_symlink() or not pdf.is_file() or pdf.stat().st_size > MAX_PDF:
                raise ValueError("PDF must be a regular non-symlink file no larger than 128 MiB")
            data = pdf.read_bytes()
            doc["sha256"] = digest(data)
            doc["bytes"] = len(data)
            if not data.startswith(b"%PDF-"):
                raise ValueError("Not a PDF (missing PDF header)")
            with tempfile.TemporaryDirectory(prefix="extract-", dir=private) as directory:
                scratch = Path(directory)
                # Extract a snapshot, so the recorded digest identifies exactly the parsed bytes.
                snapshot = scratch / "input.pdf"
                snapshot.write_bytes(data)
                doc.update(extract(snapshot, scratch, ocr))
        except (ValueError, OSError, subprocess.TimeoutExpired) as exc:
            doc.update(status="error", pages=[], error=str(exc)[:500])
        documents.append(doc)
    index = {"version": 1, "catalog_sha256": digest(catalog_bytes),
             "documents_sha256": digest(mappings_bytes), "documents": documents}
    encoded = (json.dumps(index, ensure_ascii=False) + "\n").encode("utf-8")
    if len(encoded) > MAX_INDEX:
        raise ValueError("Index exceeds 64 MiB")
    path = None
    try:
        with tempfile.NamedTemporaryFile(dir=private, prefix="index-", delete=False) as stream:
            path = Path(stream.name)
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(path, private / "index.json")
    finally:
        if path is not None:
            path.unlink(missing_ok=True)
    return index


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--private", action="store_true", required=True,
                        help="Explicitly request local private indexing; this does not grant redistribution rights")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2] / "knowledge/software-engineering")
    parser.add_argument("--ocr", action="store_true", help="Use macOS Vision on documents without extractable text (100-page cap)")
    args = parser.parse_args()
    if not shutil.which("pdfinfo") or not shutil.which("pdftotext"):
        parser.error("Poppler is required: install pdfinfo and pdftotext (macOS: brew install poppler)")
    index = ingest(args.root, args.ocr)
    summary = [{k: v for k, v in d.items() if k != "pages"} | {"indexed_pages": len(d["pages"])} for d in index["documents"]]
    print(json.dumps({"index": str(args.root / "private/index.json"), "documents": summary}, indent=2))
    # Expected per-document problems are recorded in the index, but must not look like full success.
    return 2 if any(d["status"] != "indexed" for d in index["documents"]) else 0


if __name__ == "__main__":
    sys.exit(main())
