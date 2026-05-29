# HelixMind — Wearable Cardiac Triage

Tier 1 of a two-tier cardiac pipeline. Takes ECG + PPG from any wearable, classifies rhythm, stress, SpO2, and issues GREEN / YELLOW / RED severity with emergency escalation.

```
ecg_triage/
├── backend/
│   ├── model.py          ← all model + preprocessing classes
│   ├── main.py           ← FastAPI endpoints
│   ├── requirements.txt
│   └── Dockerfile
└── frontend/
    ├── src/
    │   ├── App.jsx       ← dashboard UI
    │   └── main.jsx
    ├── index.html
    ├── package.json
    └── vite.config.js
```

---

## Run locally (5 minutes)

### Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
# → http://localhost:8000
# → http://localhost:8000/docs  (Swagger UI)
```

To load a trained checkpoint:
```bash
MODEL_CHECKPOINT=helixmind_triage.pt uvicorn main:app --reload
```

If no checkpoint is set, the model runs with random weights (demo mode — results are not clinically meaningful).

### Frontend

```bash
cd frontend
cp .env.example .env          # default points to localhost:8000
npm install
npm run dev
# → http://localhost:5173
```

---

## Deploy to Render (backend) + Vercel (frontend)

### Backend → Render

1. Push the `backend/` folder to a GitHub repo (or the whole project).
2. New Web Service on [render.com](https://render.com):
   - Environment: **Docker**
   - Root directory: `backend`
   - The `Dockerfile` handles the rest.
3. Add environment variable: `MODEL_CHECKPOINT=helixmind_triage.pt` (only if you have a trained checkpoint file).
4. Copy the deployed URL (e.g. `https://helixmind-triage.onrender.com`).

### Frontend → Vercel

1. Push `frontend/` to GitHub.
2. New project on [vercel.com](https://vercel.com):
   - Framework preset: **Vite**
   - Root directory: `frontend`
3. Add environment variable: `VITE_API_URL=https://helixmind-triage.onrender.com`
4. Deploy.

---

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET  | `/`               | Health check |
| GET  | `/devices`        | List supported device names |
| POST | `/triage`         | Real signal inference |
| POST | `/triage/demo`    | Synthetic scenario (Normal / AFib / Bradycardia / Tachycardia / Anomaly) |
| GET  | `/health`         | Engine status |
| GET  | `/docs`           | Swagger UI |

### POST /triage/demo — example

```bash
curl -X POST http://localhost:8000/triage/demo \
  -H "Content-Type: application/json" \
  -d '{"scenario": "AFib", "device": "apple_watch"}'
```

### POST /triage — real signal

```bash
curl -X POST http://localhost:8000/triage \
  -H "Content-Type: application/json" \
  -d '{
    "ecg": [...7680 floats...],
    "ppg": [...1920 floats...],
    "device": "apple_watch"
  }'
```

---

## Performance tips

- The model runs on CPU and takes ~10–30ms per inference after warm-up — fast enough for the 30s window cycle.
- For faster CPU inference, export to ONNX (Section 18 of the notebook) and swap in `onnxruntime`:
  ```python
  import onnxruntime as ort
  session = ort.InferenceSession("helixmind_triage.onnx", providers=["CPUExecutionProvider"])
  ```
- Render free tier spins down after inactivity — the first request after sleep takes ~10s (cold start). Use Render's paid tier or Railway to keep it warm.

---

## Connecting real wearable data

The `/triage` endpoint accepts raw signal arrays. Your data source just needs to POST:
- `ecg`: raw ECG samples at the device's native Hz (the backend resamples to 256 Hz automatically)
- `ppg`: raw PPG samples at the device's native Hz (resampled to 64 Hz)
- `device`: one of the supported device names so the adapter knows the source Hz

See `model.py → DEVICE_PROFILES` to add a new device.
