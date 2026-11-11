"""Karaoke System separation engine (Demucs, two stems: vocals / playback).

Usage:
  ks-separate INPUT.wav OUTDIR [-n htdemucs_ft|htdemucs]
  ks-separate --warmup            (downloads the models into $TORCH_HOME)
  ks-separate --selftest          (separates 3 s of noise with htdemucs)

Prints machine-readable lines on stdout:
  M <number of models>
  P <model index> <done> <total>
  DONE
  ERR <message>
"""
import argparse
import os
import sys
import traceback


def out(line):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


class _Tqdm:
    idx = 0

    def __init__(self, iterable=None, **_):
        self.items = list(iterable or [])
        _Tqdm.idx += 1

    def __iter__(self):
        n = len(self.items)
        for i, x in enumerate(self.items):
            yield x
            out(f"P {_Tqdm.idx} {i + 1} {n}")


class _TqdmModule:
    tqdm = _Tqdm


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input", nargs="?")
    ap.add_argument("outdir", nargs="?")
    ap.add_argument("-n", "--name", default="htdemucs_ft")
    ap.add_argument("--warmup", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()

    import numpy as np
    try:  # model checkpoints pickle numpy.core.multiarray; make sure the bundler includes it
        import numpy.core.multiarray  # noqa: F401
    except Exception:
        pass
    import soundfile as sf
    import torch
    from demucs.pretrained import get_model
    from demucs.apply import apply_model, BagOfModels
    import demucs.apply as DA

    torch.set_num_threads(max(1, os.cpu_count() or 1))

    if a.warmup:
        for name in ("htdemucs_ft", "htdemucs"):
            get_model(name)
            out(f"OK {name}")
        out("DONE")
        return

    if a.selftest:
        import tempfile
        d = tempfile.mkdtemp()
        a.input = os.path.join(d, "t.wav")
        sf.write(a.input, (np.random.randn(44100 * 3, 2) * 0.1).astype("float32"), 44100)
        a.outdir = d
        a.name = "htdemucs"

    if not a.input or not a.outdir:
        ap.error("input and outdir are required")

    DA.tqdm = _TqdmModule  # progress lines instead of a tqdm bar
    model = get_model(a.name)
    model.eval()
    n_models = len(model.models) if isinstance(model, BagOfModels) else 1
    out(f"M {n_models}")

    data, sr = sf.read(a.input, dtype="float32", always_2d=True)
    wav = torch.from_numpy(np.ascontiguousarray(data.T))
    if wav.shape[0] == 1:
        wav = wav.repeat(2, 1)
    wav = wav[:2]
    msr = model.samplerate
    if sr != msr:
        import julius
        wav = julius.resample_frac(wav, sr, msr)

    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    with torch.no_grad():
        res = apply_model(model, ((wav - mean) / std)[None], shifts=1, split=True, overlap=0.25,
                          progress=True, device="cpu", num_workers=0)[0]
    res = res * std + mean
    vi = list(model.sources).index("vocals")
    vocals = res[vi]
    playback = res.sum(0) - vocals
    if sr != msr:
        import julius
        vocals = julius.resample_frac(vocals, msr, sr)
        playback = julius.resample_frac(playback, msr, sr)

    os.makedirs(a.outdir, exist_ok=True)
    for nm, x in (("vocals", vocals), ("no_vocals", playback)):
        sf.write(os.path.join(a.outdir, nm + ".wav"), x.clamp(-1, 1).T.numpy(), sr, subtype="PCM_16")
    out("DONE")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        out("ERR " + (str(e) or e.__class__.__name__).replace("\n", " ")[:400])
        traceback.print_exc()
        sys.exit(1)
