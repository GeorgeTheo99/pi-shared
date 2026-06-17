#!/usr/bin/env python3
"""Milestone-1 verification: GLM-5.2 model LOADS strictly (name-only check).

Instantiates the patched model from config, applies the checkpoint's
quantization, then compares the model's parameter-name set against the
safetensors index keys. For a pre-converted MLX GLM-5.2 checkpoint
(switch_mlp already stacked, embed_q/unembed_out already split, no fp8,
no MTP) sanitize is identity, so the two sets must be exactly equal.

Run with the omlx venv python:
  ~/.local/share/uv/tools/omlx/bin/python check_load.py
"""
import json
import sys
from pathlib import Path

MODEL = Path.home() / "models/mlx/GLM-5.2-mxfp4"

# 1. Apply the IndexShare patch (registers glm_5_2 model over stock glm_moe_dsa)
from omlx.patches.glm_5_2 import apply_glm_5_2_patch  # noqa: E402

assert apply_glm_5_2_patch(), "patch already applied? expected fresh apply"

# 2. Load config + build model via the same path mlx_lm.load uses
import mlx.nn as nn  # noqa: E402
import mlx_lm.utils as lu  # noqa: E402
from mlx.utils import tree_flatten  # noqa: E402

cfg = lu.load_config(MODEL)
print(f"model_type={cfg.get('model_type')} indexer_types={'present' if 'indexer_types' in cfg else 'ABSENT'}")
print(f"num_hidden_layers={cfg['num_hidden_layers']} quant={cfg.get('quantization')}")

model_class, model_args_class = lu._get_classes(cfg)
print(f"model_class={model_class.__module__}.{model_class.__name__}")
args = model_args_class.from_dict(cfg)
print(f"indexer_types captured in args? {getattr(args, 'indexer_types', None) is not None}")
print(f"full layers: {[i for i,t in enumerate(args.indexer_types) if t=='full']}" if args.indexer_types else "(no indexer_types)")

model = model_class(args)

# 3. Apply quantization (mirrors mlx_lm.load: nn.quantize before load_weights)
qcfg = cfg.get("quantization", cfg.get("quantization_config"))
print(f"applying nn.quantize(**{qcfg})")
nn.quantize(model, **qcfg)

# 4. Model param names (post-quantize)
model_params = dict(tree_flatten(model.parameters()))
model_names = set(model_params.keys())
print(f"\nmodel param count: {len(model_names)}")

# 5. Checkpoint key names (no tensors loaded — index only)
idx = json.loads((MODEL / "model.safetensors.index.json").read_text())
ckpt_names = set(idx["weight_map"].keys())
print(f"checkpoint key count: {len(ckpt_names)}")

missing = model_names - ckpt_names    # model defines, checkpoint lacks
unexpected = ckpt_names - model_names  # checkpoint has, model lacks

print(f"\nMISSING   (model expects, checkpoint lacks): {len(missing)}")
print(f"UNEXPECTED (checkpoint has, model lacks)    : {len(unexpected)}")

if missing:
    print("\n--- sample MISSING (first 15) ---")
    for k in sorted(missing)[:15]:
        print("  ", k)
if unexpected:
    print("\n--- sample UNEXPECTED (first 15) ---")
    for k in sorted(unexpected)[:15]:
        print("  ", k)

# 6. Indexer sanity: count indexer params the model defines, per layer
import re, collections
idx_layers = collections.Counter()
for k in model_names:
    m = re.match(r"model\.layers\.(\d+)\.self_attn\.indexer\.", k)
    if m:
        idx_layers[int(m.group(1))] += 1
full_in_model = sorted(idx_layers)
print(f"\nmodel indexer layers: {len(full_in_model)} -> {full_in_model}")
print(f"expected full layers: [0,1,2,6,10,14,18,22,26,30,34,38,42,46,50,54,58,62,66,70,74]")

ok = not missing and not unexpected
print(f"\n{'PASS — strict load will succeed (name-only check)' if ok else 'FAIL — param name mismatch'}")
sys.exit(0 if ok else 1)
