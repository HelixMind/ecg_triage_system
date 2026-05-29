"""
HelixMind Wearable Triage — FastAPI backend
Run: uvicorn main:app --reload
"""

import os, io, json
import numpy as np
from contextlib import asynccontextmanager
from typing import Optional, List

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from model import (
    WearableTriageModel, UniversalSeverityEngine, UniversalInputAdapter,
    load_engine, ECG_LEN, PPG_LEN, ECG_FS, PPG_FS, WINDOW_SEC,
    DEVICE_PROFILES, ECGPreprocessor, PPGPreprocessor,
)

# ── App lifecycle ─────────────────────────────────────────────────────────────

engine: Optional[UniversalSeverityEngine] = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global engine
    checkpoint = os.getenv("MODEL_CHECKPOINT")
    engine = load_engine(checkpoint_path=checkpoint, device="cpu")
    print("Engine ready ✓")
    yield

app = FastAPI(title="HelixMind Wearable Triage API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Schemas ───────────────────────────────────────────────────────────────────

class TriageRequest(BaseModel):
    ecg:    Optional[List[float]] = None
    ppg:    Optional[List[float]] = None
    device: str = "generic_wearable"
    gps:    Optional[List[float]] = None

class DemoRequest(BaseModel):
    scenario: str = "Normal"
    device:   str = "generic_wearable"

# ── Synthetic generators ──────────────────────────────────────────────────────

def _gen_ecg(rhythm: str = "Normal") -> np.ndarray:
    t   = np.linspace(0, WINDOW_SEC, ECG_LEN)
    ecg = np.zeros_like(t)
    hr_map = {"Normal": 75, "AFib": 90, "Bradycardia": 38, "Tachycardia": 140, "Anomaly": 80}
    hr     = hr_map.get(rhythm, 75)

    if rhythm == "AFib":
        rr_base = 60.0 / hr
        pos = 0.0
        while pos < WINDOW_SEC:
            rr  = rr_base + np.random.uniform(-0.18, 0.18)
            idx = int(pos * (ECG_LEN / WINDOW_SEC))
            if idx < ECG_LEN:
                w = np.arange(-20, 20)
                ecg[max(0, idx-20):min(ECG_LEN, idx+20)] += np.exp(-w**2 / 8)
            pos += max(rr, 0.3)
    else:
        rr  = 60.0 / hr
        pos = 0.2
        while pos < WINDOW_SEC:
            idx = int(pos * (ECG_LEN / WINDOW_SEC))
            if idx < ECG_LEN:
                w = np.arange(-30, 30)
                ecg[max(0, idx-30):min(ECG_LEN, idx+30)] += 1.2 * np.exp(-w**2 / 18)
                tw = idx + int(0.25 * rr * (ECG_LEN / WINDOW_SEC))
                if tw < ECG_LEN:
                    wt = np.arange(-20, 20)
                    ecg[max(0, tw-20):min(ECG_LEN, tw+20)] += 0.3 * np.exp(-wt**2 / 50)
            pos += rr

    ecg += np.random.randn(ECG_LEN) * 0.04
    return ecg.astype(np.float32)


def _gen_ppg(hr=75, spo2=97.0, stress="Low") -> np.ndarray:
    t     = np.linspace(0, WINDOW_SEC, PPG_LEN)
    freq  = hr / 60.0
    sigma = {"Low": 0.02, "Medium": 0.05, "High": 0.09}.get(stress, 0.02)
    ppg   = 0.5 * np.sin(2 * np.pi * freq * t) + 0.2 * np.sin(4 * np.pi * freq * t)
    ppg  += np.random.randn(PPG_LEN) * sigma
    target_r = (110.0 - spo2) / 25.0
    dc_scale  = ppg.std() / (target_r + 1e-8)
    ppg = ppg / (np.abs(ppg.mean()) + dc_scale + 1e-8)
    return ppg.astype(np.float32)


# ── PTB-XL helpers ────────────────────────────────────────────────────────────

def _load_ptbxl_npy(data: bytes, lead_idx: int = 1) -> np.ndarray:
    """
    Load a PTB-XL .npy file (shape: [N_samples, 12] at 500 Hz or 100 Hz).
    Extracts lead II (index 1) and resamples to 256 Hz over 30s window.
    """
    arr = np.load(io.BytesIO(data))           # (N, 12) or (N,)
    if arr.ndim == 2:
        arr = arr[:, lead_idx]                # extract one lead
    arr = arr.astype(np.float32)

    # Detect source sample rate from length
    # PTB-XL standard: 5000 samples @ 500Hz OR 1000 samples @ 100Hz
    if len(arr) >= 5000:
        src_fs = 500
    elif len(arr) >= 900:
        src_fs = 100
    else:
        src_fs = 256                          # already correct rate, assume

    return arr, src_fs


def _ptbxl_label_to_scenario(label: str) -> str:
    label = label.upper()
    if "AFIB" in label or "AF" in label:     return "AFib"
    if "BRAD" in label:                       return "Bradycardia"
    if "TACH" in label:                       return "Tachycardia"
    return "Normal"


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {"service": "HelixMind Triage API", "status": "ok", "docs": "/docs"}

@app.get("/devices")
def list_devices():
    return {"devices": list(DEVICE_PROFILES.keys())}

@app.get("/health")
def health():
    return {"status": "ok", "engine_loaded": engine is not None}


@app.post("/triage")
def triage(req: TriageRequest):
    """Run triage on raw ECG/PPG arrays."""
    if req.ecg is None and req.ppg is None:
        raise HTTPException(400, "Provide at least one of 'ecg' or 'ppg'.")
    try:
        adapter = UniversalInputAdapter(req.device)
    except ValueError as e:
        raise HTTPException(400, str(e))

    ecg_raw = np.array(req.ecg, dtype=np.float32) if req.ecg else None
    ppg_raw = np.array(req.ppg, dtype=np.float32) if req.ppg else None
    adapted = adapter.adapt(ecg_raw=ecg_raw, ppg_raw=ppg_raw)
    gps     = tuple(req.gps) if req.gps and len(req.gps) == 2 else None
    result  = engine.evaluate(adapted, gps=gps)
    return {**result.to_dict(), "quality_flags": adapted["quality_flags"]}


@app.post("/triage/demo")
def triage_demo(req: DemoRequest):
    """Run triage on synthetic signal for a named scenario."""
    valid = ["Normal", "AFib", "Bradycardia", "Tachycardia", "Anomaly"]
    if req.scenario not in valid:
        raise HTTPException(400, f"scenario must be one of {valid}")

    hr_map    = {"Normal":75,"AFib":105,"Bradycardia":38,"Tachycardia":145,"Anomaly":80}
    spo2_map  = {"Normal":97,"AFib":94,"Bradycardia":88,"Tachycardia":96,"Anomaly":92}
    stress_map= {"Normal":"Low","AFib":"High","Bradycardia":"Medium","Tachycardia":"High","Anomaly":"Medium"}

    hr, spo2, stress = hr_map[req.scenario], spo2_map[req.scenario], stress_map[req.scenario]
    ecg_raw = _gen_ecg(req.scenario)
    ppg_raw = _gen_ppg(hr, spo2, stress)

    adapter = UniversalInputAdapter(req.device)
    adapted = adapter.adapt(ecg_raw=ecg_raw, ppg_raw=ppg_raw)
    result  = engine.evaluate(adapted)

    # Return the ECG signal for real-time display (downsample to 512 pts for bandwidth)
    ecg_display = adapted["ecg"][::ECG_LEN // 512].tolist()

    return {
        **result.to_dict(),
        "quality_flags":  adapted["quality_flags"],
        "demo_scenario":  req.scenario,
        "ecg_display":    ecg_display,      # 512 points for waveform rendering
        "ppg_display":    adapted["ppg"][::PPG_LEN // 256].tolist(),
    }


@app.post("/triage/ptbxl")
async def triage_ptbxl(
    file:      UploadFile = File(..., description="PTB-XL .npy record file"),
    label:     str        = Form("Normal", description="Rhythm label from PTB-XL metadata"),
    lead_idx:  int        = Form(1,        description="Which ECG lead to use (0-11), default=1 (Lead II)"),
    device:    str        = Form("generic_wearable"),
):
    """
    Upload a PTB-XL .npy file and run triage.

    PTB-XL records are stored as .npy files with shape (N_samples, 12).
    Download PTB-XL from: https://physionet.org/content/ptb-xl/1.0.3/
    Each record file is named like records500/00000/00001_hr.npy
    """
    if not file.filename.endswith(".npy"):
        raise HTTPException(400, "File must be a .npy file from PTB-XL dataset.")

    raw_bytes = await file.read()
    try:
        ecg_raw, src_fs = _load_ptbxl_npy(raw_bytes, lead_idx=lead_idx)
    except Exception as e:
        raise HTTPException(422, f"Could not parse .npy file: {e}")

    # Use kardia_mobile profile with detected fs override
    try:
        adapter = UniversalInputAdapter(device)
        # Patch the source fs so resampling is correct
        adapter.profile = {**adapter.profile, "ecg_fs": src_fs, "has_ecg": True}
    except ValueError as e:
        raise HTTPException(400, str(e))

    adapted = adapter.adapt(ecg_raw=ecg_raw, ppg_raw=None)
    result  = engine.evaluate(adapted)

    ecg_display = adapted["ecg"][::ECG_LEN // 512].tolist()
    scenario    = _ptbxl_label_to_scenario(label)

    return {
        **result.to_dict(),
        "quality_flags":  adapted["quality_flags"],
        "ptbxl_label":    label,
        "ptbxl_scenario": scenario,
        "source_fs":      src_fs,
        "lead_used":      lead_idx,
        "ecg_display":    ecg_display,
    }


@app.get("/triage/stream")
async def triage_stream(scenario: str = "Normal", device: str = "generic_wearable"):
    """
    Server-Sent Events stream — sends a triage result every 4 seconds.
    Connect from JS: const evtSource = new EventSource('/triage/stream?scenario=AFib')
    """
    valid = ["Normal", "AFib", "Bradycardia", "Tachycardia", "Anomaly"]
    if scenario not in valid:
        raise HTTPException(400, f"scenario must be one of {valid}")

    import asyncio

    hr_map    = {"Normal":75,"AFib":105,"Bradycardia":38,"Tachycardia":145,"Anomaly":80}
    spo2_map  = {"Normal":97,"AFib":94,"Bradycardia":88,"Tachycardia":96,"Anomaly":92}
    stress_map= {"Normal":"Low","AFib":"High","Bradycardia":"Medium","Tachycardia":"High","Anomaly":"Medium"}

    async def event_gen():
        while True:
            hr, spo2, stress = hr_map[scenario], spo2_map[scenario], stress_map[scenario]
            ecg_raw = _gen_ecg(scenario)
            ppg_raw = _gen_ppg(hr, spo2, stress)
            adapter = UniversalInputAdapter(device)
            adapted = adapter.adapt(ecg_raw=ecg_raw, ppg_raw=ppg_raw)
            result  = engine.evaluate(adapted)
            payload = {
                **result.to_dict(),
                "ecg_display": adapted["ecg"][::ECG_LEN // 512].tolist(),
            }
            yield f"data: {json.dumps(payload)}\n\n"
            await asyncio.sleep(4)

    return StreamingResponse(event_gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
