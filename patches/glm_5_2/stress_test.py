#!/usr/bin/env python3
"""Milestone-5 stress: long-context + multi-turn degradation probe.

The DeepSeek V4 precedent: "worked a bit but got jumbled mess after a bit"
— a session-length cache corruption bug. This test:
1. Builds a long context (a numbered list 1-40) and asks the model to
   recall a specific item — probes KV cache correctness over length.
2. Runs 4 sequential turns in ONE conversation (cache reused) and checks
   each stays coherent — probes multi-turn cache reuse.

Compares local vs cloud. Any divergence or incoherence = flag.
"""
import json
import sys
import time
import urllib.request

LOCAL = ("http://localhost:9110/v1/chat/completions", "GLM-5.2-mxfp4")
CLOUD = ("http://localhost:9111/v1/chat/completions", "glm-5.2-zai")
KEY = "omlx"

def call(url, model, messages, max_tokens=64):
    body = json.dumps({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0,
        "stream": False,
        "chat_template_kwargs": {"enable_thinking": False},
    }).encode()
    req = urllib.request.Request(url, data=body, headers={
        "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            d = json.loads(r.read())
        return {"ok": True, "content": (d["choices"][0]["message"].get("content") or ""),
                "dt": time.time()-t0}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "dt": time.time()-t0}

# --- Test 1: long-context recall ---
# 40 numbered facts; ask for fact #23.
facts = [f"Fact {i}: The code for item {i} is {1000+i}." for i in range(1, 41)]
long_prompt = "Here are 40 facts:\n" + "\n".join(facts) + "\n\nWhat is the code for item 23? Answer with just the number."

print("=== TEST 1: long-context recall (40 facts, ask for #23, expect 1023) ===")
for label, (url, model) in (("local", LOCAL), ("cloud", CLOUD)):
    r = call(url, model, [{"role": "user", "content": long_prompt}], max_tokens=16)
    c = r.get("content","").replace("\n"," ").strip() if r["ok"] else r["error"]
    ok = r["ok"] and "1023" in r.get("content","")
    print(f"  {label:<6} ({r['dt']:.1f}s): {c[:50]!r}  {'PASS' if ok else 'FAIL/FLAG'}")

# --- Test 2: multi-turn coherence (4 turns, cache reused server-side) ---
print("\n=== TEST 2: multi-turn coherence (4 sequential turns) ===")
turns = [
    "My name is Alice and I work as a doctor. Remember this.",
    "What is my name?",
    "What is my profession?",
    "Combine: state my name and profession in one sentence.",
]
for label, (url, model) in (("local", LOCAL), ("cloud", CLOUD)):
    print(f"  --- {label} ---")
    history = []
    coherent = True
    for i, user in enumerate(turns):
        history.append({"role": "user", "content": user})
        r = call(url, model, history, max_tokens=48)
        if not r["ok"]:
            print(f"    turn {i+1}: ERR {r['error'][:50]}"); coherent = False; break
        c = r["content"].replace("\n"," ").strip()
        print(f"    turn {i+1} ({r['dt']:.1f}s): {c[:70]!r}")
        history.append({"role": "assistant", "content": r["content"]})
        # sanity checks
        if i == 1 and "alice" not in c.lower(): coherent = False
        if i == 2 and "doctor" not in c.lower(): coherent = False
        if i == 3 and ("alice" not in c.lower() or "doctor" not in c.lower()): coherent = False
    print(f"  {label}: {'COHERENT' if coherent else 'INCOHERENT — FLAG'}")
