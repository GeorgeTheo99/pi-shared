#!/usr/bin/env python3
"""Milestone-1 authoritative check: real mlx_lm.load + 1-token generate.

Applies the IndexShare patch, loads the full 368GB GLM-5.2-mxfp4
checkpoint (strict), and generates one token from a short prompt to
confirm the forward pass runs end-to-end (shared layers use the dense
fallback for now — correctness is milestone 2; this only proves
load + smoke-run).

  ~/.local/share/uv/tools/omlx/bin/python real_load.py
"""
import sys
import time
from pathlib import Path

MODEL = Path.home() / "models/mlx/GLM-5.2-mxfp4"

from omlx.patches.glm_5_2 import apply_glm_5_2_patch

apply_glm_5_2_patch()

import mlx.core as mx  # noqa: E402
import mlx_lm  # noqa: E402

t0 = time.time()
print("loading model (368GB)...", flush=True)
model, tokenizer = mlx_lm.load(str(MODEL))
print(f"LOAD OK in {time.time()-t0:.1f}s  params={sum(p.size for _,p in mx.utils.tree_flatten(model.parameters()))/1e9:.1f}B", flush=True)

prompt = "The capital of France is"
t1 = time.time()
tokens = tokenizer.encode(prompt)
print(f"prompt={prompt!r}  tokens={len(tokens)}", flush=True)
out = model(mx.array(tokens)[None])  # forward pass, no cache
next_tok = int(mx.argmax(out[0, -1]).item())
print(f"FORWARD OK in {time.time()-t1:.1f}s  next_tok={next_tok} ({tokenizer.decode([next_tok])!r})", flush=True)
print("\nMILESTONE 1 CONFIRMED: model loads strictly + forward runs", flush=True)
