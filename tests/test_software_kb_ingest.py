import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "extensions/software-kb/ingest.py"
spec = importlib.util.spec_from_file_location("software_kb_ingest", SCRIPT)
ingestion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ingestion)


def pdf(pages):
    """Generate a tiny original, valid PDF; no copyrighted fixtures or parser libraries."""
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for text in pages:
        page_id = len(objects) + 1
        kids.append(f"{page_id} 0 R")
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {page_id + 1} 0 R >>".encode())
        content = f"BT /F1 10 Tf 40 700 Td ({text}) Tj ET".encode()
        objects.append(f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream")
    objects[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(pages)} >>".encode()
    result = b"%PDF-1.4\n"; offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(result)); result += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(result)
    result += f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode()
    result += b"".join(f"{offset:010} 00000 n \n".encode() for offset in offsets[1:])
    result += f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return result


class IngestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.originals = self.root / "corpus/pdf-downloads"
        self.originals.mkdir(parents=True)
        (self.root / "sources.json").write_text(json.dumps({"sources": [{"id": "fixture"}]}))
        self.mapping([{"file": "fixture.pdf", "source_id": "fixture"}])

    def mapping(self, documents):
        (self.root / "documents.json").write_text(json.dumps({"version": 1, "documents": documents}))

    @unittest.skipUnless(shutil.which("pdftotext") and shutil.which("pdfinfo"), "Poppler not installed")
    def test_real_extraction_blank_short_pages_permissions_and_atomic_replacement(self):
        data = pdf(["A synthetic engineering passage about software testing and correctness for our regression fixture.", "", "Short."])
        (self.originals / "fixture.pdf").write_bytes(data)
        index = ingestion.ingest(self.root)
        doc = index["documents"][0]
        self.assertEqual(doc["status"], "indexed")
        self.assertEqual(doc["page_count"], 3)
        self.assertEqual([p["page"] for p in doc["pages"]], [1, 3])
        self.assertEqual(doc["pages"][1]["text"], "Short.")
        self.assertEqual(doc["sha256"], ingestion.digest(data))
        self.assertEqual(doc["completeness"], "unverified")
        self.assertEqual((self.root / "private").stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.root / "private/index.json").stat().st_mode & 0o777, 0o600)
        (self.originals / "fixture.pdf").write_bytes(b"not PDF")
        replaced = ingestion.ingest(self.root)
        self.assertEqual(replaced["documents"][0]["status"], "error")
        self.assertEqual(replaced["documents"][0]["pages"], [])
        self.assertEqual(sorted(p.name for p in (self.root / "private").iterdir()), ["index.json"])

    def test_missing_and_invalid_files_are_retained_as_status_records(self):
        self.mapping([{"file": "fixture.pdf", "source_id": "fixture"}, {"file": "bad.pdf", "source_id": "fixture"}])
        (self.originals / "bad.pdf").write_text("<html>error page</html>")
        index = ingestion.ingest(self.root)
        self.assertEqual([d["status"] for d in index["documents"]], ["missing", "error"])
        self.assertIn("Not a PDF", index["documents"][1]["error"])

    def test_traversal_unknown_source_and_duplicate_mappings_are_rejected(self):
        for records in [[{"file": "../outside.pdf", "source_id": "fixture"}],
                        [{"file": "fixture.pdf", "source_id": "unknown"}],
                        [{"file": "fixture.pdf", "source_id": "fixture"}] * 2]:
            self.mapping(records)
            with self.assertRaises(ValueError): ingestion.ingest(self.root)

    @unittest.skipUnless(shutil.which("pdftotext") and shutil.which("pdfinfo"), "Poppler not installed")
    def test_no_text_is_needs_ocr_not_indexed(self):
        (self.originals / "fixture.pdf").write_bytes(pdf(["", ""]))
        doc = ingestion.ingest(self.root)["documents"][0]
        self.assertEqual(doc["status"], "needs_ocr")
        self.assertEqual(doc["page_count"], 2)
        self.assertEqual(doc["pages"], [])

    def test_oversized_page_is_document_error_not_an_invalid_whole_index(self):
        self.mapping([{"file": "fixture.pdf", "source_id": "fixture"}, {"file": "good.pdf", "source_id": "fixture"}])
        (self.originals / "fixture.pdf").write_bytes(b"%PDF-oversized")
        (self.originals / "good.pdf").write_bytes(b"%PDF-good")
        def conversion(command):
            if command[0] == "pdfinfo":
                return subprocess.CompletedProcess(command, 0, b"Pages: 1\n", b"")
            text = "x" * (ingestion.MAX_PAGE_UNITS + 1) if Path(command[-2]).read_bytes() == b"%PDF-oversized" else "Good synthetic text. " * 10
            Path(command[-1]).write_text(text + "\f", encoding="utf-8")
            return subprocess.CompletedProcess(command, 0, b"", b"")
        with patch.object(ingestion, "run", side_effect=conversion):
            index = ingestion.ingest(self.root)
        self.assertEqual([d["status"] for d in index["documents"]], ["error", "indexed"])
        self.assertIn("UTF-16", index["documents"][0]["error"])
        self.assertEqual(index["documents"][0]["pages"], [])
        # Exercise the actual TypeScript reader against the produced index, not a hand-built fixture.
        if shutil.which("node"):
            reader = SCRIPT.with_name("corpus.ts").as_uri()
            check = subprocess.run(["node", "--input-type=module", "-e",
                f"import {{loadPrivateCorpus}} from {json.dumps(reader)}; const c=loadPrivateCorpus(process.argv[1]); if(c.state!=='ready'||c.documents[1].status!=='indexed')process.exit(1)", str(self.root)], capture_output=True, text=True)
            self.assertEqual(check.returncode, 0, check.stderr)

    def test_unicode_page_bound_matches_javascript_utf16_units(self):
        def conversion(command):
            if command[0] == "pdfinfo":
                return subprocess.CompletedProcess(command, 0, b"Pages: 1\n", b"")
            Path(command[-1]).write_text("\U0001f600" * (ingestion.MAX_PAGE_UNITS // 2 + 1) + "\f", encoding="utf-8")
            return subprocess.CompletedProcess(command, 0, b"", b"")
        with patch.object(ingestion, "run", side_effect=conversion):
            with self.assertRaisesRegex(ValueError, "UTF-16"):
                ingestion.extract(self.originals / "fixture.pdf", self.root, False)

    def test_timeout_is_recorded_without_partial_pages(self):
        (self.originals / "fixture.pdf").write_bytes(b"%PDF-1.4 placeholder")
        with patch.object(ingestion, "run", side_effect=subprocess.TimeoutExpired("pdfinfo", 180)):
            doc = ingestion.ingest(self.root)["documents"][0]
        self.assertEqual(doc["status"], "error")
        self.assertEqual(doc["pages"], [])

    def test_symlink_inputs_are_not_followed(self):
        (self.originals / "fixture.pdf").symlink_to(self.root / "sources.json")
        self.assertEqual(ingestion.ingest(self.root)["documents"][0]["status"], "error")

    def test_private_directory_symlinks_are_rejected(self):
        (self.root / "private").symlink_to(self.originals, target_is_directory=True)
        with self.assertRaises(ValueError): ingestion.ingest(self.root)

    def test_cli_requires_explicit_private_flag(self):
        result = subprocess.run(["python3", str(SCRIPT), "--root", str(self.root)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("--private", result.stderr)
        self.assertFalse((self.root / "private").exists())


if __name__ == "__main__":
    unittest.main()
