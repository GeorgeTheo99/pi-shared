#!/usr/bin/env python3
"""Milestone-5 correctness diff: local GLM-5.2-mxfp4 vs cloud glm-5.2-zai.

Sends identical fixed prompts to both routes (thinking OFF for a clean
apples-to-apples content comparison) and diffs the outputs. Watches for
the DeepSeek-V4-style "plausible but subtly wrong" failure mode.

Local:  omlx :9110, model GLM-5.2-mxfp4, key 'omlx'
Cloud:  cloud-gateway :9111, model glm-5.2-zai, key 'omlx'
"""
import json
import sys
import time
import urllib.request

LOCAL = ("http://localhost:9110/v1/chat/completions", "GLM-5.2-mxfp4")
CLOUD = ("http://localhost:9111/v1/chat/completions", "glm-5.2-zai")
KEY = "omlx"

# Fixed prompts: factual (easy to verify correctness), math, reasoning.
PROMPTS = [
    ("factual-capitals", "What is the capital of Australia? Answer with just the city name."),
    ("math", "What is 17 * 23? Answer with just the number."),
    ("reasoning", "If I have 3 apples and eat 1, then buy 2 more, how many do I have? Answer with just the number."),
    ("factual-element", "What is the chemical symbol for gold? Answer with just the symbol."),
]

def call(url, model, prompt, max_tokens=64):
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0,
        "stream": False,
        # disable thinking for clean content comparison
        "chat_template_kwargs": {"enable_thinking": False},
    }).encode()
    req = urllib.request.Request(url, data=body, headers={
        "Authorization": f"Bearer {KEY}",
        "Content-Type": "application/json",
    })
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            d = json.loads(r.read())
        dt = time.time() - t0
        msg = d["choices"][0]["message"]
        content = msg.get("content") or ""
        reasoning = msg.get("reasoning_content") or ""
        usage = d.get("usage", {})
        return {"ok": True, "content": content, "reasoning": reasoning,
                "dt": dt, "usage": usage}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "dt": time.time()-t0}

print(f"{'PROMPT':<22} {'ROUTE':<6} {'TIME':>7} {'TOKENS':>7}  CONTENT")
print("-" * 100)
results = {}
for name, prompt in PROMPTS:
    results[name] = {}
    for label, (url, model) in (("local", LOCAL), ("cloud", CLOUD)):
        r = call(url, model, prompt)
        results[name][label] = r
        if r["ok"]:
            toks = r["usage"].get("completion_tokens", "?")
            c = r["content"].replace("\n", " ")[:45]
            print(f"{name:<22} {label:<6} {r['dt']:>6.1f}s {str(toks):>7}  {c}")
        else:
            print(f"{name:<22} {label:<6} {'ERR':>7}  {r['error'][:60]}")
        sys.stdout.flush()

# Summary: do local and cloud agree?
print("\n" + "=" * 100)
print("AGREEMENT CHECK (content match, ignoring whitespace):")
all_agree = True
for name in results:
    lc = results[name].get("local", {})
    cc = results[name].get("cloud", {})
    if not lc.get("ok") or not cc.get("ok"):
        print(f"  {name}: SKIP (one side failed)")
        continue
    la = " ".join(lc["content"].split()).lower().strip(" .!")
    ca = " ".join(cc["content"].split()).lower().strip(" .!")
    agree = la == ca
    if not agree:
        all_agree = False
    print(f"  {name}: {'MATCH' if agree else 'DIFFER'}")
    if not agree:
        print(f"    local: {lc['content'][:80]!r}")
        print(f"    cloud: {cc['content'][:80]!r}")

print(f"\nOverall: {'ALL MATCH — local GLM-5.2 correctness confirmed' if all_agree else 'DIFFERENCES FOUND — investigate'}")
