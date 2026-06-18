#!/usr/bin/env python3
"""Long-context regression test for GLM-5.2-mxfp4 (the bug the short-context
tests in this dir missed). Run with oMLX STOPPED (frees 386GB):

    launchctl bootout gui/$(id -u)/com.local.claude-proxy
    ~/.local/share/uv/tools/omlx/bin/python \\
        ~/local_code/pi-shared/patches/glm_5_2/long_context_test.py
    launchctl bootstrap gui/$(id -u) \\
        ~/Library/LaunchAgents/com.local.claude-proxy.plist

KNOWN BUG (2026-06-18): GLM-5.2-mxfp4 emits gibberish (echoes prompt tokens)
at ~5-7K+ token context. Monotonic in length, in prefill (last prompt token
already wrong). Reproduces in DIRECT mlx_lm.generate (oMLX stopped) → bug is
in patch/model/MLX, NOT oMLX serving.

Ruled out:
  - IndexShare sparse topk path (forced dense still fails)
  - SSD/prefix cache (cache.enabled=false still fails)
  - chunked prefill (prefill_step_size=1M true single-chunk still fails)
  - rope_theta (vanilla 10000; same as transformers ref; within good range)
  - oMLX serving layer (direct mlx_lm reproduces)

Remaining suspects: mxfp4 quant at long context; a config field the MLX
conversion lost; MLX kernel at GLM-5.2 MLA dims (head_dim 192, qk_nope 192,
qk_rope 64, v 256, kv_lora 512). The patch's MLA core is line-for-line
identical to stock mlx_lm DeepseekV32Attention (works at 128K for DS V3).
"""
import sys, time, random
from omlx.patches.glm_5_2 import apply_glm_5_2_patch
assert apply_glm_5_2_patch(), "patch did not apply"
import mlx.core as mx
import mlx_lm

MODEL = "/Users/localserver99/models/mlx/GLM-5.2-mxfp4"


def greedy(logits):
    return mx.argmax(logits, -1)


def main():
    print("[load] loading model...", flush=True)
    t0 = time.time()
    model, tokenizer = mlx_lm.load(MODEL)
    print(f"[load] {time.time()-t0:.1f}s\n", flush=True)

    # (n_lines, label, seed). ~9 tok/line + template overhead.
    cases = [
        (120, "~2k", 2),
        (240, "~4k", 3),
        (360, "~6k", 4),
        (480, "~8k", 5),
    ]
    fails = 0
    for nl, lab, seed in cases:
        rand = random.Random(seed)
        lines = [f"Item {i}: salt {rand.randint(0,999999)} code {rand.randint(0,999999)} node {seed}."
                 for i in range(nl)]
        sp = f"SEED{seed}x{rand.randint(0,10**9)}\n" + "\n".join(lines) + "\nAnswer with just the number."
        msgs = [{"role": "system", "content": sp}, {"role": "user", "content": "What is 2+2?"}]
        prompt = tokenizer.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
        pt = len(tokenizer.encode(prompt))
        t0 = time.time()
        out = mlx_lm.generate(model, tokenizer, prompt=prompt, max_tokens=8,
                              sampler=greedy, prefill_step_size=2048, verbose=False)
        bad = any(w in out.lower() for w in ["code", "salt", "node", "item"])
        ok = ("4" in out[:12]) and not bad
        if not ok:
            fails += 1
        print(f"  {lab:<5} {pt:>5}tok {time.time()-t0:5.1f}s: {out[:38]!r} {'OK' if ok else 'FAIL'}", flush=True)

    print(f"\n[result] {fails} failure(s) of {len(cases)}")
    # Expect 0 failures once fixed. Currently fails at ~6k+.
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
