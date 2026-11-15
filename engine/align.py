"""Precise word timing for Karaoke Lab: CTC forced alignment of the known lyrics.

The lyrics are already known, so instead of transcribing the song we only ask
*where* each word is sung. Steps:
  1. take the vocals out of the mix with Demucs (unless the input already is a vocal stem)
  2. compute frame-level character probabilities with the multilingual MMS forced-alignment
     model (torchaudio.pipelines.MMS_FA, 1100+ languages, 20 ms frames)
  3. run a Viterbi forced alignment of the lyric characters over the whole song.
     A wildcard token between lines absorbs ad-libs and backing vocals that aren't in the lyrics.
Non-Latin lyrics (Hebrew, Arabic, Russian...) are romanized with uroman, which is what MMS was trained on.

Input  --lyrics: {"words": ["Here", "comes", ...], "lines": [0, 0, ...], "lang": "en"}
Output --out:    {"words": [{"s": 12.34, "e": 12.71, "c": 0.93} | null, ...], "duration": 215.2}
Progress on stdout: "S <message>" and "Q <fraction 0..1>", then "DONE" or "ERR <message>".
"""
import json
import os
import re
import sys

SR = 16000
STAR = "*"


class _Bar:
    """Stand-in for tqdm used by torch.hub downloads and Demucs: prints progress lines instead."""
    cb = None

    def __init__(self, iterable=None, total=None, **_):
        self.items = iterable
        self.total = total or (len(iterable) if iterable is not None and hasattr(iterable, "__len__") else 0)
        self.n = 0

    def __iter__(self):
        for x in self.items:
            yield x
            self.update(1)

    def update(self, k=1):
        self.n += k
        if _Bar.cb and self.total:
            _Bar.cb(min(1.0, self.n / self.total))

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def close(self):
        pass

    def set_description(self, *a, **k):
        pass


class _BarModule:
    tqdm = _Bar


def normalize_words(words, lang):
    """Lyric words -> lowercase a-z/' strings the MMS model knows; '' for words that can't be aligned."""
    needs_roman = any(re.search(r"[^\x00-\x7F]", w) for w in words)
    ur = None
    if needs_roman:
        try:
            import uroman
            ur = uroman.Uroman()
        except Exception:
            ur = None
    out = []
    for w in words:
        t = w
        if ur is not None and re.search(r"[^\x00-\x7F]", t):
            try:
                t = ur.romanize_string(t)
            except Exception:
                pass
        t = t.lower().replace("’", "'")
        t = re.sub(r"[^a-z']", "", t)
        out.append(t.strip("'"))
    return out


def separate_vocals(wav, sr, progress):
    """wav: torch [C, N] float32 -> mono vocal stem at `sr`."""
    import torch
    from demucs.pretrained import get_model
    from demucs.apply import apply_model
    import demucs.apply as DA
    DA.tqdm = _BarModule
    _Bar.cb = lambda f: progress(f)
    model = get_model("htdemucs")
    model.eval()
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
    voc = res[list(model.sources).index("vocals")].mean(0, keepdim=True)
    _Bar.cb = None
    return voc, msr


def load_model(models_dir, out):
    import torch
    import torch.hub as hub
    import torchaudio
    bundle = torchaudio.pipelines.MMS_FA
    hub.tqdm = _Bar  # download progress
    _Bar.cb = lambda f: out(f"S Downloading the timing model (once) {int(f * 100)}%")
    kw = {"dl_kwargs": {"model_dir": models_dir, "progress": True}} if models_dir else {}
    try:
        model = bundle.get_model(with_star=True, **kw)
    finally:
        _Bar.cb = None
    model.eval()
    return bundle, model


def emissions(model, wave, progress):
    """Frame log-probabilities for the whole song, computed in overlapping windows."""
    import torch
    n = wave.shape[1]
    win, ctx = 20 * SR, 2 * SR
    hop_frames = None
    parts = []
    starts = list(range(0, n, win)) or [0]
    with torch.inference_mode():
        for k, s in enumerate(starts):
            a, b = max(0, s - ctx), min(n, s + win + ctx)
            em, _ = model(wave[:, a:b])
            em = em[0]
            ratio = (b - a) / em.shape[0]  # samples per frame (~320)
            f0 = int(round((s - a) / ratio))
            f1 = int(round((min(n, s + win) - a) / ratio))
            parts.append(em[f0:f1])
            progress((k + 1) / len(starts))
    em = torch.cat(parts, 0)
    return em, n / em.shape[0]


def align(words, lines, model, bundle, wave, out, progress):
    import torch
    norm = normalize_words(words, None)
    dic = bundle.get_dict(star=STAR)
    em, spf = emissions(model, wave, lambda f: progress(0.05 + 0.75 * f))
    # transcript: * line1 words * line2 words * ...  (stars soak up ad-libs between lines)
    seq, owner = [], []
    prev_line = None
    seq.append([dic[STAR]]); owner.append(-1)
    for i, w in enumerate(norm):
        toks = [dic[c] for c in w if c in dic]
        if not toks:
            continue
        if prev_line is not None and lines[i] != prev_line:
            seq.append([dic[STAR]]); owner.append(-1)
        prev_line = lines[i]
        seq.append(toks); owner.append(i)
    seq.append([dic[STAR]]); owner.append(-1)
    total = sum(len(t) for t in seq)
    if total == 0:
        raise RuntimeError("None of the lyrics could be read by the timing model.")
    if total > em.shape[0]:
        raise RuntimeError("The lyrics are longer than the song allows. Check that the right lyrics are loaded.")
    out("S Matching the lyrics to the singing")
    aligner = bundle.get_aligner()
    spans = aligner(em, seq)
    progress(0.95)
    res = [None] * len(words)
    for sp, i in zip(spans, owner):
        if i < 0 or not sp:
            continue
        s = sp[0].start * spf / SR
        e = sp[-1].end * spf / SR
        c = float(sum(t.score for t in sp) / len(sp))
        res[i] = {"s": round(s, 3), "e": round(e, 3), "c": round(c, 3)}
    return res


def run(a, out):
    import numpy as np
    try:
        import numpy.core.multiarray  # noqa: F401
    except Exception:
        pass
    import soundfile as sf
    import torch
    import torchaudio
    torch.set_num_threads(max(1, os.cpu_count() or 1))

    if a.align_selftest:
        return selftest(a, out)

    with open(a.lyrics, "r", encoding="utf-8") as f:
        L = json.load(f)
    words, lines = L["words"], L.get("lines") or [0] * len(L["words"])
    sep_share = 0.0 if a.vocals else 0.45
    prog = lambda f: out(f"Q {f:.4f}")

    data, sr = sf.read(a.align, dtype="float32", always_2d=True)
    wav = torch.from_numpy(np.ascontiguousarray(data.T))
    duration = wav.shape[1] / sr
    if not a.vocals:
        out("S Separating the vocals from the music")
        wav, sr = separate_vocals(wav, sr, lambda f: prog(sep_share * f))
    wav = wav.mean(0, keepdim=True)
    if sr != SR:
        wav = torchaudio.functional.resample(wav, sr, SR)
    out("S Loading the timing model")
    bundle, model = load_model(a.models, out)
    out("S Listening to the vocals")
    res = align(words, lines, model, bundle, wav, out, lambda f: prog(sep_share + (1 - sep_share) * f))
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump({"words": res, "duration": duration}, f)
    prog(1.0)
    out("DONE")


def selftest(a, out):
    """Aligns torchaudio's sample sentence and checks the timing against the known answer."""
    import torch
    import torchaudio
    from torchaudio.utils import download_asset
    path = download_asset("tutorial-assets/Lab41-SRI-VOiCES-src-sp0307-ch127535-sg0042.wav")
    wav, sr = torchaudio.load(path)
    wav = torchaudio.functional.resample(wav, sr, SR)
    words = "i had that curiosity beside me at this moment".split()
    bundle, model = load_model(a.models, out)
    res = align(words, [0] * len(words), model, bundle, wav, out, lambda f: None)
    for w, r in zip(words, res):
        out(f"W {w} {r}")
    # the reference timings from the torchaudio tutorial: "curiosity" ~0.67-1.25 s
    cur = res[3]
    ok = cur and 0.5 < cur["s"] < 0.85 and 1.0 < cur["e"] < 1.45
    print("uroman test:", normalize_words(["שלום", "עולם", "hello"], "he"))
    out("DONE" if ok else "ERR alignment self-test is off: " + json.dumps(cur))
    if not ok:
        sys.exit(1)
