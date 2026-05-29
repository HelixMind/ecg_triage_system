import { useState, useEffect, useRef, useCallback } from "react";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";

const SCENARIOS = ["Normal", "AFib", "Bradycardia", "Tachycardia", "Anomaly"];
const DEVICES   = [
  "generic_wearable","apple_watch","samsung_galaxy",
  "fitbit_sense","fitbit_charge","garmin_venu","kardia_mobile","smartphone_camera",
];
const SEV_COLOR = { GREEN: "#00c47a", YELLOW: "#f5a623", RED: "#e53935" };
const SEV_BG    = { GREEN: "#00c47a14", YELLOW: "#f5a62314", RED: "#e5393514" };
const SEV_BORDER= { GREEN: "#00c47a40", YELLOW: "#f5a62340", RED: "#e5393560" };

// ── Typewriter ────────────────────────────────────────────────────────────────
function useTypewriter(text, speed = 20) {
  const [d, setD] = useState("");
  useEffect(() => {
    setD(""); if (!text) return;
    let i = 0;
    const t = setInterval(() => { setD(text.slice(0, ++i)); if (i >= text.length) clearInterval(t); }, speed);
    return () => clearInterval(t);
  }, [text]);
  return d;
}

// ── Real-signal scrolling ECG canvas ─────────────────────────────────────────
function ECGCanvas({ signalData, running, severity }) {
  const canvasRef  = useRef(null);
  const frameRef   = useRef(0);
  const bufRef     = useRef([]);         // rolling sample buffer
  const writeRef   = useRef(0);          // write head
  const col        = SEV_COLOR[severity] || "#00c47a";

  // When new signal arrives, append it to rolling buffer
  useEffect(() => {
    if (!signalData || signalData.length === 0) return;
    bufRef.current = [...bufRef.current, ...signalData].slice(-2048);
  }, [signalData]);

  // Animate: draw the last W samples as a scrolling strip
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;

    // If no real data, fall back to synthetic ECG shape
    function synth(x, offset) {
      const t = ((x + offset) % 200) / 200;
      if (t < 0.10) return 0;
      if (t < 0.14) return -0.15;
      if (t < 0.16) return  0;
      if (t < 0.18) return  1.0;
      if (t < 0.20) return -0.28;
      if (t < 0.22) return  0;
      if (t < 0.40) return  0.18 * Math.sin((t - 0.22) / 0.18 * Math.PI);
      return 0;
    }

    let offset = 0;
    function draw() {
      ctx.clearRect(0, 0, W, H);

      // Grid lines
      ctx.strokeStyle = "#1e2535";
      ctx.lineWidth   = 0.5;
      for (let gx = 0; gx < W; gx += 40) {
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
      }
      for (let gy = 0; gy < H; gy += H / 4) {
        ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
      }

      // Signal
      const buf = bufRef.current;
      ctx.strokeStyle = col;
      ctx.lineWidth   = 1.8;
      ctx.shadowColor = col;
      ctx.shadowBlur  = running ? 5 : 0;
      ctx.beginPath();

      for (let px = 0; px < W; px++) {
        let val;
        if (buf.length >= W) {
          // Use real signal: map pixel to buffer position
          const idx = Math.floor((px / W) * buf.length);
          val = buf[idx];
        } else {
          val = synth(px, offset);
        }
        const noise = buf.length >= W ? 0 : (Math.random() - 0.5) * 0.03;
        const y = H / 2 - (val + noise) * (H * 0.36);
        px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
      }
      ctx.stroke();

      // Scrolling cursor (scanning line)
      if (running) {
        const cx = (writeRef.current % W);
        ctx.strokeStyle = col + "60";
        ctx.lineWidth   = 1;
        ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
        writeRef.current = (writeRef.current + 2) % W;
        offset = (offset + 1.4) % 200;
      }

      frameRef.current = requestAnimationFrame(draw);
    }

    frameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameRef.current);
  }, [running, col]);

  return (
    <canvas ref={canvasRef} width={860} height={80}
      style={{ display: "block", width: "100%", height: 80 }} />
  );
}

// ── Sparkline ─────────────────────────────────────────────────────────────────
function Spark({ data, color, h = 30 }) {
  if (!data || data.length < 2) return null;
  const W = 160;
  const mn = Math.min(...data), mx = Math.max(...data), r = mx - mn || 1;
  const pts = data.map((v, i) => `${(i/(data.length-1))*W},${h-((v-mn)/r)*h*0.88-h*0.06}`).join(" ");
  return <svg width={W} height={h} style={{ display:"block" }}>
    <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
  </svg>;
}

// ── Vital card ────────────────────────────────────────────────────────────────
function Vital({ label, value, unit, sub, history, color = "#4a9eff", warn }) {
  return (
    <div style={{
      background: "#0a0f1a", border: `1px solid ${warn ? "#f5a62340" : "#1e2535"}`,
      borderRadius: 8, padding: "14px 16px",
    }}>
      <div style={{ fontSize: 10, color: "#3d4f6b", letterSpacing: "0.1em", marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
        <span style={{ fontSize: 24, fontWeight: 600, color: warn ? "#f5a623" : "#dce5f0", fontVariantNumeric: "tabular-nums" }}>
          {value ?? "—"}
        </span>
        {unit && <span style={{ fontSize: 11, color: "#3d4f6b" }}>{unit}</span>}
      </div>
      {sub && <div style={{ fontSize: 10, color: warn ? "#f5a623" : "#4a6080", marginTop: 2 }}>{sub}</div>}
      {history?.length > 2 && <div style={{ marginTop: 8, opacity: 0.65 }}><Spark data={history} color={color} /></div>}
    </div>
  );
}

// ── Rhythm bar ────────────────────────────────────────────────────────────────
function RhythmBar({ label, prob, active }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 2 }}>
        <span style={{ color: active ? "#e2e8f0" : "#4a6080" }}>{label}</span>
        <span style={{ color: active ? "#4a9eff" : "#2a3d55", fontVariantNumeric: "tabular-nums" }}>
          {(prob * 100).toFixed(1)}%
        </span>
      </div>
      <div style={{ background: "#111825", borderRadius: 2, height: 3, overflow: "hidden" }}>
        <div style={{
          height: "100%", borderRadius: 2,
          width: `${(prob * 100).toFixed(1)}%`,
          background: active ? "#4a9eff" : "#1e2d3f",
          transition: "width 0.5s ease",
        }} />
      </div>
    </div>
  );
}

// ── Severity badge ────────────────────────────────────────────────────────────
function Badge({ s }) {
  const icons = { GREEN: "●", YELLOW: "▲", RED: "■" };
  const txt   = { GREEN: "ALL CLEAR", YELLOW: "WARNING", RED: "EMERGENCY" };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "3px 12px", borderRadius: 4, fontSize: 10, fontWeight: 700,
      letterSpacing: "0.12em", background: SEV_BG[s],
      color: SEV_COLOR[s], border: `1px solid ${SEV_BORDER[s]}`,
    }}>
      <span style={{ fontSize: 7 }}>{icons[s]}</span>{txt[s]}
    </span>
  );
}

// ── Tab button ────────────────────────────────────────────────────────────────
function Tab({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: "7px 16px", fontSize: 10, fontWeight: 600, letterSpacing: "0.1em",
      background: active ? "#4a9eff18" : "transparent",
      color: active ? "#4a9eff" : "#3d4f6b",
      border: active ? "1px solid #4a9eff40" : "1px solid transparent",
      borderRadius: 6, cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
    }}>{children}</button>
  );
}

// ── Main app ──────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab]           = useState("demo");  // demo | ptbxl
  const [device, setDevice]     = useState("generic_wearable");
  const [scenario, setScenario] = useState("Normal");
  const [loading, setLoading]   = useState(false);
  const [result, setResult]     = useState(null);
  const [error, setError]       = useState(null);
  const [streaming, setStreaming] = useState(false);
  const [ecgSignal, setEcgSignal] = useState([]);
  const [history, setHistory]   = useState({ hr: [], spo2: [], score: [] });

  // PTB-XL tab state
  const [ptbFile, setPtbFile]   = useState(null);
  const [ptbLabel, setPtbLabel] = useState("Normal");
  const [ptbLead, setPtbLead]   = useState(1);

  const sseRef      = useRef(null);
  const intervalRef = useRef(null);
  const severity    = result?.severity || "GREEN";

  function applyResult(data) {
    setResult(data);
    if (data.ecg_display) setEcgSignal(data.ecg_display);
    setHistory(h => ({
      hr:    [...h.hr.slice(-39),    data.heart_rate],
      spo2:  [...h.spo2.slice(-39),  data.spo2],
      score: [...h.score.slice(-39), data.severity_score * 100],
    }));
  }

  // ── Demo: run once ──────────────────────────────────────────────────────────
  async function runDemo() {
    setLoading(true); setError(null);
    try {
      const res  = await fetch(`${API_BASE}/triage/demo`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario, device }),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      applyResult(await res.json());
    } catch (e) { setError(e.message); }
    finally      { setLoading(false); }
  }

  // ── SSE streaming monitor ───────────────────────────────────────────────────
  function toggleStream() {
    if (streaming) {
      sseRef.current?.close();
      setStreaming(false);
    } else {
      const url = `${API_BASE}/triage/stream?scenario=${scenario}&device=${device}`;
      const es  = new EventSource(url);
      es.onmessage = e => applyResult(JSON.parse(e.data));
      es.onerror   = ()  => { setError("Stream disconnected"); setStreaming(false); };
      sseRef.current = es;
      setStreaming(true);
    }
  }

  // ── PTB-XL upload ───────────────────────────────────────────────────────────
  async function runPtbxl() {
    if (!ptbFile) return;
    setLoading(true); setError(null);
    try {
      const fd = new FormData();
      fd.append("file",     ptbFile);
      fd.append("label",    ptbLabel);
      fd.append("lead_idx", ptbLead);
      fd.append("device",   device);
      const res = await fetch(`${API_BASE}/triage/ptbxl`, { method: "POST", body: fd });
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
      applyResult(await res.json());
    } catch (e) { setError(e.message); }
    finally     { setLoading(false); }
  }

  useEffect(() => () => { sseRef.current?.close(); clearInterval(intervalRef.current); }, []);

  const reasonText = useTypewriter(result?.escalation_reason || "", 20);

  return (
    <div style={{
      minHeight: "100vh", background: "#060c14", color: "#dce5f0",
      fontFamily: "'IBM Plex Mono', 'Courier New', monospace", padding: "0 0 60px",
    }}>

      {/* Header */}
      <header style={{
        borderBottom: "1px solid #111f30", padding: "14px 28px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        background: "#060c14",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 6, background: "#4a9eff14",
            border: "1px solid #4a9eff40", display: "flex", alignItems: "center",
            justifyContent: "center", fontSize: 15,
          }}>♥</div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}>HELIXMIND</div>
            <div style={{ fontSize: 9, color: "#3d4f6b", letterSpacing: "0.12em" }}>CARDIAC TRIAGE · TIER 1</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {result && <Badge s={severity} />}
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            fontSize: 9, color: "#3d4f6b", letterSpacing: "0.1em",
          }}>
            <div style={{
              width: 7, height: 7, borderRadius: "50%",
              background: streaming ? "#00c47a" : "#1e2d3f",
              boxShadow: streaming ? "0 0 8px #00c47a" : "none",
              transition: "all 0.4s",
            }} />
            {streaming ? "LIVE" : "STANDBY"}
          </div>
        </div>
      </header>

      <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 20px" }}>

        {/* ECG strip */}
        <div style={{
          background: "#090f1a", border: `1px solid ${SEV_BORDER[severity]}`,
          borderRadius: 8, padding: "14px 18px", marginBottom: 20,
          transition: "border-color 0.5s",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ fontSize: 9, color: "#3d4f6b", letterSpacing: "0.12em" }}>
              ECG — LEAD II · 256 Hz · 30s WINDOW
            </span>
            {result && (
              <span style={{ fontSize: 9, color: SEV_COLOR[severity], letterSpacing: "0.08em" }}>
                {result.rhythm_label}
              </span>
            )}
          </div>
          <ECGCanvas signalData={ecgSignal} running={streaming} severity={severity} />
        </div>

        {/* Mode tabs */}
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          <Tab active={tab === "demo"}  onClick={() => setTab("demo")}>DEMO / SYNTHETIC</Tab>
          <Tab active={tab === "ptbxl"} onClick={() => setTab("ptbxl")}>PTB-XL UPLOAD</Tab>
        </div>

        {/* Demo controls */}
        {tab === "demo" && (
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr auto auto auto",
            gap: 10, marginBottom: 20, alignItems: "end",
          }}>
            <div>
              <div style={{ fontSize: 9, color: "#3d4f6b", letterSpacing: "0.1em", marginBottom: 5 }}>DEVICE</div>
              <select value={device} onChange={e => setDevice(e.target.value)}
                style={{ width:"100%", background:"#090f1a", border:"1px solid #1a2540",
                  color:"#dce5f0", padding:"8px 10px", borderRadius:6, fontSize:11, fontFamily:"inherit" }}>
                {DEVICES.map(d => <option key={d} value={d}>{d.replace(/_/g," ")}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 9, color: "#3d4f6b", letterSpacing: "0.1em", marginBottom: 5 }}>SCENARIO</div>
              <select value={scenario} onChange={e => setScenario(e.target.value)}
                style={{ width:"100%", background:"#090f1a", border:"1px solid #1a2540",
                  color:"#dce5f0", padding:"8px 10px", borderRadius:6, fontSize:11, fontFamily:"inherit" }}>
                {SCENARIOS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <button onClick={runDemo} disabled={loading || streaming}
              style={{
                padding:"8px 18px", borderRadius:6, fontSize:10, fontWeight:600,
                letterSpacing:"0.08em", border:"1px solid #4a9eff40",
                background: loading ? "#111825" : "#4a9eff14", color:"#4a9eff",
                cursor: loading || streaming ? "not-allowed" : "pointer", fontFamily:"inherit",
              }}>
              {loading ? "…" : "RUN ONCE"}
            </button>
            <button onClick={toggleStream}
              style={{
                padding:"8px 18px", borderRadius:6, fontSize:10, fontWeight:600,
                letterSpacing:"0.08em",
                border:`1px solid ${streaming ? "#e5393540" : "#00c47a40"}`,
                background: streaming ? "#e5393514" : "#00c47a14",
                color: streaming ? "#e53935" : "#00c47a",
                cursor:"pointer", fontFamily:"inherit",
              }}>
              {streaming ? "STOP" : "LIVE STREAM"}
            </button>
          </div>
        )}

        {/* PTB-XL controls */}
        {tab === "ptbxl" && (
          <div style={{
            background:"#090f1a", border:"1px solid #1a2540",
            borderRadius:8, padding:"18px 20px", marginBottom:20,
          }}>
            <div style={{ fontSize: 9, color: "#3d4f6b", letterSpacing: "0.12em", marginBottom: 14 }}>
              PTB-XL RECORD UPLOAD — .npy format (records500/ or records100/)
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"2fr 1fr 1fr 1fr auto", gap:10, alignItems:"end" }}>
              <div>
                <div style={{ fontSize: 9, color: "#3d4f6b", marginBottom: 5 }}>RECORD FILE (.npy)</div>
                <label style={{
                  display:"flex", alignItems:"center", gap: 8,
                  background:"#060c14", border:"1px dashed #1a2540",
                  borderRadius:6, padding:"8px 12px", cursor:"pointer", fontSize:11,
                  color: ptbFile ? "#4a9eff" : "#3d4f6b",
                }}>
                  <span>📂</span>
                  {ptbFile ? ptbFile.name : "Click to choose .npy"}
                  <input type="file" accept=".npy" style={{ display:"none" }}
                    onChange={e => setPtbFile(e.target.files[0] || null)} />
                </label>
              </div>
              <div>
                <div style={{ fontSize: 9, color: "#3d4f6b", marginBottom: 5 }}>RHYTHM LABEL</div>
                <select value={ptbLabel} onChange={e => setPtbLabel(e.target.value)}
                  style={{ width:"100%", background:"#090f1a", border:"1px solid #1a2540",
                    color:"#dce5f0", padding:"8px 10px", borderRadius:6, fontSize:11, fontFamily:"inherit" }}>
                  {SCENARIOS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <div style={{ fontSize: 9, color: "#3d4f6b", marginBottom: 5 }}>LEAD (0–11)</div>
                <input type="number" min={0} max={11} value={ptbLead}
                  onChange={e => setPtbLead(parseInt(e.target.value))}
                  style={{ width:"100%", background:"#090f1a", border:"1px solid #1a2540",
                    color:"#dce5f0", padding:"8px 10px", borderRadius:6, fontSize:11, fontFamily:"inherit" }} />
              </div>
              <div>
                <div style={{ fontSize: 9, color: "#3d4f6b", marginBottom: 5 }}>DEVICE</div>
                <select value={device} onChange={e => setDevice(e.target.value)}
                  style={{ width:"100%", background:"#090f1a", border:"1px solid #1a2540",
                    color:"#dce5f0", padding:"8px 10px", borderRadius:6, fontSize:11, fontFamily:"inherit" }}>
                  {DEVICES.map(d => <option key={d} value={d}>{d.replace(/_/g," ")}</option>)}
                </select>
              </div>
              <button onClick={runPtbxl} disabled={!ptbFile || loading}
                style={{
                  padding:"8px 18px", borderRadius:6, fontSize:10, fontWeight:600,
                  letterSpacing:"0.08em", border:"1px solid #4a9eff40",
                  background: !ptbFile || loading ? "#111825" : "#4a9eff14", color:"#4a9eff",
                  cursor: !ptbFile || loading ? "not-allowed" : "pointer", fontFamily:"inherit",
                }}>
                {loading ? "…" : "ANALYSE"}
              </button>
            </div>
            <div style={{ marginTop: 12, fontSize: 10, color: "#2a3d55", lineHeight: 1.7 }}>
              Download PTB-XL: physionet.org/content/ptb-xl/1.0.3/ →
              records500/00000/00001_hr.npy · Shape: (5000, 12) at 500 Hz
            </div>
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div style={{
            background:"#e5393512", border:"1px solid #e5393540", borderRadius:8,
            padding:"12px 16px", marginBottom:18, fontSize:11, color:"#e53935",
          }}>
            ⚠ {error} — is the backend running at {API_BASE}?
          </div>
        )}

        {/* Results */}
        {result && (<>

          {/* Emergency alert */}
          {result.requires_escalation && (
            <div style={{
              background:"#e5393510", border:"1px solid #e5393560", borderRadius:8,
              padding:"14px 18px", marginBottom:18, display:"flex", gap:12, alignItems:"flex-start",
            }}>
              <span style={{ fontSize:18, color:"#e53935", flexShrink:0, marginTop:2 }}>■</span>
              <div>
                <div style={{ fontSize:11, fontWeight:600, color:"#e53935", letterSpacing:"0.08em", marginBottom:3 }}>
                  EMERGENCY ESCALATION TRIGGERED
                </div>
                <div style={{ fontSize:11, color:"#fc8181" }}>{reasonText}</div>
              </div>
            </div>
          )}

          {/* Vitals */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10, marginBottom:14 }}>
            <Vital label="HEART RATE" value={Math.round(result.heart_rate)} unit="bpm"
              history={history.hr} color={SEV_COLOR[severity]}
              warn={result.heart_rate < 50 || result.heart_rate > 120} />
            <Vital label="SpO2" value={result.spo2.toFixed(1)} unit="%"
              sub={result.spo2 < 95 ? "below threshold" : "normal"}
              history={history.spo2} color="#4a9eff"
              warn={result.spo2 < 95} />
            <Vital label="HRV RMSSD" value={result.hrv_rmssd.toFixed(1)} unit="ms"
              sub={result.hrv_rmssd < 20 ? "low — high stress" : ""}
              warn={result.hrv_rmssd < 20} />
            <Vital label="SEVERITY" value={(result.severity_score * 100).toFixed(0)} unit="/100"
              history={history.score} color={SEV_COLOR[severity]}
              warn={result.severity !== "GREEN"} />
          </div>

          {/* Bottom row */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>

            {/* Rhythm */}
            <div style={{ background:"#090f1a", border:"1px solid #111f30", borderRadius:8, padding:"16px 18px" }}>
              <div style={{ fontSize:9, color:"#3d4f6b", letterSpacing:"0.12em", marginBottom:14 }}>
                RHYTHM CLASSIFICATION
              </div>
              {Object.entries(result.rhythm_probs).map(([lbl, p]) => (
                <RhythmBar key={lbl} label={lbl} prob={p} active={lbl === result.rhythm_label} />
              ))}
              <div style={{ marginTop:12, paddingTop:12, borderTop:"1px solid #111f30", fontSize:10, color:"#3d4f6b" }}>
                Detected: <span style={{ color:"#4a9eff" }}>{result.rhythm_label}</span>
                <span style={{ color:"#1e2d3f" }}> · </span>
                Stress: <span style={{ color: result.stress_level==="High" ? "#f5a623" : "#4a6080" }}>
                  {result.stress_level}
                </span>
              </div>
            </div>

            {/* Summary */}
            <div style={{ background:"#090f1a", border:"1px solid #111f30", borderRadius:8, padding:"16px 18px" }}>
              <div style={{ fontSize:9, color:"#3d4f6b", letterSpacing:"0.12em", marginBottom:14 }}>
                TRIAGE SUMMARY
              </div>
              <div style={{ marginBottom:16 }}>
                <div style={{ fontSize:34, fontWeight:700, color:SEV_COLOR[severity], letterSpacing:"-0.02em" }}>
                  {result.severity}
                </div>
                <div style={{ fontSize:10, color:"#4a6080", marginTop:3 }}>
                  {result.severity==="GREEN"  && "Continue monitoring — vitals normal"}
                  {result.severity==="YELLOW" && "User alert — recommend clinical ECG"}
                  {result.severity==="RED"    && "Emergency — escalation initiated"}
                </div>
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                {[
                  ["Source",    result.ptbxl_label ? `PTB-XL · ${result.ptbxl_label}` : (result.demo_scenario ? `Demo · ${result.demo_scenario}` : "live")],
                  ["Device",    device.replace(/_/g," ")],
                  ["Timestamp", result.timestamp],
                  ["ECG qual.", result.quality_flags?.ecg || "—"],
                  ["PPG qual.", result.quality_flags?.ppg || "—"],
                ].map(([k,v]) => (
                  <div key={k} style={{ display:"flex", justifyContent:"space-between", fontSize:10 }}>
                    <span style={{ color:"#3d4f6b" }}>{k}</span>
                    <span style={{ color:"#4a6080", maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", textAlign:"right" }}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>)}

        {!result && !loading && (
          <div style={{ textAlign:"center", padding:"56px 0", color:"#1e2d3f", fontSize:11, letterSpacing:"0.12em" }}>
            SELECT A SCENARIO AND PRESS RUN ONCE OR LIVE STREAM
          </div>
        )}
      </div>
    </div>
  );
}
