import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const PREVIEW_DIR = path.join(os.homedir(), ".pi", "pptx-preview");

/**
 * Check if a command exists on the system
 */
function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a command and return stdout
 */
async function runCommand(
  cmd: string,
  args: string[],
  options?: { cwd?: string; timeout?: number }
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: options?.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => (stdout += data.toString()));
    proc.stderr.on("data", (data) => (stderr += data.toString()));

    const timeout = options?.timeout ?? 60000;
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ stdout, stderr: stderr + "\nProcess timed out", code: -1 });
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 0 });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, code: -1 });
    });
  });
}

/**
 * Ensure directory exists
 */
async function ensureDir(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Convert PPTX to PDF using LibreOffice
 */
async function pptxToPdf(pptxPath: string, outDir: string): Promise<string> {
  const soffice = commandExists("soffice") ? "soffice" : "libreoffice";
  
  if (!commandExists(soffice)) {
    throw new Error(
      "LibreOffice not found. Install with: brew install --cask libreoffice"
    );
  }

  await ensureDir(outDir);

  const result = await runCommand(soffice, [
    "--headless",
    "--convert-to",
    "pdf",
    "--outdir",
    outDir,
    pptxPath,
  ]);

  if (result.code !== 0) {
    throw new Error(`LibreOffice conversion failed: ${result.stderr}`);
  }

  const baseName = path.basename(pptxPath, path.extname(pptxPath));
  const pdfPath = path.join(outDir, `${baseName}.pdf`);

  // Verify PDF was created
  try {
    await fs.access(pdfPath);
  } catch {
    throw new Error(`PDF not created at expected path: ${pdfPath}`);
  }

  return pdfPath;
}

/**
 * Convert PDF to PNG using pdftoppm (poppler)
 */
async function pdfToPng(
  pdfPath: string,
  outDir: string,
  options?: { dpi?: number; pageNumber?: number }
): Promise<string[]> {
  if (!commandExists("pdftoppm")) {
    throw new Error(
      "pdftoppm not found. Install with: brew install poppler"
    );
  }

  await ensureDir(outDir);

  const baseName = path.basename(pdfPath, ".pdf");
  const outputPrefix = path.join(outDir, baseName);
  const dpi = options?.dpi ?? 150;

  const args = ["-png", "-r", String(dpi)];

  // If specific page requested, use -f and -l flags
  if (options?.pageNumber !== undefined) {
    args.push("-f", String(options.pageNumber), "-l", String(options.pageNumber));
    args.push("-singlefile"); // Don't add page numbers to filename
  }

  args.push(pdfPath, outputPrefix);

  const result = await runCommand("pdftoppm", args);

  if (result.code !== 0) {
    throw new Error(`pdftoppm conversion failed: ${result.stderr}`);
  }

  // Find generated PNG files
  const files = await fs.readdir(outDir);
  const pngFiles = files
    .filter((f) => f.startsWith(baseName) && f.endsWith(".png"))
    .map((f) => path.join(outDir, f))
    .sort();

  if (pngFiles.length === 0) {
    throw new Error("No PNG files generated");
  }

  return pngFiles;
}

/**
 * Get PDF page count using pdfinfo
 */
async function getPdfPageCount(pdfPath: string): Promise<number> {
  if (!commandExists("pdfinfo")) {
    // Fallback: assume 1 page if pdfinfo not available
    return 1;
  }

  const result = await runCommand("pdfinfo", [pdfPath]);
  const match = result.stdout.match(/Pages:\s*(\d+)/);
  return match ? parseInt(match[1], 10) : 1;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "pptx_preview",
    label: "PPTX Preview",
    description:
      "Convert a PowerPoint file (.pptx) to PNG images for preview. Returns the path(s) to the generated image(s). Use the read tool to view the images.",
    promptSnippet:
      "Convert PPTX to PNG images for visual preview while building presentations.",
    promptGuidelines: [
      "Use pptx_preview to see how a PowerPoint slide looks after generating or editing it.",
      "After pptx_preview returns the image path, use the read tool to view the actual image.",
      "pptx_preview converts via LibreOffice and poppler - both must be installed.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the .pptx file to preview",
      }),
      slideNumber: Type.Optional(
        Type.Number({
          description:
            "Specific slide number to preview (1-indexed). Omit to preview all slides.",
        })
      ),
      dpi: Type.Optional(
        Type.Number({
          description: "Resolution in DPI. Defaults to 150.",
        })
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const pptxPath = path.isAbsolute(params.path)
        ? params.path
        : path.join(ctx.cwd, params.path);

      // Verify file exists
      try {
        await fs.access(pptxPath);
      } catch {
        return {
          content: [{ type: "text", text: `File not found: ${pptxPath}` }],
          details: { error: "File not found", path: pptxPath },
          isError: true,
        };
      }

      // Verify it's a pptx file
      if (!pptxPath.toLowerCase().endsWith(".pptx")) {
        return {
          content: [
            { type: "text", text: `Not a PowerPoint file: ${pptxPath}` },
          ],
          details: { error: "Invalid file type", path: pptxPath },
          isError: true,
        };
      }

      try {
        // Create temp directory for this preview
        const timestamp = Date.now();
        const baseName = path.basename(pptxPath, ".pptx");
        const workDir = path.join(PREVIEW_DIR, `${baseName}-${timestamp}`);
        await ensureDir(workDir);

        // Step 1: Convert PPTX to PDF
        const pdfPath = await pptxToPdf(pptxPath, workDir);

        // Step 2: Get page count
        const pageCount = await getPdfPageCount(pdfPath);

        // Step 3: Convert PDF to PNG(s)
        const pngPaths = await pdfToPng(pdfPath, workDir, {
          dpi: params.dpi ?? 150,
          pageNumber: params.slideNumber,
        });

        // Clean up PDF
        try {
          await fs.unlink(pdfPath);
        } catch {
          // Ignore cleanup errors
        }

        const resultText =
          pngPaths.length === 1
            ? `Preview generated: ${pngPaths[0]}\n\nUse the read tool to view this image.`
            : `${pngPaths.length} slide previews generated:\n${pngPaths.join("\n")}\n\nUse the read tool to view these images.`;

        return {
          content: [{ type: "text", text: resultText }],
          details: {
            pptxPath,
            pngPaths,
            slideCount: pageCount,
            previewedSlide: params.slideNumber ?? "all",
            dpi: params.dpi ?? 150,
          },
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Preview failed: ${message}` }],
          details: { error: message, path: pptxPath },
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "pptx_preview_cleanup",
    label: "PPTX Preview Cleanup",
    description:
      "Clean up old preview images from the preview directory to save disk space.",
    parameters: Type.Object({
      olderThanHours: Type.Optional(
        Type.Number({
          description:
            "Delete previews older than this many hours. Defaults to 24.",
        })
      ),
    }),
    async execute(_id, params) {
      const maxAgeMs = (params.olderThanHours ?? 24) * 60 * 60 * 1000;
      const now = Date.now();
      let deleted = 0;

      try {
        const entries = await fs.readdir(PREVIEW_DIR, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.isDirectory()) {
            const dirPath = path.join(PREVIEW_DIR, entry.name);
            const stat = await fs.stat(dirPath);

            if (now - stat.mtimeMs > maxAgeMs) {
              await fs.rm(dirPath, { recursive: true, force: true });
              deleted++;
            }
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `Cleaned up ${deleted} old preview directories.`,
            },
          ],
          details: { deleted, previewDir: PREVIEW_DIR },
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Cleanup failed: ${message}` }],
          details: { error: message },
          isError: true,
        };
      }
    },
  });
}
