"""Times each step of precise auto-sync on a 4-minute song (CI only)."""
import os, sys, time
t0 = time.time()
import numpy as np, torch, torchaudio
sys.path.insert(0, os.path.dirname(__file__))
import align
print(f"import {time.time()-t0:.1f}s  threads default={torch.get_num_threads()} cpu_count={os.cpu_count()}", flush=True)
sr = 44100; dur = 240
t = np.arange(dur * sr) / sr
x = (0.2 * np.sin(2*np.pi*220*t) + 0.1*np.sin(2*np.pi*330*t) + 0.05*np.random.randn(len(t))).astype(np.float32)
wav = torch.from_numpy(np.stack([x, x]))
mode = sys.argv[1] if len(sys.argv) > 1 else "default"
if mode == "logical":
    torch.set_num_threads(os.cpu_count())
print("threads used", torch.get_num_threads(), flush=True)
for ov in (0.25, 0.1):
    a = time.time()
    v, vsr = align.separate_vocals(wav, sr, lambda f: None) if ov == 0.25 else (None, None)
    if ov == 0.25:
        print(f"demucs overlap 0.25: {time.time()-a:.1f}s", flush=True)
a = time.time()
v16 = torchaudio.functional.resample(v, vsr, 16000)
bundle, model = align.load_model(os.environ.get("MMS_DIR", "/tmp/mms"), lambda s: None)
print(f"load mms {time.time()-a:.1f}s", flush=True)
a = time.time()
em, spf = align.emissions(model, v16, lambda f: None)
print(f"emissions {time.time()-a:.1f}s", flush=True)
