import { useState, useEffect, useRef } from "react";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";

const SCENARIOS = ["Normal", "AFib", "Bradycardia", "Tachycardia", "Anomaly"];
const DEVICES   = ["generic_wearable","apple_watch","samsung_galaxy","fitbit_sense","fitbit_charge","garmin_venu","kardia_mobile","smartphone_camera"];
const LEADS     = ["I","II","III","AVR","AVL","AVF","V1","V2","V3","V4","V5","V6"];

const SEV = {
  GREEN:  { color: "#0affb2", glow: "#0affb288", bg: "#0affb209", border: "#0affb230", label: "NORMAL", icon: "◆" },
  YELLOW: { color: "#ffe066", glow: "#ffe06688", bg: "#ffe06609", border: "#ffe06630", label: "WARNING", icon: "▲" },
  RED:    { color: "#ff3c5f", glow: "#ff3c5f88", bg: "#ff3c5f09", border: "#ff3c5f50", label: "CRITICAL", icon: "■" },
};

/* ── Scrolling ECG canvas ─────────────────────────────────────────────────── */
function ECGCanvas({ data, running, sev }) {
  const ref    = useRef(null);
  const buf    = useRef([]);
  const raf    = useRef(0);
  const offset = useRef(0);
  const c      = SEV[sev]?.color || "#0affb2";

  useEffect(() => {
    if (data?.length) buf.current = [...buf.current, ...data].slice(-1024);
  }, [data]);

  useEffect(() => {
    const cv  = ref.current; if (!cv) return;
    const ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height;

    function beat(x, off) {
      const t = ((x + off) % 220) / 220;
      if (t < .09) return 0;
      if (t < .13) return -.12;
      if (t < .15) return 0;
      if (t < .17) return 1;
      if (t < .19) return -.25;
      if (t < .21) return 0;
      if (t < .38) return .15 * Math.sin((t-.21)/.17*Math.PI);
      return 0;
    }

    function frame() {
      ctx.clearRect(0, 0, W, H);

      // grid
      ctx.strokeStyle = "#ffffff06";
      ctx.lineWidth = 1;
      for (let x = 0; x < W; x += 50) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
      for (let y = 0; y < H; y += H/4) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

      // baseline
      ctx.strokeStyle = "#ffffff08";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, H/2); ctx.lineTo(W, H/2); ctx.stroke();

      // signal
      ctx.strokeStyle = c;
      ctx.lineWidth = 2;
      ctx.shadowColor = c;
      ctx.shadowBlur = running ? 8 : 3;
      ctx.beginPath();

      const b = buf.current;
      for (let px = 0; px < W; px++) {
        let v;
        if (b.length >= W) {
          v = b[Math.floor(px / W * b.length)];
        } else {
          v = beat(px, offset.current) + (Math.random()-.5)*.025;
        }
        const y = H/2 - v * H * .38;
        px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      if (running) offset.current = (offset.current + 1.6) % 220;
      raf.current = requestAnimationFrame(frame);
    }

    raf.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf.current);
  }, [running, c]);

  return <canvas ref={ref} width={900} height={90} style={{ width:"100%", height:90, display:"block" }} />;
}

/* ── Trend sparkline ─────────────────────────────────────────────────────── */
function Trend({ data, color }) {
  if (!data || data.length < 2) return null;
  const W=120, H=28, mn=Math.min(...data), mx=Math.max(...data), r=mx-mn||1;
  const pts = data.map((v,i)=>`${i/(data.length-1)*W},${H-((v-mn)/r)*H*.85-.06*H}`).join(" ");
  return <svg width={W} height={H} style={{display:"block",opacity:.7}}>
    <defs><linearGradient id={`g${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor={color} stopOpacity=".25"/>
      <stop offset="100%" stopColor={color} stopOpacity="0"/>
    </linearGradient></defs>
    <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round"/>
  </svg>;
}

/* ── Rhythm probability bar ──────────────────────────────────────────────── */
function RhBar({ label, prob, active, accentColor }) {
  return <div style={{marginBottom:10}}>
    <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:3}}>
      <span style={{color: active?"#f0f4ff":"#3a4a60",fontWeight: active?600:400,letterSpacing:".04em"}}>{label}</span>
      <span style={{color: active?accentColor:"#2a3a50",fontVariantNumeric:"tabular-nums",fontSize:11}}>
        {(prob*100).toFixed(1)}%
      </span>
    </div>
    <div style={{background:"#0d1520",borderRadius:2,height:3,overflow:"hidden"}}>
      <div style={{
        height:"100%",borderRadius:2,
        width:`${Math.max(prob*100,.3).toFixed(1)}%`,
        background: active ? `linear-gradient(90deg, ${accentColor}88, ${accentColor})` : "#1a2535",
        transition:"width .6s cubic-bezier(.4,0,.2,1)",
        boxShadow: active ? `0 0 6px ${accentColor}66` : "none",
      }}/>
    </div>
  </div>;
}

/* ── Vital metric card ───────────────────────────────────────────────────── */
function Metric({ label, value, unit, sub, trend, color="#4d9fff", warn=false }) {
  return <div style={{
    background:"#080e1a",
    border:`1px solid ${warn?"#ffe06628":"#111d2e"}`,
    borderRadius:10,padding:"16px 18px",
    transition:"border-color .4s",
  }}>
    <div style={{fontSize:9,color:"#2a3d55",letterSpacing:".14em",marginBottom:6,fontWeight:600}}>{label}</div>
    <div style={{display:"flex",alignItems:"baseline",gap:5,marginBottom:2}}>
      <span style={{
        fontSize:28,fontWeight:700,
        color: warn?"#ffe066":color,
        fontVariantNumeric:"tabular-nums",
        letterSpacing:"-.02em",
        textShadow: warn?`0 0 20px #ffe06644`:`0 0 20px ${color}33`,
      }}>{value??<span style={{color:"#1a2535"}}>—</span>}</span>
      {unit&&<span style={{fontSize:11,color:"#2a3d55"}}>{unit}</span>}
    </div>
    {sub&&<div style={{fontSize:10,color:warn?"#ffe066":"#2a3d55",marginTop:1}}>{sub}</div>}
    {trend?.length>2&&<div style={{marginTop:8}}><Trend data={trend} color={warn?"#ffe066":color}/></div>}
  </div>;
}

/* ── Tab ────────────────────────────────────────────────────────────────── */
function Tab({ label, active, onClick, dot }) {
  return <button onClick={onClick} style={{
    padding:"8px 18px",fontSize:10,fontWeight:700,letterSpacing:".1em",
    background: active?"#0affb214":"transparent",
    color: active?"#0affb2":"#2a3d55",
    border: active?"1px solid #0affb230":"1px solid transparent",
    borderRadius:6,cursor:"pointer",fontFamily:"inherit",
    transition:"all .2s",display:"flex",alignItems:"center",gap:6,
  }}>
    {dot&&<span style={{width:5,height:5,borderRadius:"50%",background:"#ff3c5f",boxShadow:"0 0 6px #ff3c5f"}}/>}
    {label}
  </button>;
}

/* ── Main ────────────────────────────────────────────────────────────────── */
export default function App() {
  const [tab, setTab]         = useState("demo");
  const [device, setDevice]   = useState("generic_wearable");
  const [scenario, setScenario] = useState("Normal");
  const [lead, setLead]       = useState("II");
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [result, setResult]   = useState(null);
  const [error, setError]     = useState(null);
  const [ecgSig, setEcgSig]   = useState([]);
  const [hist, setHist]       = useState({ hr:[], spo2:[], score:[] });
  const [datFile, setDatFile] = useState(null);
  const [heaFile, setHeaFile] = useState(null);
  const [ptbLabel, setPtbLabel] = useState("Normal");
  const sseRef  = useRef(null);
  const sev     = result?.severity || "GREEN";
  const S       = SEV[sev];

  function apply(data) {
    setResult(data);
    if (data.ecg_display) setEcgSig(data.ecg_display);
    setHist(h=>({
      hr:    [...h.hr.slice(-49),    data.heart_rate],
      spo2:  [...h.spo2.slice(-49),  data.spo2],
      score: [...h.score.slice(-49), data.severity_score*100],
    }));
  }

  async function runDemo() {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`${API_BASE}/triage/demo`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({scenario,device}),
      });
      if(!r.ok) throw new Error(`${r.status}`);
      apply(await r.json());
    } catch(e){ setError(e.message); } finally { setLoading(false); }
  }

  function toggleStream() {
    if(streaming){ sseRef.current?.close(); setStreaming(false); return; }
    const es = new EventSource(`${API_BASE}/triage/stream?scenario=${scenario}&device=${device}`);
    es.onmessage = e => apply(JSON.parse(e.data));
    es.onerror   = ()=>{ setError("Stream dropped"); setStreaming(false); };
    sseRef.current = es;
    setStreaming(true);
  }

  async function runWfdb() {
    if(!datFile||!heaFile){ setError("Upload both .dat and .hea files"); return; }
    setLoading(true); setError(null);
    try {
      const fd = new FormData();
      fd.append("dat_file", datFile);
      fd.append("hea_file", heaFile);
      fd.append("label",    ptbLabel);
      fd.append("lead",     lead);
      fd.append("device",   device);
      const r = await fetch(`${API_BASE}/triage/wfdb`,{method:"POST",body:fd});
      if(!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      apply(await r.json());
    } catch(e){ setError(e.message); } finally { setLoading(false); }
  }

  useEffect(()=>()=>sseRef.current?.close(),[]);

  const sel = {
    background:"#05080f", border:"1px solid #111d2e", color:"#c0cfe8",
    padding:"9px 12px", borderRadius:8, fontSize:11, fontFamily:"inherit",
    width:"100%", outline:"none", cursor:"pointer",
  };

  return (
    <div style={{
      minHeight:"100vh",
      background:"#05080f",
      color:"#c0cfe8",
      fontFamily:"'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
    }}>
      {/* ── noise texture overlay ── */}
      <div style={{
        position:"fixed",inset:0,pointerEvents:"none",zIndex:0,
        backgroundImage:`url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E")`,
        opacity:.4,
      }}/>

      {/* ── header ── */}
      <header style={{
        position:"sticky",top:0,zIndex:100,
        borderBottom:"1px solid #0d1828",
        background:"#05080fee",
        backdropFilter:"blur(12px)",
        padding:"0 32px",
        display:"flex",alignItems:"center",justifyContent:"space-between",
        height:56,
      }}>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          {/* logo mark */}
          <svg width="28" height="28" viewBox="0 0 28 28">
            <rect width="28" height="28" rx="6" fill={S.color} fillOpacity=".1"/>
            <rect x="1" y="1" width="26" height="26" rx="5" fill="none" stroke={S.color} strokeOpacity=".3" strokeWidth="1"/>
            <polyline points="4,14 8,14 10,8 12,20 14,11 16,17 18,14 24,14"
              fill="none" stroke={S.color} strokeWidth="1.5" strokeLinejoin="round"
              style={{filter:`drop-shadow(0 0 4px ${S.color})`}}/>
          </svg>
          <div>
            <div style={{fontSize:12,fontWeight:700,letterSpacing:".12em",color:"#e8f0ff"}}>HELIXMIND</div>
            <div style={{fontSize:8,color:"#2a3d55",letterSpacing:".18em"}}>CARDIAC TRIAGE SYSTEM</div>
          </div>
        </div>

        <div style={{display:"flex",alignItems:"center",gap:20}}>
          {result&&(
            <div style={{
              display:"flex",alignItems:"center",gap:8,
              padding:"5px 14px",borderRadius:6,
              background:S.bg,border:`1px solid ${S.border}`,
              fontSize:10,fontWeight:700,letterSpacing:".12em",color:S.color,
              textShadow:`0 0 12px ${S.glow}`,
            }}>
              <span style={{fontSize:8}}>{S.icon}</span>{S.label}
            </div>
          )}
          <div style={{display:"flex",alignItems:"center",gap:8,fontSize:9,color:"#2a3d55",letterSpacing:".1em"}}>
            <div style={{
              width:6,height:6,borderRadius:"50%",
              background: streaming?"#0affb2":"#111d2e",
              boxShadow: streaming?"0 0 10px #0affb2,0 0 20px #0affb244":"none",
              transition:"all .4s",
            }}/>
            {streaming?"LIVE MONITOR":"STANDBY"}
          </div>
        </div>
      </header>

      <div style={{maxWidth:1040,margin:"0 auto",padding:"28px 24px 60px",position:"relative",zIndex:1}}>

        {/* ── ECG strip ── */}
        <div style={{
          background:"#080e1a",
          border:`1px solid ${S.border}`,
          borderRadius:12,padding:"16px 20px",marginBottom:20,
          transition:"border-color .5s",
          boxShadow:`0 0 40px ${S.glow}18`,
        }}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <span style={{fontSize:9,color:"#1a2d45",letterSpacing:".16em",fontWeight:600}}>
              ECG WAVEFORM · LEAD {result?.lead_used||"II"} · 256 Hz
            </span>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              {result&&<span style={{fontSize:9,color:S.color,letterSpacing:".08em",textShadow:`0 0 8px ${S.glow}`}}>
                {result.rhythm_label}
              </span>}
              {streaming&&<span style={{
                fontSize:8,color:"#0affb2",letterSpacing:".14em",
                animation:"pulse 1.5s ease-in-out infinite",
              }}>● REC</span>}
            </div>
          </div>
          <ECGCanvas data={ecgSig} running={streaming} sev={sev}/>
        </div>

        {/* ── tabs ── */}
        <div style={{display:"flex",gap:8,marginBottom:20}}>
          <Tab label="SYNTHETIC DEMO" active={tab==="demo"}  onClick={()=>setTab("demo")}/>
          <Tab label="PTB-XL WFDB"   active={tab==="wfdb"}  onClick={()=>setTab("wfdb")}
            dot={!datFile&&tab!=="wfdb"}/>
        </div>

        {/* ── demo controls ── */}
        {tab==="demo"&&(
          <div style={{
            background:"#080e1a",border:"1px solid #111d2e",
            borderRadius:10,padding:"18px 20px",marginBottom:20,
            display:"grid",gridTemplateColumns:"1fr 1fr 1fr auto auto",gap:12,alignItems:"end",
          }}>
            <div>
              <div style={{fontSize:9,color:"#1a2d45",letterSpacing:".14em",marginBottom:6,fontWeight:600}}>DEVICE</div>
              <select value={device} onChange={e=>setDevice(e.target.value)} style={sel}>
                {DEVICES.map(d=><option key={d} value={d}>{d.replace(/_/g," ")}</option>)}
              </select>
            </div>
            <div>
              <div style={{fontSize:9,color:"#1a2d45",letterSpacing:".14em",marginBottom:6,fontWeight:600}}>SCENARIO</div>
              <select value={scenario} onChange={e=>setScenario(e.target.value)} style={sel}>
                {SCENARIOS.map(s=><option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div/>
            <button onClick={runDemo} disabled={loading||streaming} style={{
              padding:"10px 22px",borderRadius:8,fontSize:10,fontWeight:700,
              letterSpacing:".1em",border:"1px solid #4d9fff40",
              background: loading||streaming?"#080e1a":"#4d9fff14",
              color:"#4d9fff",cursor:loading||streaming?"not-allowed":"pointer",
              fontFamily:"inherit",transition:"all .2s",
              textShadow: loading?"none":"0 0 12px #4d9fff66",
            }}>{loading?"RUNNING…":"RUN ONCE"}</button>
            <button onClick={toggleStream} style={{
              padding:"10px 22px",borderRadius:8,fontSize:10,fontWeight:700,
              letterSpacing:".1em",
              border:`1px solid ${streaming?"#ff3c5f40":"#0affb230"}`,
              background: streaming?"#ff3c5f14":"#0affb214",
              color: streaming?"#ff3c5f":"#0affb2",
              cursor:"pointer",fontFamily:"inherit",transition:"all .2s",
              textShadow: streaming?"0 0 12px #ff3c5f66":"0 0 12px #0affb266",
            }}>{streaming?"■ STOP":"▶ STREAM"}</button>
          </div>
        )}

        {/* ── WFDB upload ── */}
        {tab==="wfdb"&&(
          <div style={{
            background:"#080e1a",border:"1px solid #111d2e",
            borderRadius:10,padding:"20px 22px",marginBottom:20,
          }}>
            <div style={{fontSize:9,color:"#1a2d45",letterSpacing:".16em",marginBottom:16,fontWeight:600}}>
              PTB-XL WFDB RECORD — UPLOAD .DAT + .HEA PAIR
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr auto",gap:12,alignItems:"end"}}>

              {[["DAT FILE", ".dat", datFile, setDatFile],
                ["HEA FILE", ".hea", heaFile, setHeaFile]].map(([lbl,ext,f,setF])=>(
                <div key={ext}>
                  <div style={{fontSize:9,color:"#1a2d45",letterSpacing:".12em",marginBottom:6,fontWeight:600}}>{lbl}</div>
                  <label style={{
                    display:"flex",alignItems:"center",gap:8,
                    background:"#05080f",border:`1px dashed ${f?"#0affb250":"#111d2e"}`,
                    borderRadius:8,padding:"9px 12px",cursor:"pointer",
                    fontSize:10,color:f?"#0affb2":"#2a3d55",transition:"all .2s",
                  }}>
                    <span>{f?"✓":"+"}</span>
                    <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:100}}>
                      {f?f.name:`choose ${ext}`}
                    </span>
                    <input type="file" accept={ext} style={{display:"none"}}
                      onChange={e=>setF(e.target.files[0]||null)}/>
                  </label>
                </div>
              ))}

              <div>
                <div style={{fontSize:9,color:"#1a2d45",letterSpacing:".12em",marginBottom:6,fontWeight:600}}>LEAD</div>
                <select value={lead} onChange={e=>setLead(e.target.value)} style={sel}>
                  {LEADS.map(l=><option key={l} value={l}>{l}</option>)}
                </select>
              </div>
              <div>
                <div style={{fontSize:9,color:"#1a2d45",letterSpacing:".12em",marginBottom:6,fontWeight:600}}>LABEL</div>
                <select value={ptbLabel} onChange={e=>setPtbLabel(e.target.value)} style={sel}>
                  {SCENARIOS.map(s=><option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <div style={{fontSize:9,color:"#1a2d45",letterSpacing:".12em",marginBottom:6,fontWeight:600}}>DEVICE</div>
                <select value={device} onChange={e=>setDevice(e.target.value)} style={sel}>
                  {DEVICES.map(d=><option key={d} value={d}>{d.replace(/_/g," ")}</option>)}
                </select>
              </div>

              <button onClick={runWfdb} disabled={!datFile||!heaFile||loading} style={{
                padding:"10px 22px",borderRadius:8,fontSize:10,fontWeight:700,
                letterSpacing:".1em",border:"1px solid #0affb230",
                background:!datFile||!heaFile||loading?"#080e1a":"#0affb214",
                color:"#0affb2",cursor:!datFile||!heaFile||loading?"not-allowed":"pointer",
                fontFamily:"inherit",textShadow:"0 0 12px #0affb266",
              }}>{loading?"…":"ANALYSE"}</button>
            </div>

            {result?.all_leads&&(
              <div style={{marginTop:14,fontSize:9,color:"#1a2d45",letterSpacing:".08em"}}>
                AVAILABLE LEADS: {result.all_leads.join(" · ")} · SOURCE: {result.source_fs} Hz
              </div>
            )}
          </div>
        )}

        {/* ── error ── */}
        {error&&(
          <div style={{
            background:"#ff3c5f0a",border:"1px solid #ff3c5f40",borderRadius:8,
            padding:"12px 16px",marginBottom:18,fontSize:11,color:"#ff3c5f",
            display:"flex",gap:10,alignItems:"center",
          }}>
            <span style={{fontSize:14}}>⚠</span>
            <span>{error} — is the backend running at <code style={{opacity:.7}}>{API_BASE}</code>?</span>
          </div>
        )}

        {/* ── results ── */}
        {result&&(<>

          {/* escalation alert */}
          {result.requires_escalation&&(
            <div style={{
              background:"#ff3c5f0a",border:"1px solid #ff3c5f60",borderRadius:10,
              padding:"16px 20px",marginBottom:18,
              display:"flex",gap:14,alignItems:"flex-start",
              boxShadow:"0 0 30px #ff3c5f18",
              animation:"fadeIn .4s ease",
            }}>
              <div style={{
                width:36,height:36,borderRadius:8,
                background:"#ff3c5f18",border:"1px solid #ff3c5f40",
                display:"flex",alignItems:"center",justifyContent:"center",
                fontSize:16,color:"#ff3c5f",flexShrink:0,
              }}>■</div>
              <div>
                <div style={{fontSize:11,fontWeight:700,color:"#ff3c5f",letterSpacing:".1em",marginBottom:4}}>
                  EMERGENCY ESCALATION TRIGGERED
                </div>
                <div style={{fontSize:11,color:"#ff8090",lineHeight:1.6}}>{result.escalation_reason}</div>
              </div>
            </div>
          )}

          {/* vitals */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:12}}>
            <Metric label="HEART RATE" value={Math.round(result.heart_rate)} unit="bpm"
              trend={hist.hr} color={S.color}
              warn={result.heart_rate<50||result.heart_rate>130}/>
            <Metric label="SpO₂" value={result.spo2.toFixed(1)} unit="%"
              sub={result.spo2<95?"below threshold ⚠":"within range"}
              trend={hist.spo2} color="#4d9fff" warn={result.spo2<95}/>
            <Metric label="HRV RMSSD" value={result.hrv_rmssd.toFixed(1)} unit="ms"
              sub={result.hrv_rmssd<20?"low autonomic tone":""} warn={result.hrv_rmssd<20}/>
            <Metric label="SEVERITY INDEX" value={(result.severity_score*100).toFixed(0)} unit="/100"
              trend={hist.score} color={S.color} warn={sev!=="GREEN"}/>
          </div>

          {/* bottom panels */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>

            {/* rhythm */}
            <div style={{background:"#080e1a",border:"1px solid #111d2e",borderRadius:10,padding:"18px 20px"}}>
              <div style={{fontSize:9,color:"#1a2d45",letterSpacing:".16em",marginBottom:16,fontWeight:600}}>
                RHYTHM CLASSIFICATION
              </div>
              {Object.entries(result.rhythm_probs).map(([l,p])=>(
                <RhBar key={l} label={l} prob={p} active={l===result.rhythm_label} accentColor={S.color}/>
              ))}
              <div style={{
                marginTop:14,paddingTop:14,borderTop:"1px solid #0d1828",
                display:"flex",justifyContent:"space-between",fontSize:10,
              }}>
                <span style={{color:"#1a2d45"}}>
                  RHYTHM: <span style={{color:S.color,fontWeight:700}}>{result.rhythm_label}</span>
                </span>
                <span style={{color:"#1a2d45"}}>
                  STRESS: <span style={{
                    color: result.stress_level==="High"?"#ffe066":result.stress_level==="Medium"?"#ff9944":"#0affb2",
                    fontWeight:700,
                  }}>{result.stress_level.toUpperCase()}</span>
                </span>
              </div>
            </div>

            {/* summary */}
            <div style={{background:"#080e1a",border:"1px solid #111d2e",borderRadius:10,padding:"18px 20px"}}>
              <div style={{fontSize:9,color:"#1a2d45",letterSpacing:".16em",marginBottom:16,fontWeight:600}}>
                TRIAGE DECISION
              </div>

              <div style={{
                display:"flex",alignItems:"center",gap:14,marginBottom:18,
                padding:"14px 16px",borderRadius:8,
                background:S.bg,border:`1px solid ${S.border}`,
              }}>
                <div style={{
                  width:44,height:44,borderRadius:8,
                  background:S.bg,border:`1px solid ${S.border}`,
                  display:"flex",alignItems:"center",justifyContent:"center",
                  fontSize:20,color:S.color,
                  textShadow:`0 0 16px ${S.glow}`,
                  flexShrink:0,
                }}>{S.icon}</div>
                <div>
                  <div style={{fontSize:20,fontWeight:700,color:S.color,letterSpacing:".04em",textShadow:`0 0 20px ${S.glow}`}}>
                    {sev}
                  </div>
                  <div style={{fontSize:10,color:"#2a3d55",marginTop:2,lineHeight:1.5}}>
                    {sev==="GREEN" &&"All vitals within normal parameters"}
                    {sev==="YELLOW"&&"Anomaly detected — recommend clinical review"}
                    {sev==="RED"   &&"Critical — emergency protocol initiated"}
                  </div>
                </div>
              </div>

              <div style={{display:"flex",flexDirection:"column",gap:7}}>
                {[
                  ["SOURCE",    result.ptbxl_label?`PTB-XL · ${result.ptbxl_label}`:result.demo_scenario?`DEMO · ${result.demo_scenario}`:"LIVE"],
                  ["DEVICE",    device.replace(/_/g," ").toUpperCase()],
                  ["TIMESTAMP", result.timestamp],
                  ["ECG QUAL.", result.quality_flags?.ecg||"—"],
                  ["PPG QUAL.", result.quality_flags?.ppg||"—"],
                ].map(([k,v])=>(
                  <div key={k} style={{display:"flex",justifyContent:"space-between",fontSize:10}}>
                    <span style={{color:"#1a2d45",letterSpacing:".08em"}}>{k}</span>
                    <span style={{color:"#2a3d55",maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",textAlign:"right"}}>
                      {v}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>)}

        {!result&&!loading&&(
          <div style={{
            textAlign:"center",padding:"80px 0",
            color:"#111d2e",fontSize:11,letterSpacing:".18em",
          }}>
            SELECT A SCENARIO AND RUN ·  OR UPLOAD A PTB-XL RECORD
          </div>
        )}
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap');
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
        body{background:#05080f;}
        select option{background:#080e1a;}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:#05080f}
        ::-webkit-scrollbar-thumb{background:#111d2e;border-radius:2px}
      `}</style>
    </div>
  );
}
