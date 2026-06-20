#!/usr/bin/env python3
"""Milestone-2 synthetic test: IndexShare top-k threading runs end-to-end.

Builds a TINY glm_moe_dsa model (4 layers: full, shared, shared, full),
runs a prefill forward + a decode step with cache, and asserts:
  - output shape correct, finite (no NaN/inf)
  - indexer present only on full layers; shared layers reuse prev topk
  - next_skip_topk flags match the indexer_types pattern

This validates the threading math in isolation (no 368GB load).
"""
import sys
from pathlib import Path

from omlx.patches.glm_5_2 import apply_glm_5_2_patch

apply_glm_5_2_patch()

import mlx.core as mx  # noqa: E402
import mlx.nn as nn  # noqa: E402
from mlx_lm.models.glm_moe_dsa import Model, ModelArgs  # noqa: E402  (patched)

# Tiny 4-layer IndexShare config: [full, shared, shared, full]
cfg = {
    "model_type": "glm_moe_dsa",
    "vocab_size": 256,
    "hidden_size": 64,
    "num_hidden_layers": 4,
    "num_attention_heads": 4,
    "num_key_value_heads": 4,
    "q_lora_rank": 32,
    "kv_lora_rank": 32,
    "qk_rope_head_dim": 8,
    "qk_nope_head_dim": 8,
    "qk_head_dim": 16,
    "v_head_dim": 16,
    "head_dim": 16,
    "index_head_dim": 16,
    "index_n_heads": 4,
    "index_topk": 2,           # < seq_len so sparse path triggers
    "intermediate_size": 128,
    "moe_intermediate_size": 32,
    "n_shared_experts": 1,
    "n_routed_experts": 4,
    "num_experts_per_tok": 2,
    "first_k_dense_replace": 4,  # all-dense MLP (avoid MoE in this test)
    "moe_layer_freq": 1,
    "max_position_embeddings": 512,
    "rms_norm_eps": 1e-5,
    # GLM-5.2 stores the authoritative RoPE base in `rope_parameters`,
    # not top-level `rope_theta`; keep these intentionally different so this
    # synthetic test catches regressions to DeepSeekV32's inherited default.
    "rope_theta": 10000.0,
    "rope_parameters": {"rope_theta": 8000000.0, "rope_type": "default"},
    "attention_bias": False,
    "topk_method": "noaux_tc",
    "scoring_func": "sigmoid",
    "norm_topk_prob": True,
    "n_group": 1,
    "topk_group": 1,
    "routed_scaling_factor": 1.0,
    "indexer_types": ["full", "shared", "shared", "full"],
    "indexer_rope_interleave": True,
    "index_share_for_mtp_iteration": False,
    "index_skip_topk_offset": 0,
    "index_topk_freq": 1,
    "num_nextn_predict_layers": 0,
    "ep_size": 1,
    "mlp_layer_types": ["dense", "dense", "dense", "dense"],
}

args = ModelArgs.from_dict(cfg)
assert args.rope_theta == 8000000.0, "rope_parameters.rope_theta was not normalized"
model = Model(args)
mx.eval(model.parameters())

# --- property assertions: IndexShare wiring ---
layers = model.model.layers
fullness = [l.self_attn.is_full for l in layers]
next_skip = [l.self_attn.next_skip_topk for l in layers]
has_indexer = [l.self_attn.indexer is not None for l in layers]
# next_skip_topk[i] = (types[i+1]=="shared"): layer0->shared1 True,
# layer1->shared2 True, layer2->full3 False, layer3 last False.
print(f"is_full:       {fullness}   expected [True, False, False, True]")
print(f"has_indexer:   {has_indexer} expected [True, False, False, True]")
print(f"next_skip_topk:{next_skip}  expected [True, True, False, False]")
assert fullness == [True, False, False, True], "is_full mismatch"
assert has_indexer == [True, False, False, True], "indexer presence mismatch"
assert next_skip == [True, True, False, False], "next_skip_topk mismatch"

# --- prefill forward (L=8 > index_topk=2 → sparse path) ---
SEQ = 8
toks = mx.random.randint(0, cfg["vocab_size"], (1, SEQ))
logits = model(toks)
mx.eval(logits)
print(f"\nprefill logits shape: {logits.shape}  expected (1, {SEQ}, {cfg['vocab_size']})")
assert logits.shape == (1, SEQ, cfg["vocab_size"]), "prefill shape mismatch"
assert mx.all(mx.isfinite(logits)).item(), "prefill logits not finite (NaN/inf)!"
print("prefill: finite, shape OK")

# --- decode step with cache (L=1) ---
cache = model.make_cache()
# prime cache with the prefill (re-run prefill WITH cache to populate it)
_ = model(toks, cache)
mx.eval(_)
# now a single decode step
dec_tok = mx.array([[cfg["vocab_size"] - 1]])
dec_logits = model(dec_tok, cache)
mx.eval(dec_logits)
print(f"decode logits shape: {dec_logits.shape}  expected (1, 1, {cfg['vocab_size']})")
assert dec_logits.shape == (1, 1, cfg["vocab_size"]), "decode shape mismatch"
assert mx.all(mx.isfinite(dec_logits)).item(), "decode logits not finite (NaN/inf)!"
print("decode: finite, shape OK")

print("\nMILESTONE 2 (synthetic): IndexShare top-k threading runs — prefill + decode OK")
