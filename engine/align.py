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
MIRROR = "https://github.com/aviadderi1/karaoke-system/releases/download/models-v1/mms_fa_model.pt"


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
            f = min(1.0, self.n / self.total)
            if int(f * 100) != getattr(self, "_last", -1):
                self._last = int(f * 100)
                _Bar.cb(f)

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


def separate_vocals(wav, sr, progress, overlap=0.1):
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
        res = apply_model(model, ((wav - mean) / std)[None], shifts=1, split=True, overlap=overlap,
                          progress=True, device="cpu", num_workers=0)[0]
    res = res * std + mean
    voc = res[list(model.sources).index("vocals")].mean(0, keepdim=True)
    _Bar.cb = None
    return voc, msr


def _mirror_download(models_dir, out):
    """Second source for the model file, in case the original server is unreachable."""
    import urllib.request
    os.makedirs(models_dir, exist_ok=True)
    dst = os.path.join(models_dir, "model.pt")
    tmp = dst + ".part"
    with urllib.request.urlopen(MIRROR, timeout=60) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done, last = 0, -1
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
            done += len(b)
            if total and int(done * 100 / total) != last:
                last = int(done * 100 / total)
                out(f"S Downloading the timing model (once) {last}%")
    os.replace(tmp, dst)


def load_model(models_dir, out):
    import torch
    import torch.hub as hub
    import torchaudio
    try:  # frozen apps don't always find the system certificates
        import certifi
        os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    except Exception:
        pass
    bundle = torchaudio.pipelines.MMS_FA
    hub.tqdm = _Bar  # download progress
    _Bar.cb = lambda f: out(f"S Downloading the timing model (once) {int(f * 100)}%")
    kw = {"dl_kwargs": {"model_dir": models_dir, "progress": True}} if models_dir else {}
    try:
        try:
            model = bundle.get_model(with_star=True, **kw)
        except Exception as e:
            if not models_dir:
                raise
            out("S The model server didn't answer, trying the Karaoke Lab mirror")
            try:
                os.remove(os.path.join(models_dir, "model.pt"))
            except OSError:
                pass
            _mirror_download(models_dir, out)
            model = bundle.get_model(with_star=True, **kw)
    finally:
        _Bar.cb = None
    model.eval()
    if os.environ.get("KL_QUANT") == "1":
        model = torch.ao.quantization.quantize_dynamic(model, {torch.nn.Linear}, dtype=torch.qint8)
    return bundle, model


def emissions(model, wave, progress):
    """Frame log-probabilities for the whole song, computed in overlapping windows."""
    import torch
    n = wave.shape[1]
    win, ctx = 20 * SR, 2 * SR
    hop_frames = None
    parts = []
    starts = list(range(0, n, win)) or [0]
    # windows where the vocal stem is silent (intro, solo, outro) don't need the model:
    # they get "nothing is being said" frames, which saves a lot of time on long instrumental parts
    x = wave[0]
    ref = float(x.abs().max()) or 1.0
    def silent(a, b):
        seg = x[a:b]
        if seg.numel() < SR:
            return False
        hop = SR // 10
        m = seg[: seg.numel() // hop * hop].reshape(-1, hop).pow(2).mean(1).sqrt()
        return float(m.max()) < 0.02 * ref
    blank_row = None
    todo = []
    with torch.inference_mode():
        for k, s in enumerate(starts):
            a, b = max(0, s - ctx), min(n, s + win + ctx)
            if silent(a, b):
                parts.append(("blank", s))
                continue
            em, _ = model(wave[:, a:b])
            em = em[0]
            ratio = (b - a) / em.shape[0]  # samples per frame (~320)
            f0 = int(round((s - a) / ratio))
            f1 = int(round((min(n, s + win) - a) / ratio))
            parts.append(em[f0:f1])
            if blank_row is None:
                blank_row = torch.full((em.shape[1],), -30.0)
                blank_row[0] = 0.0  # index 0 is the CTC blank
            progress((k + 1) / len(starts))
    if blank_row is None:
        raise RuntimeError("No singing was found in this song.")
    out_parts = []
    for p in parts:
        if isinstance(p, tuple):
            s = p[1]
            frames = int(round((min(n, s + win) - s) / 320))
            out_parts.append(blank_row.expand(frames, -1).clone())
        else:
            out_parts.append(p)
    em = torch.cat(out_parts, 0)
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
    voiced_ends(res, wave)
    return res


def voiced_ends(res, wave):
    """CTC marks where a word starts very precisely, but a held note keeps going after its last letter.
    Follow the vocal level after each word to find where the singing of that word really stops."""
    import torch
    hop = 320  # 20 ms
    x = wave[0]
    n = x.shape[0] // hop
    if n < 2:
        return
    rms = x[: n * hop].reshape(n, hop).pow(2).mean(1).sqrt()
    ref = float(torch.quantile(rms, 0.95)) if n > 10 else float(rms.max())
    thr = max(1e-4, 0.12 * ref)
    idx = [k for k, r in enumerate(res) if r]
    for a, k in enumerate(idx):
        r = res[k]
        nxt = res[idx[a + 1]]["s"] if a + 1 < len(idx) else r["e"] + 4.0
        f = int(r["e"] * SR / hop)
        stop = min(n, int(nxt * SR / hop), f + int(4.0 * SR / hop))
        while f < stop and rms[f] > thr:
            f += 1
        r["v"] = round(max(r["e"], f * hop / SR), 3)


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
    sep_share = 0.0 if a.vocals else 0.58
    prog = lambda f: out(f"Q {f:.4f}")

    data, sr = sf.read(a.align, dtype="float32", always_2d=True)
    wav = torch.from_numpy(np.ascontiguousarray(data.T))
    duration = wav.shape[1] / sr
    cache_file = None
    cache_dir = getattr(a, "cache", None)
    if not a.vocals and cache_dir:
        import hashlib
        h = hashlib.sha1()
        with open(a.align, "rb") as f:
            for b in iter(lambda: f.read(1 << 20), b""):
                h.update(b)
        cache_file = os.path.join(cache_dir, h.hexdigest()[:20] + ".wav")
    if cache_file and os.path.exists(cache_file):
        # same song as an earlier run: reuse its vocal stem and skip the separation
        out("S Separating the vocals from the music (reusing the last result)")
        d, sr = sf.read(cache_file, dtype="float32", always_2d=True)
        wav = torch.from_numpy(np.ascontiguousarray(d.T))
        prog(sep_share)
    else:
        if not a.vocals:
            out("S Separating the vocals from the music")
            wav, sr = separate_vocals(wav, sr, lambda f: prog(sep_share * f))
        wav = wav.mean(0, keepdim=True)
        if sr != SR:
            wav = torchaudio.functional.resample(wav, sr, SR)
        sr = SR
        if cache_file:
            try:
                os.makedirs(cache_dir, exist_ok=True)
                old = sorted((os.path.join(cache_dir, n) for n in os.listdir(cache_dir) if n.endswith(".wav")), key=os.path.getmtime)
                for o in old[:-5]:
                    os.remove(o)
                sf.write(cache_file + ".tmp.wav", wav[0].numpy(), SR, subtype="PCM_16")
                os.replace(cache_file + ".tmp.wav", cache_file)
            except Exception:
                pass
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
    cur = res[3]  # torchaudio's tutorial gives "curiosity" at about 1.09-1.79 s
    ok = cur and 0.95 < cur["s"] < 1.2 and 1.65 < cur["e"] < 1.95
    print("uroman test:", normalize_words(["שלום", "עולם", "hello"], "he"))
    out("DONE" if ok else "ERR alignment self-test is off: " + json.dumps(cur))
    if not ok:
        sys.exit(1)
