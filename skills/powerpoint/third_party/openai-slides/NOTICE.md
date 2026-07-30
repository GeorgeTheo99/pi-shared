# OpenAI slides provenance

The following files were copied without modification from OpenAI's `slides` skill:

- `helpers/layout.js` from `skills/.curated/slides/assets/pptxgenjs_helpers/layout.js`
- `helpers/text.js` from `skills/.curated/slides/assets/pptxgenjs_helpers/text.js`
- `scripts/detect_font.py` from `skills/.curated/slides/scripts/detect_font.py`

Source repository: <https://github.com/openai/skills>

Source revision: `e6afb0d74cc75d220df2faf3dd6c635c2dc6a108` (the last revision before the upstream `slides` skill was removed from the deprecated repository)

Immutable source links:

- <https://github.com/openai/skills/blob/e6afb0d74cc75d220df2faf3dd6c635c2dc6a108/skills/.curated/slides/assets/pptxgenjs_helpers/layout.js>
- <https://github.com/openai/skills/blob/e6afb0d74cc75d220df2faf3dd6c635c2dc6a108/skills/.curated/slides/assets/pptxgenjs_helpers/text.js>
- <https://github.com/openai/skills/blob/e6afb0d74cc75d220df2faf3dd6c635c2dc6a108/skills/.curated/slides/scripts/detect_font.py>
- <https://github.com/openai/skills/blob/e6afb0d74cc75d220df2faf3dd6c635c2dc6a108/skills/.curated/slides/LICENSE.txt>

Original addition: `7b54889398822db28c72aeec8e95be7c20418d1a` (`[codex] Add curated slides and playwright-interactive skills (#215)`, 2026-03-05)

SHA-256 checksums of the unmodified vendored files:

```text
774076d2671697c56c9df7d968c7f46be337dd7d63508d75e0f6976237a5db96  helpers/layout.js
ba5f0e38929bd9a826397ca597618a23b89561a2c2f097d3289f5364611c7ccf  helpers/text.js
07537d7181f79fb65e84810604ddd814165d1ac90481b208bb8b206048aa637d  scripts/detect_font.py
9a7110fc2d2f964038e5dc49128f908f29f47a574c961cba16085914e879cbda  third_party/openai-slides/LICENSE.txt
```

License: Apache License 2.0. The source skill's license is reproduced in `LICENSE.txt`.

Vendored on: 2026-07-30

Only the text-fitting, geometry/validation, and font-diagnostic components were selected. Rendering and montage scripts were not vendored because `pi-shared` already provides the mandatory `pptx_preview` rendering workflow; the upstream renderer also adds Python dependencies that are not installed by this package. Image, LaTeX, syntax-highlighting, and layout-builder modules were omitted to keep the integration minimal.
