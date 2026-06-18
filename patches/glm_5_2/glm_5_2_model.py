# SPDX-License-Identifier: Apache-2.0
"""IndexShare-aware GLM-5.2 (``glm_moe_dsa``) model for mlx-lm v0.31.3.

Port of ``mlx_lm/models/deepseek_v32.py`` with the minimal changes
required for GLM-5.2's IndexShare DSA:

1. ``ModelArgs`` adds GLM-5.2-specific fields (``indexer_types`` and
   friends) with defaults so GLM-5.1 (no ``indexer_types``) still loads.
2. ``Glm52Attention`` only instantiates ``Indexer`` on ``"full"`` layers
   (21 of 78); ``"shared"`` layers get ``self.indexer = None`` so the
   model defines no indexer parameters for them — matching a checkpoint
   that ships indexer weights for full layers only.
3. **top-k threading (IndexShare)**: a full layer whose *next* layer is
   shared (``next_skip_topk``) returns its ``topk_indices``; shared
   layers reuse ``prev_topk_indices`` from the preceding full layer
   instead of recomputing. The model loop threads ``topk_indices`` →
   ``prev_topk_indices`` between layers. Ported from
   ``transformers.models.glm_moe_dsa.modeling_glm_moe_dsa``.
4. The ``mx.depends(cache[0].keys, (cache[1].keys, cache[1].values))``
   graph-size guard is skipped on shared layers (their ``cache[1]`` is
   never populated — ``keys`` stays ``None``).

The Indexer math (rope on the first ``qk_rope_head_dim`` of
``head_dim``, interleaved; per-head q·k → relu → weight → sum over
heads → topk) is identical to DeepSeek V3.2's ``Indexer``, which itself
matches the GLM-5.2 reference (``indexer_rope_interleave=True`` ==
``traditional=True``). So the existing ``Indexer`` is reused unchanged.

MTP (``num_nextn_predict_layers=1``, ``index_share_for_mtp_iteration``)
is disabled for GLM-5.2 — the checkpoint ships no ``mtp.*`` weights, so
MTP attachment would break strict load. MTP stays off via omlx model
settings (``mtp_enabled=False``); no MTPModule is instantiated.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import mlx.core as mx
import mlx.nn as nn

from .activations import swiglu
from .base import create_attention_mask, scaled_dot_product_attention
from .cache import CacheList, KVCache
from .deepseek_v32 import (
    DeepseekV32DecoderLayer,
    DeepseekV32MLP,
    DeepseekV32MoE,
    DeepseekV32Model,
    Indexer,
    Model as DSV32Model,
    ModelArgs as DSV32Args,
)
from .mla import MultiLinear
from .rope_utils import initialize_rope
from .switch_layers import SwitchGLU


@dataclass
class ModelArgs(DSV32Args):
    """GLM-5.2 config fields, layered on top of DeepSeek V3.2 args.

    All added fields default so ``BaseModelArgs.from_dict`` happily
    constructs this for GLM-5.1 (which lacks them) too.
    """

    # IndexShare DSA ---------------------------------------------------------
    indexer_types: Optional[List[str]] = None
    indexer_rope_interleave: bool = False
    index_share_for_mtp_iteration: bool = False
    index_skip_topk_offset: int = 0
    index_topk_freq: int = 1
    index_topk_pattern: Optional[str] = None
    # Misc GLM-5.2 fields the stock class does not capture ---------------
    num_nextn_predict_layers: int = 0
    head_dim: Optional[int] = None
    qk_head_dim: Optional[int] = None
    ep_size: int = 1
    mlp_layer_types: Optional[List[str]] = None


def _is_full_indexer_layer(config: ModelArgs, layer_idx: int) -> bool:
    """True iff this layer carries its own indexer weights (GLM-5.2 "full")."""
    types = getattr(config, "indexer_types", None)
    if not types:
        # No indexer_types → stock GLM-5.1 behaviour: every layer is "full".
        return True
    if layer_idx >= len(types):
        return False
    return types[layer_idx] == "full"


def _next_is_shared(config: ModelArgs, layer_idx: int) -> bool:
    """True iff the next layer is a shared (indexer-less) layer.

    Mirrors ``next_skip_topk`` in the transformers reference: a full
    layer that is followed by a shared layer must return its
    ``topk_indices`` so the shared layer can reuse it.
    """
    types = getattr(config, "indexer_types", None)
    if not types:
        return False
    if layer_idx + 1 >= len(types):
        return False
    return types[layer_idx + 1] == "shared"


class Glm52Attention(nn.Module):
    """DeepseekV32Attention with IndexShare (conditional indexer + top-k threading)."""

    def __init__(self, config: ModelArgs, layer_idx: int):
        super().__init__()
        self.layer_idx = layer_idx
        self.config = config
        self.hidden_size = config.hidden_size
        self.num_heads = config.num_attention_heads
        self.max_position_embeddings = config.max_position_embeddings
        self.rope_theta = config.rope_theta
        self.q_lora_rank = config.q_lora_rank
        self.qk_rope_head_dim = config.qk_rope_head_dim
        self.kv_lora_rank = config.kv_lora_rank
        self.v_head_dim = config.v_head_dim
        self.qk_nope_head_dim = config.qk_nope_head_dim
        self.q_head_dim = config.qk_nope_head_dim + config.qk_rope_head_dim

        self.scale = self.q_head_dim**-0.5

        self.q_a_proj = nn.Linear(
            self.hidden_size, self.q_lora_rank, bias=config.attention_bias
        )
        self.q_a_layernorm = nn.RMSNorm(self.q_lora_rank, eps=1e-6)
        self.q_b_proj = nn.Linear(
            self.q_lora_rank, self.num_heads * self.q_head_dim, bias=False
        )

        self.kv_a_proj_with_mqa = nn.Linear(
            self.hidden_size,
            self.kv_lora_rank + self.qk_rope_head_dim,
            bias=config.attention_bias,
        )
        self.kv_a_layernorm = nn.RMSNorm(self.kv_lora_rank, eps=1e-6)
        self.embed_q = MultiLinear(
            self.qk_nope_head_dim, self.kv_lora_rank, self.num_heads
        )
        self.unembed_out = MultiLinear(
            self.kv_lora_rank, self.v_head_dim, self.num_heads
        )

        self.o_proj = nn.Linear(
            self.num_heads * self.v_head_dim,
            self.hidden_size,
            bias=config.attention_bias,
        )

        if self.config.rope_scaling is not None:
            mscale_all_dim = self.config.rope_scaling.get("mscale_all_dim", 0)
            if mscale_all_dim:
                scaling_factor = self.config.rope_scaling["factor"]
                if scaling_factor > 1:
                    s = 0.1 * mscale_all_dim * math.log(scaling_factor) + 1.0
                    self.scale = self.scale * s * s

        # IndexShare: only "full" layers (21 of 78) carry an indexer.
        # Shared layers set self.indexer = None → no indexer params defined,
        # matching a checkpoint that ships indexer weights for full layers
        # only. A full layer followed by a shared layer must hand its
        # topk_indices to the next layer (next_skip_topk).
        self.is_full = _is_full_indexer_layer(config, layer_idx)
        self.next_skip_topk = _next_is_shared(config, layer_idx)
        if self.is_full:
            self.indexer = Indexer(config)
        else:
            self.indexer = None

        self.rope = initialize_rope(
            dims=self.qk_rope_head_dim,
            base=self.rope_theta,
            traditional=True,
            max_position_embeddings=self.max_position_embeddings,
            scaling_config=self.config.rope_scaling,
        )

    def __call__(
        self,
        x: mx.array,
        mask: Optional[mx.array] = None,
        cache: Optional[Any] = None,
        prev_topk_indices: Optional[mx.array] = None,
    ) -> Tuple[mx.array, Optional[mx.array]]:
        B, L, D = x.shape

        qr = self.q_a_layernorm(self.q_a_proj(x))
        q = self.q_b_proj(qr)

        q = q.reshape(B, L, self.num_heads, self.q_head_dim).transpose(0, 2, 1, 3)
        q_nope, q_pe = mx.split(q, [self.qk_nope_head_dim], axis=-1)
        compressed_kv = self.kv_a_proj_with_mqa(x)
        compressed_kv, k_pe = mx.split(compressed_kv, [self.kv_lora_rank], axis=-1)
        k_pe = k_pe.reshape(B, L, 1, self.qk_rope_head_dim).transpose(0, 2, 1, 3)
        kv_latent = self.kv_a_layernorm(compressed_kv)

        offset = cache[0].offset if cache is not None else 0
        q_pe = self.rope(q_pe, offset)
        k_pe = self.rope(k_pe, offset)

        kv_latent = mx.expand_dims(kv_latent, axis=1)

        if cache is not None:
            kv_latent, k_pe = cache[0].update_and_fetch(kv_latent, k_pe)
        else:
            cache = [None] * 2

        # IndexShare top-k selection:
        # - full layer: compute fresh topk via the indexer (also populates
        #   cache[1] via update_and_fetch, which the depends guard below
        #   relies on).
        # - shared layer: reuse the preceding full layer's prev_topk_indices
        #   (no indexer call). BUT omlx's scheduler reads ``cache[1].state``
        #   for SSD/prefix-cache management, and a fresh KVCache has
        #   ``keys=None`` → ``.state`` raises 'NoneType has no shape' →
        #   the scheduler flags "cache corruption" and re-prefills forever
        #   (no tokens ever emit). Prime slot 1 with a zero-length update so
        #   its state is well-formed (keys.shape=(B,H,0,D)); the attention
        #   math is unaffected (topk_indices=None → dense attention).
        # - fallback (shared with no prev, e.g. layer 0 being shared — does
        #   not occur for GLM-5.2 since layer 0 is full): dense attention.
        if self.is_full:
            topk_indices = self.indexer(x, qr, mask, cache=cache[1])
        else:
            if (
                cache is not None
                and cache[1] is not None
                and getattr(cache[1], "keys", None) is None
            ):
                # Zero-length prime: B,H,0,D matching indexer key shape.
                _b = x.shape[0]
                cache[1].update_and_fetch(
                    mx.zeros((_b, 1, 0, self.config.index_head_dim), dtype=x.dtype),
                    mx.zeros((_b, 1, 0, 0), dtype=x.dtype),
                )
            topk_indices = prev_topk_indices

        if topk_indices is not None:
            if L == 1:
                idx = topk_indices[:, :, 0, :, None]
                kv_latent = mx.take_along_axis(
                    kv_latent,
                    mx.broadcast_to(idx, idx.shape[:-1] + (kv_latent.shape[-1],)),
                    axis=2,
                )
                k_pe = mx.take_along_axis(
                    k_pe,
                    mx.broadcast_to(idx, idx.shape[:-1] + (k_pe.shape[-1],)),
                    axis=2,
                )
                if mask is not None:
                    mask = mx.take_along_axis(mask, topk_indices, axis=-1)
            else:
                shape = list(topk_indices.shape)
                shape[-1] = kv_latent.shape[2]
                sparse_mask = mx.zeros(shape, dtype=mx.bool_)
                sparse_mask = mx.put_along_axis(
                    sparse_mask, topk_indices, mx.array(True), axis=-1
                )
                if mask is not None:
                    sparse_mask = sparse_mask & mask
                mask = sparse_mask

        # Ensure the indexer cache is evaluated even if the topk_indices
        # are unused, to keep the graph from getting too large. Only
        # meaningful for full layers: shared layers have no indexer and
        # cache[1] is primed to zero-length above (keys is a 0-len array,
        # not None, so the depends guard is safe but unneeded).
        if (
            self.is_full
            and cache is not None
            and cache[0] is not None
            and cache[1] is not None
            and getattr(cache[1], "keys", None) is not None
        ):
            cache[0].keys = mx.depends(cache[0].keys, (cache[1].keys, cache[1].values))

        pe_scores = (q_pe * self.scale) @ k_pe.swapaxes(-1, -2)
        if mask is not None:
            pe_scores = mx.where(
                mask,
                pe_scores,
                mx.array(mx.finfo(pe_scores.dtype).min, pe_scores.dtype),
            )

        if L == 1:
            q_nope = self.embed_q(q_nope)
            k = v = kv_latent
        else:
            k = self.embed_q(kv_latent, transpose=False)
            v = self.unembed_out(kv_latent)

        output = scaled_dot_product_attention(
            q_nope, k, v, cache=cache, scale=self.scale, mask=pe_scores
        )
        if L == 1:
            output = self.unembed_out(output)

        output = output.transpose(0, 2, 1, 3).reshape(B, L, -1)
        # Hand topk_indices to the next layer iff it is shared.
        return self.o_proj(output), (
            topk_indices if self.next_skip_topk else None
        )


class Glm52DecoderLayer(DeepseekV32DecoderLayer):
    """Decoder layer that wires ``layer_idx`` into the IndexShare attention
    and threads ``prev_topk_indices`` through the residual block."""

    def __init__(self, config: ModelArgs, layer_idx: int):
        # Bypass DeepseekV32DecoderLayer.__init__ (which would build a
        # stock DeepseekV32Attention with an unconditional indexer) and
        # construct directly. Inherits nothing stateful from super.
        nn.Module.__init__(self)
        self.self_attn = Glm52Attention(config, layer_idx)
        self.mlp = (
            DeepseekV32MoE(config)
            if (
                config.n_routed_experts is not None
                and layer_idx >= config.first_k_dense_replace
                and layer_idx % config.moe_layer_freq == 0
            )
            else DeepseekV32MLP(config)
        )
        self.input_layernorm = nn.RMSNorm(config.hidden_size, eps=config.rms_norm_eps)
        self.post_attention_layernorm = nn.RMSNorm(
            config.hidden_size, eps=config.rms_norm_eps
        )

    def __call__(
        self,
        x: mx.array,
        mask: Optional[mx.array] = None,
        cache: Optional[Any] = None,
        prev_topk_indices: Optional[mx.array] = None,
    ) -> Tuple[mx.array, Optional[mx.array]]:
        r, topk_indices = self.self_attn(
            self.input_layernorm(x), mask, cache, prev_topk_indices
        )
        h = x + r
        r = self.mlp(self.post_attention_layernorm(h))
        return h + r, topk_indices


class Glm52Model(DeepseekV32Model):
    """DeepseekV32Model body using IndexShare-aware decoder layers."""

    def __init__(self, config: ModelArgs):
        # Bypass DeepseekV32Model.__init__ (which builds stock
        # DeepseekV32DecoderLayer layers) and construct directly so no
        # throwaway indexers are allocated. Inherits pipeline().
        nn.Module.__init__(self)
        self.vocab_size = config.vocab_size
        self.embed_tokens = nn.Embedding(config.vocab_size, config.hidden_size)
        self.layers = [
            Glm52DecoderLayer(config, idx) for idx in range(config.num_hidden_layers)
        ]
        self.start_idx = 0
        self.end_idx = len(self.layers)
        self.num_layers = self.end_idx

        self.norm = nn.RMSNorm(config.hidden_size, eps=config.rms_norm_eps)
        self.pipeline_rank = 0
        self.pipeline_size = 1

    def __call__(self, x: mx.array, cache: Optional[Any] = None) -> mx.array:
        h = self.embed_tokens(x)

        if cache is None:
            cache = [None] * self.num_layers
        mask = create_attention_mask(
            h, cache[0][0] if cache[0] else None, return_array=True
        )

        # IndexShare: thread topk_indices from full layers to the shared
        # layers that follow them. ``topk_indices`` is None except when the
        # previous layer was a full layer followed by a shared one.
        topk_indices = None
        for i in range(self.num_layers):
            h, topk_indices = self.layers[self.start_idx + i](
                h, mask, cache[i], prev_topk_indices=topk_indices
            )

        return self.norm(h)


class Model(DSV32Model):
    """Top-level GLM-5.2 causal LM model (IndexShare-aware)."""

    def __init__(self, config: ModelArgs):
        # Bypass DSV32Model.__init__ (which builds a stock
        # DeepseekV32Model body) and construct directly. Inherits
        # sanitize / shard / layers / cast_predicate / make_cache — all of
        # which are correct for a pre-converted MLX GLM-5.2 checkpoint
        # (sanitize is effectively identity: switch_mlp already stacked,
        # embed_q/unembed_out already split, no fp8 scale_inv, no MTP keys).
        nn.Module.__init__(self)
        self.args = config
        self.model_type = config.model_type
        self.model = Glm52Model(config)
        self.lm_head = nn.Linear(config.hidden_size, config.vocab_size, bias=False)
