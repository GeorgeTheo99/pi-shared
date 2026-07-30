import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = join(root, "skills", "powerpoint");
const require = createRequire(import.meta.url);

test("only powerpoint is registered for local PowerPoint work", () => {
  const skillNames = readdirSync(join(root, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = join(root, "skills", entry.name, "SKILL.md");
      try {
        return readFileSync(path, "utf8").match(/^name:\s*(.+)$/m)?.[1];
      } catch {
        return undefined;
      }
    });
  assert.ok(skillNames.includes("powerpoint"));
  assert.ok(!skillNames.includes("slides"));
});

test("powerpoint keeps PptxGenJS and mandatory preview guidance", () => {
  const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  assert.match(skill, /PptxGenJS/);
  assert.match(skill, /Use `pptx_preview`[^\n]*This is mandatory/);
  assert.match(skill, /Do not use it for Google Slides URLs/);
});

test("layout helper diagnoses overlaps and out-of-bounds elements", () => {
  const layout = require(join(skillDir, "helpers", "layout.js"));
  const messages = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (...args) => messages.push(args.join(" "));
  console.log = (...args) => messages.push(args.join(" "));
  try {
    const pptx = { _presLayout: { width: 13.333, height: 7.5 } };
    const slide = {
      _slideObjects: [
        { type: "shape", options: { x: 1, y: 1, w: 2, h: 2 } },
        { type: "shape", options: { x: 2, y: 2, w: 2, h: 2 } },
        { type: "text", options: { x: 13, y: 7, w: 1, h: 1 } },
      ],
    };
    layout.warnIfSlideHasOverlaps(slide, pptx);
    layout.warnIfSlideElementsOutOfBounds(slide, pptx);
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
  assert.ok(messages.some((message) => message.toLowerCase().includes("overlap")));
  assert.ok(messages.some((message) => message.includes("exceeds slide bounds")));
});

test("font diagnostic CLI exposes help without optional Python packages", () => {
  const output = execFileSync(
    "python3",
    [join(skillDir, "scripts", "detect_font.py"), "--help"],
    { encoding: "utf8" },
  );
  assert.match(output, /Detect missing\/substituted fonts/);
});
