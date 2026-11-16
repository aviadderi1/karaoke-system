"""CI check for precise auto-sync: the sample sentence repeated 8 times over synthetic music.
Every repetition must be found at the right place, across the 20 s analysis windows."""
import json, subprocess, sys, os
import numpy as np, soundfile as sf, torch, torchaudio
from torchaudio.utils import download_asset
p = download_asset("tutorial-assets/Lab41-SRI-VOiCES-src-sp0307-ch127535-sg0042.wav")
w, sr = torchaudio.load(p); w = torchaudio.functional.resample(w, sr, 44100)[0].numpy(); sr = 44100
gap = 1.5; rep = 8; seg = len(w) / sr + gap
intro = 25.0  # instrumental intro: no singing (exercises the silent-window skip)
song = np.zeros(int((intro + seg * rep) * sr) + sr, dtype=np.float32)
for k in range(rep):
    a = int((intro + k * seg) * sr); song[a:a + len(w)] += w * 0.9
t = np.arange(len(song)) / sr
music = 0.12 * (np.sin(2 * np.pi * 110 * t) + 0.6 * np.sin(2 * np.pi * 164.8 * t) + 0.5 * np.sin(2 * np.pi * 220 * t))
beat = (np.mod(t, 0.5) < 0.05) * np.random.randn(len(t)) * 0.25
mix = np.stack([song + music + beat, song + music * 0.9 + beat], 1).astype(np.float32)
sf.write("bench.wav", mix / np.abs(mix).max() * 0.9, sr)
words = ("i had that curiosity beside me at this moment " * rep).split()
lines = [i // 9 for i in range(len(words))]
json.dump({"words": words, "lines": lines}, open("bench.json", "w"))
exe = sys.argv[1:] or [sys.executable, "sep_cli.py"]
r = subprocess.run(exe + ["--align", "bench.wav", "--lyrics", "bench.json", "--out", "bench_out.json", "--models", os.environ.get("MMS_DIR", "/tmp/mms")])
assert r.returncode == 0, "engine failed"
res = json.load(open("bench_out.json"))["words"]
errs = []
for k in range(rep):
    cur = res[k * 9 + 3]
    exp = intro + k * seg + 1.086
    errs.append(abs(cur["s"] - exp))
    print(f"rep {k}: curiosity at {cur['s']:.3f} (expected {exp:.3f}) end {cur['e']:.3f} voiced {cur.get('v')} conf {cur['c']}")
print("max start error %.3f s, mean %.3f s" % (max(errs), sum(errs) / len(errs)))
assert max(errs) < 0.12, "timing is off"
print("BENCH OK")
