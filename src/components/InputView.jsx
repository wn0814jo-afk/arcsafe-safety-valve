//  PARAMETER DECISION VIEW (구 InputView)
//  역할: "값 입력" → "사양 결정"
// ════════════════════════════════════════════════════════════════

// ── 결정 슬라이더 (수치 입력이 필요한 파라미터용) ────────────
function DecisionSlider({ param, label, unit, value, min, max, step, onChange, basis, warning }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{background:T.bg,borderRadius:12,padding:"12px 14px",marginBottom:10,border:`1.5px solid ${open?T.blue:T.border}`,transition:"border-color 0.15s"}}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:8,marginBottom:8}}>
        <div>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <span style={{fontSize:10,fontWeight:700,color:T.sub,fontFamily:font.mono,letterSpacing:0.5}}>{param}</span>
            {warning && <span style={{fontSize:9,background:T.yellowBg,color:"#7A5800",border:`1px solid ${T.yellow}`,borderRadius:5,padding:"1px 6px",fontFamily:font.mono,fontWeight:700}}>{warning}</span>}
          </div>
          <div style={{fontSize:13,fontWeight:900,color:T.navy,fontFamily:font.sans,marginTop:1}}>{label}</div>
        </div>
        <div style={{textAlign:"right",flexShrink:0}}>
          <div style={{fontSize:20,fontWeight:900,color:T.navyLight,fontFamily:font.mono,lineHeight:1}}>{Number(value).toFixed(step<1?1:0)}</div>
          <div style={{fontSize:10,color:T.sub,fontFamily:font.mono}}>{unit}</div>
        </div>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e=>onChange(+e.target.value)}
        style={{width:"100%",accentColor:T.navyLight,cursor:"pointer",marginBottom:4}}/>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
        <span style={{fontSize:9,color:T.gray,fontFamily:font.mono}}>{min} {unit}</span>
        <span style={{fontSize:9,color:T.gray,fontFamily:font.mono}}>{max} {unit}</span>
      </div>
      <button onClick={()=>setOpen(o=>!o)} style={{background:"none",border:"none",cursor:"pointer",padding:0,fontSize:10,color:T.blue,fontFamily:font.sans,fontWeight:700,display:"flex",alignItems:"center",gap:3}}>
        {open?"▲ 적용 근거 닫기":"▼ 이 값을 왜 쓰는가?"}
      </button>
      {open && (
        <div style={{marginTop:8,background:T.blueBg,borderRadius:8,padding:"8px 11px",fontSize:11,color:T.navyLight,fontFamily:font.sans,lineHeight:1.65,borderLeft:`3px solid ${T.blue}`}}>
          {basis}
        </div>
      )}
    </div>
  );
}

// ── 결정 선택 카드 (선택지가 명확한 파라미터용) ───────────────
function DecisionChoice({ param, label, options, value, onChange }) {
  const selected = options.find(o => Math.abs(o.value - value) < 0.001) ?? null;
  return (
    <div style={{background:T.bg,borderRadius:12,padding:"12px 14px",marginBottom:10,border:`1.5px solid ${selected?T.navyLight:T.border}`}}>
      <div style={{marginBottom:10}}>
        <span style={{fontSize:10,fontWeight:700,color:T.sub,fontFamily:font.mono,letterSpacing:0.5}}>{param}</span>
        <div style={{fontSize:13,fontWeight:900,color:T.navy,fontFamily:font.sans,marginTop:1}}>{label}</div>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:7}}>
        {options.map(opt=>{
          const isSelected = Math.abs(opt.value - value) < 0.001;
          return (
            <div key={opt.id} onClick={()=>onChange(opt.value)}
              style={{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 12px",borderRadius:10,cursor:"pointer",
                border:`2px solid ${isSelected?T.navyLight:T.border}`,
                background:isSelected?T.navy+"0D":T.white,
                transition:"all 0.12s"}}>
              <div style={{width:18,height:18,borderRadius:"50%",border:`2px solid ${isSelected?T.navyLight:T.border}`,background:isSelected?T.navyLight:T.white,flexShrink:0,marginTop:1,display:"flex",alignItems:"center",justifyContent:"center"}}>
                {isSelected && <div style={{width:8,height:8,borderRadius:"50%",background:T.white}}/>}
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                  <span style={{fontSize:12,fontWeight:700,color:isSelected?T.navy:T.text,fontFamily:font.sans}}>{opt.label}</span>
                  {opt.tag && <span style={{fontSize:9,padding:"2px 6px",borderRadius:5,background:isSelected?T.navyLight+"22":T.bg,color:isSelected?T.navyLight:T.sub,fontFamily:font.mono,fontWeight:700,border:`1px solid ${isSelected?T.navyLight:T.border}`}}>{opt.tag}</span>}
                  <span style={{fontSize:12,fontWeight:900,color:isSelected?T.navyLight:T.sub,fontFamily:font.mono,marginLeft:"auto"}}>{opt.value}</span>
                </div>
                <div style={{fontSize:10,color:T.sub,marginTop:3,fontFamily:font.sans,lineHeight:1.5}}>{opt.basis}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── 섹션 구분선 ──────────────────────────────────────────────
function SectionHeader({ step, title, sub }) {
  return (
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,marginTop:6}}>
      <div style={{width:24,height:24,borderRadius:"50%",background:T.navyLight,color:T.white,fontSize:11,fontWeight:900,fontFamily:font.mono,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{step}</div>
      <div>
        <div style={{fontSize:13,fontWeight:900,color:T.navy,fontFamily:font.sans}}>{title}</div>
        {sub && <div style={{fontSize:10,color:T.sub,fontFamily:font.sans}}>{sub}</div>}
      </div>
    </div>
  );
}

// ── 온도 변환 헬퍼 ───────────────────────────────────────────
function TempInput({ value, onChange }) {
  const [mode, setMode] = useState("K");
  const displayVal = mode === "K" ? value : Math.round((value - 273.15) * 10) / 10;
  const handleChange = (v) => onChange(mode === "K" ? v : Math.round((v + 273.15) * 10) / 10);
  return (
    <div style={{background:T.bg,borderRadius:12,padding:"12px 14px",marginBottom:10,border:`1.5px solid ${T.border}`}}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:8,marginBottom:8}}>
        <div>
          <span style={{fontSize:10,fontWeight:700,color:T.sub,fontFamily:font.mono,letterSpacing:0.5}}>T</span>
          <div style={{fontSize:13,fontWeight:900,color:T.navy,fontFamily:font.sans,marginTop:1}}>방출 온도</div>
          <div style={{fontSize:10,color:T.sub,fontFamily:font.sans,marginTop:2}}>정상 운전 온도가 아닌 방출 시나리오 온도</div>
        </div>
        <div style={{textAlign:"right",flexShrink:0}}>
          <div style={{fontSize:20,fontWeight:900,color:T.navyLight,fontFamily:font.mono,lineHeight:1}}>{displayVal}</div>
          <div style={{display:"flex",gap:4,marginTop:3,justifyContent:"flex-end"}}>
            {["K","C"].map(m=>(
              <button key={m} onClick={()=>setMode(m)} style={{padding:"2px 7px",borderRadius:5,border:`1px solid ${mode===m?T.navyLight:T.border}`,background:mode===m?T.navyLight:T.white,color:mode===m?T.white:T.sub,fontSize:10,fontFamily:font.mono,fontWeight:700,cursor:"pointer"}}>°{m}</button>
            ))}
          </div>
        </div>
      </div>
      <input type="range" min={mode==="K"?200:-73} max={mode==="K"?700:427} step={5} value={displayVal}
        onChange={e=>handleChange(+e.target.value)}
        style={{width:"100%",accentColor:T.navyLight,cursor:"pointer"}}/>
      <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
        <span style={{fontSize:9,color:T.gray,fontFamily:font.mono}}>{mode==="K"?"200 K":"-73 °C"}</span>
        <span style={{fontSize:9,color:T.gray,fontFamily:font.mono}}>{mode==="K"?"700 K":"427 °C"}</span>
      </div>
      <div style={{fontSize:10,color:T.sub,fontFamily:font.sans,marginTop:4}}>
        ≈ {mode==="K" ? `${Math.round((value-273.15)*10)/10} °C` : `${value} K`}
      </div>
    </div>
  );
}

// ── 유체 선택 데이터 ─────────────────────────────────────────
const FLUID_CHOICES = [
  { id:"co2",   label:"CO₂ — 이산화탄소",  M:44,  k:1.30, Kd:0.975, tag:"공정 일반",  basis:"반응기·분리 공정에서 가장 흔한 고압 방출 유체. NIST 기준 k=1.30 (25°C)." },
  { id:"n2",    label:"N₂ — 질소",         M:28,  k:1.40, Kd:0.975, tag:"불활성",     basis:"질소 블랭킷, 퍼지 라인 등 불활성 유체. k=1.40 (이상기체 근사 적용 가능)." },
  { id:"steam", label:"Steam — 수증기",     M:18,  k:1.33, Kd:0.975, tag:"포화/과열",  basis:"유틸리티 스팀 라인, 증류 재비기 등. k=1.33 (API 520 권고값)." },
  { id:"air",   label:"Air — 공기",         M:29,  k:1.40, Kd:0.975, tag:"계장/공기",  basis:"공기 공급 시스템, 계장 에어. k=1.40. 습도 영향은 무시 가능." },
  { id:"ch4",   label:"CH₄ — 메탄",        M:16,  k:1.31, Kd:0.975, tag:"탄화수소",   basis:"천연가스 주성분. 고온에서 k 변동 있으나 API 520 계산에는 상온값 적용." },
  { id:"other", label:"직접 입력",          M:null,k:null, Kd:null,  tag:"커스텀",     basis:"MSDS 또는 공정 시뮬레이터(Aspen/HYSYS) 결과값을 직접 입력." },
];

// Kd 결정 선택지
const KD_OPTIONS = [
  { id:"sv_std",  label:"스프링식 — 표준",    value:0.975, tag:"API 526",     basis:"API 526 인증 밸브 기본값. 제조사 성능시험 미제출 시 이 값 적용." },
  { id:"sv_con",  label:"스프링식 — 보수적",   value:0.900, tag:"안전 여유",   basis:"설계 여유 확보 또는 노후 밸브에 적용. 10% 여유율 내재." },
  { id:"rd",      label:"럽처디스크 병용",      value:0.877, tag:"×0.9 보정",   basis:"API 520 Annex C. Kd × 0.9 보정 자동 적용됨 (중복 설치 손실)." },
];

// Kb 참고 테이블 — 더 이상 사용자가 직접 선택하지 않음.
// engine/backpressure.js의 computeBackpressure()가 API 521 모델로 자동 계산.
// 여기 남겨두는 이유: override UI에서 구간 설명 참조용.
const KB_OPTIONS_SPRING = [
  { id:"low",  label:"배압 낮음 — 보정 없음",  value:1.00, tag:"P2/P1 < 10%",  basis:"P2/P1이 10% 미만이면 용량 감소 없음. Kb=1.0 적용. 일반 대기 방출 또는 저압 플레어." },
  { id:"mid",  label:"배압 보통 — 경미한 감소", value:0.96, tag:"10~15%",       basis:"P2/P1 10~15% 구간. API 520 Fig.31 기준 Kb≈0.96. 제조사 곡선 우선." },
  { id:"high", label:"배압 높음 — 감소 적용",   value:0.90, tag:"15~20%",       basis:"P2/P1 15~20% 구간. 스프링식 용량 10% 이상 감소. 파일럿식 전환 검토 필요." },
];

function InputView({ inputs, deviceType, onChange, onDeviceChange, onSubmit, dischargeSystem }) {
  const [fluidId, setFluidId]   = useState("co2");
  const [kdId,    setKdId]      = useState("sv_std");
  const [showCustomFluid, setShowCustomFluid] = useState(false);
  const [kbOverride, setKbOverride] = useState(false);
  const [kbOverrideReason, setKbOverrideReason] = useState("");

  // 유체 선택 → M, k, Kd 동시 결정
  const handleFluidSelect = (f) => {
    setFluidId(f.id);
    if (f.id === "other") { setShowCustomFluid(true); return; }
    setShowCustomFluid(false);
    onChange("M",  f.M);
    onChange("k",  f.k);
    onChange("Kd", f.Kd);
    // Kd 선택을 표준으로 초기화
    setKdId("sv_std");
  };

  // Kd 선택 → Kd 결정
  const handleKdSelect = (opt) => {
    setKdId(opt.id);
    onChange("Kd", opt.value);
  };

  // Kb — system 계산값 (engine의 computeBackpressure 순수함수, API 521 모델)
  // GEOMETRY-001: 배관 형상은 Case 입력값이 아니라 Asset(DischargeSystem) 데이터.
  // 임의 기본값을 몰래 대입하지 않는다 — 미연결이면 명시적으로 경고하고
  // Kb=1.0(보수적 가정)을 쓰되 그 사실을 화면에 그대로 노출한다.
  const bpResult = dischargeSystem
    ? computeBackpressure(inputs, {
        L: dischargeSystem.L, D: dischargeSystem.D,
        fittingsK: dischargeSystem.fittingsK,
        headerPressure: dischargeSystem.headerPressure,
      })
    : { valid: false, error: { field: "dischargeSystem", reason: "not_linked" } };
  const kbCalc = bpResult.valid
    ? { value: bpResult.kb, basis: bpResult.basis, status: bpResult.status }
    : dischargeSystem
    ? { value: 1.0, basis: "배관 형상 입력 오류 — 기본값 적용", status: "calculated" }
    : { value: 1.0, basis: "배출계통 미연결 — Kb=1.0 보수적 가정 (설비대장에서 연결 필요)", status: "calculated" };

  // P1/P2가 바뀌면 override 중이 아닌 한 시스템 계산값을 자동 반영
  useEffect(() => {
    if (!kbOverride) {
      onChange("Kb", kbCalc.value);
    }
  }, [inputs.P1, inputs.P2, kbOverride]);

  // 배압 비율 실시간 계산 (경고용)
  const bpRatio = inputs.P1 > 0 ? (inputs.P2 / inputs.P1 * 100).toFixed(1) : 0;
  const bpWarning = bpRatio > 30 ? "파일럿식 검토" : bpRatio > 10 ? "Kb 확인" : null;

  // 설정압 > MAWP 경고
  const mawpWarning = inputs.P1 > inputs.mawp ? "설정압 > MAWP!" : null;

  return (
    <div style={{padding:"0 2px"}}>

      {/* ── 1. 밸브 종류 결정 ── */}
      <SectionHeader step="1" title="밸브 종류" sub="설치된 밸브 또는 럽처디스크 선택"/>
      <div style={{display:"flex",gap:8,marginBottom:16}}>
        {[
          ["safetyValve","🔧 안전밸브","스프링식 또는 파일럿식. 설정압에서 개방, 이후 자동 재폐."],
          ["ruptureDisk","💥 럽처디스크","단일 작동. 파열 후 교체 필요. Kd ×0.9 보정 적용."],
        ].map(([v,l,sub])=>(
          <div key={v} onClick={()=>onDeviceChange(v)}
            style={{flex:1,padding:"12px",borderRadius:12,cursor:"pointer",
              border:`2px solid ${deviceType===v?T.navyLight:T.border}`,
              background:deviceType===v?T.navy+"0D":T.cardBg,
              transition:"all 0.15s"}}>
            <div style={{fontSize:13,fontWeight:900,color:deviceType===v?T.navy:T.text,fontFamily:font.sans}}>{l}</div>
            <div style={{fontSize:10,color:T.sub,marginTop:3,fontFamily:font.sans,lineHeight:1.4}}>{sub}</div>
          </div>
        ))}
      </div>

      {/* ── 2. 방출 시나리오 ── */}
      <SectionHeader step="2" title="방출 시나리오" sub="어떤 상황에서 밸브가 열리는가 — API 521 시나리오"/>
      <DecisionSlider
        param="W" label="설계 방출량" unit="kg/h"
        value={inputs.W} min={500} max={10000} step={100}
        onChange={v=>onChange("W",v)}
        basis="HAZOP 또는 API 521 시나리오 계산서 기반. 화재, 반응 폭주, 냉각 상실 등 최대 방출 시나리오 중 지배 케이스 적용. 설계 여유 없이 계산된 최대값 사용."
      />

      {/* ── 3. 유체 사양 결정 ── */}
      <SectionHeader step="3" title="유체 사양" sub="M, k 값은 유체 선택 시 자동 결정됨"/>
      <div style={{background:T.cardBg,borderRadius:12,padding:"12px 14px",marginBottom:10,border:`1.5px solid ${fluidId?T.navyLight:T.border}`}}>
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {FLUID_CHOICES.map(f=>{
            const isSel = fluidId === f.id;
            return (
              <div key={f.id} onClick={()=>handleFluidSelect(f)}
                style={{display:"flex",alignItems:"flex-start",gap:10,padding:"9px 11px",borderRadius:9,cursor:"pointer",
                  border:`2px solid ${isSel?T.navyLight:T.border}`,
                  background:isSel?T.navy+"0D":T.bg,
                  transition:"all 0.12s"}}>
                <div style={{width:16,height:16,borderRadius:"50%",border:`2px solid ${isSel?T.navyLight:T.border}`,background:isSel?T.navyLight:T.white,flexShrink:0,marginTop:2,display:"flex",alignItems:"center",justifyContent:"center"}}>
                  {isSel && <div style={{width:6,height:6,borderRadius:"50%",background:T.white}}/>}
                </div>
                <div style={{flex:1}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                    <span style={{fontSize:12,fontWeight:700,color:isSel?T.navy:T.text,fontFamily:font.sans}}>{f.label}</span>
                    <span style={{fontSize:9,padding:"1px 6px",borderRadius:4,background:isSel?T.navyLight+"22":T.bg,color:isSel?T.navyLight:T.sub,fontFamily:font.mono,border:`1px solid ${isSel?T.navyLight:T.border}`}}>{f.tag}</span>
                    {f.M && <span style={{fontSize:9,color:T.gray,fontFamily:font.mono,marginLeft:"auto"}}>M={f.M} k={f.k}</span>}
                  </div>
                  {isSel && <div style={{fontSize:10,color:T.sub,marginTop:3,fontFamily:font.sans,lineHeight:1.5}}>{f.basis}</div>}
                </div>
              </div>
            );
          })}
        </div>
        {/* 커스텀 유체 직접 입력 */}
        {showCustomFluid && (
          <div style={{marginTop:10,display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            {[
              {key:"M",label:"분자량 M",unit:"g/mol",min:2,max:200,step:1},
              {key:"k",label:"비열비 k",unit:"",min:1.05,max:1.7,step:0.01},
            ].map(({key,label,unit,min,max,step})=>(
              <div key={key}>
                <div style={{fontSize:10,color:T.sub,fontFamily:font.mono,marginBottom:3}}>{label}</div>
                <input type="number" value={inputs[key]} min={min} max={max} step={step}
                  onChange={e=>onChange(key,+e.target.value)}
                  style={{width:"100%",padding:"7px 9px",borderRadius:8,border:`1px solid ${T.border}`,fontSize:13,fontFamily:font.mono,fontWeight:700,color:T.navy,background:T.bg,boxSizing:"border-box"}}/>
                <div style={{fontSize:9,color:T.gray,fontFamily:font.mono,marginTop:2}}>{unit}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 온도 */}
      <TempInput value={inputs.T} onChange={v=>onChange("T",v)}/>

      {/* ── 4. 압력 조건 결정 ── */}
      <SectionHeader step="4" title="압력 조건" sub="명판 및 공정 설계 문서 기준"/>
      <DecisionSlider
        param="MAWP" label="최고허용운전압력" unit="barg"
        value={inputs.mawp} min={0.5} max={25} step={0.1}
        onChange={v=>onChange("mawp",v)}
        basis="압력용기 명판(Nameplate) 또는 배관 설계 문서에서 확인. 이 값이 밸브 설정압의 상한을 결정함. 설정압 ≤ MAWP 조건 위반 시 PSM 부적합."
      />
      <DecisionSlider
        param="P1" label="설정압력 (Set Pressure)" unit="barg"
        value={inputs.P1} min={0.5} max={inputs.mawp || 20} step={0.1}
        onChange={v=>onChange("P1",v)}
        basis="밸브 명판의 설정압. MAWP의 100% 이하 유지 (단일 밸브 기준). 공정 최고운전압력 대비 최소 10% 여유 권고 (API 521)."
        warning={mawpWarning}
      />
      {/* PRESSURE-001: overpressure는 Case 입력값이 아니라 Asset(Equipment) 데이터.
          여기서 편집하지 않고, 설비대장 값으로 산정된 relieving pressure만 보여준다. */}
      <div style={{background:T.cardBg,borderRadius:10,padding:"10px 12px",marginBottom:10,
        border:`1.5px solid ${T.border}`}}>
        <div style={{fontSize:9,color:T.gray,fontFamily:font.mono,marginBottom:3}}>
          RELIEVING PRESSURE (절대압) — 설비대장 Overpressure 기준 시스템 산정값
        </div>
        {typeof inputs.OP === "number" && !isNaN(inputs.OP) ? (
          <div style={{fontSize:13,fontWeight:900,color:T.navy,fontFamily:font.mono}}>
            {(inputs.P1 * (1 + inputs.OP/100) + 1.01325).toFixed(3)} bara
            <span style={{fontSize:10,fontWeight:600,color:T.sub,marginLeft:8}}>
              = {inputs.P1}×(1+{inputs.OP}%) + 1.01325
            </span>
          </div>
        ) : (
          <div style={{fontSize:11,fontWeight:700,color:T.red,fontFamily:font.sans}}>
            ⚠ 설비대장에 Overpressure(%) 미설정 — 계산 불가. 설비대장에서 값을 먼저 입력하세요.
          </div>
        )}
      </div>
      <DecisionSlider
        param="P2" label="배압 (Back Pressure)" unit="barg"
        value={inputs.P2} min={0} max={5} step={0.05}
        onChange={v=>onChange("P2",v)}
        basis={`플레어 헤더 또는 방출 배관 압력. 현재 P2/P1 = ${bpRatio}%.${bpRatio>10?" 10% 초과 → Kb 1.0 미만 적용 필요.":""}${bpRatio>30?" 30% 초과 → 스프링식 부적합, 파일럿식 전환 검토.":""}`}
        warning={bpWarning}
      />
      {/* COMPRESSIBILITY-001: Z는 Asset이 아니라 Calculation Input —
          설비 속성이 아니라 유체·운전조건에 따라 케이스마다 달라지므로
          Case가 직접 소유하고 편집 가능해야 한다 (OP와는 반대). */}
      <DecisionSlider
        param="Z" label="압축계수 (Compressibility Z)" unit=""
        value={inputs.Z} min={0.5} max={1.2} step={0.01}
        onChange={v=>onChange("Z",v)}
        basis="실측 P-V-T 데이터 또는 상태방정식(SRK, PR 등)에서 산정. 기본값 1.00은 이상기체 가정 — 고압·저온 조건에서 실제 유체는 1.00과 벗어날 수 있으며, 벗어날수록 소요 면적 산정 오차가 커진다."
      />

      {/* ── 5. 방출계수 결정 ── */}
      <SectionHeader step="5" title="방출계수 Kd" sub="어떤 근거로 이 계수를 적용하는가"/>
      <DecisionChoice
        param="Kd" label="방출계수 선택"
        options={KD_OPTIONS}
        value={inputs.Kd}
        onChange={v=>{ const opt=KD_OPTIONS.find(o=>Math.abs(o.value-v)<0.001); if(opt) handleKdSelect(opt); }}
      />
      {/* Kd 커스텀 슬라이더 (미세 조정용, 접혀 있음) */}
      <details style={{marginBottom:10}}>
        <summary style={{fontSize:10,color:T.sub,fontFamily:font.mono,cursor:"pointer",padding:"4px 2px"}}>제조사 실측값 직접 입력</summary>
        <div style={{marginTop:6,padding:"10px 12px",background:T.bg,borderRadius:9,border:`1px solid ${T.border}`}}>
          <input type="range" min={0.5} max={1.0} step={0.005} value={inputs.Kd}
            onChange={e=>onChange("Kd",+e.target.value)}
            style={{width:"100%",accentColor:T.navyLight}}/>
          <div style={{textAlign:"center",fontSize:12,fontFamily:font.mono,fontWeight:700,color:T.navyLight,marginTop:4}}>{inputs.Kd.toFixed(3)}</div>
        </div>
      </details>

      {/* ── 6. 배압보정계수 — 시스템 계산값 (사용자 직접 선택 금지) ── */}
      <SectionHeader step="6" title="배압보정계수 Kb" sub="P1, P2로부터 시스템이 계산 — 직접 선택 불가"/>
      <div style={{
        background: kbCalc.status==="out_of_range" ? T.redBg : T.bg,
        borderRadius:12, padding:"14px 16px", marginBottom:10,
        border:`1.5px solid ${kbCalc.status==="out_of_range" ? T.red : T.border}`}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <span style={{fontSize:10,fontWeight:700,color:T.sub,fontFamily:font.mono}}>Kb</span>
            <span style={{fontSize:9,padding:"2px 7px",borderRadius:5,
              background: kbOverride ? T.orangeBg : T.greenBg,
              color: kbOverride ? "#946200" : T.greenDk,
              border:`1px solid ${kbOverride ? T.orange : T.green}`,
              fontFamily:font.mono,fontWeight:700}}>
              {kbOverride ? "ENGINEER OVERRIDE" : "SYSTEM CALCULATED"}
            </span>
          </div>
          <div style={{fontSize:22,fontWeight:900,color:T.navyLight,fontFamily:font.mono}}>
            {Number(inputs.Kb).toFixed(3)}
          </div>
        </div>
        <div style={{fontSize:11,color:T.sub,fontFamily:font.sans,lineHeight:1.6,marginBottom:10}}>
          {kbOverride
            ? "엔지니어 override 적용 중 — 아래 근거를 반드시 기록하세요."
            : kbCalc.basis}
        </div>
        {kbCalc.status==="out_of_range" && !kbOverride && (
          <div style={{fontSize:11,color:T.red,fontFamily:font.sans,fontWeight:700,marginBottom:10}}>
            ⚠ 표준 곡선 범위 초과 — 제조사 데이터 확인 후 override 필요
          </div>
        )}

        {!kbOverride ? (
          <button onClick={()=>setKbOverride(true)}
            style={{fontSize:10,color:T.sub,background:"none",border:`1px dashed ${T.border}`,
              borderRadius:7,padding:"6px 10px",cursor:"pointer",fontFamily:font.mono}}>
            제조사 곡선값으로 override (근거 기록 필요)
          </button>
        ) : (
          <div>
            <input type="range" min={0.5} max={1.0} step={0.005} value={inputs.Kb}
              onChange={e=>onChange("Kb",+e.target.value)}
              style={{width:"100%",accentColor:T.orange,marginBottom:8}}/>
            <textarea
              value={kbOverrideReason}
              onChange={e=>setKbOverrideReason(e.target.value)}
              placeholder="override 근거 필수 — 예: 제조사 Kb 곡선 Doc.No.XXX 기준 0.88 적용"
              rows={2}
              style={{width:"100%",borderRadius:8,border:`1.5px solid ${kbOverrideReason.trim()?T.orange:T.red}`,
                padding:"8px 10px",fontSize:11,fontFamily:font.sans,color:T.text,
                resize:"none",boxSizing:"border-box",background:T.white,outline:"none",marginBottom:8}}
            />
            <button onClick={()=>{ setKbOverride(false); setKbOverrideReason(""); }}
              style={{fontSize:10,color:T.sub,background:"none",border:`1px solid ${T.border}`,
                borderRadius:7,padding:"6px 10px",cursor:"pointer",fontFamily:font.mono}}>
              시스템 계산값으로 복귀
            </button>
          </div>
        )}
      </div>

      {/* ── 결정 요약 ── */}
      <div style={{background:T.navy,borderRadius:14,padding:"14px 16px",marginBottom:14}}>
        <div style={{fontSize:10,fontWeight:700,color:"#7B9EC0",fontFamily:font.mono,marginBottom:8,letterSpacing:1}}>사양 결정 요약</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
          {[
            ["W", `${inputs.W} kg/h`],
            ["P1/MAWP", `${inputs.P1}/${inputs.mawp} b`],
            ["P2", `${inputs.P2} barg`],
            ["M / k", `${inputs.M} / ${inputs.k}`],
            ["Kd", inputs.Kd.toFixed(3)],
            ["Kb", inputs.Kb.toFixed(2)],
          ].map(([k,v])=>(
            <div key={k} style={{background:"#FFFFFF12",borderRadius:8,padding:"6px 8px",textAlign:"center"}}>
              <div style={{fontSize:9,color:"#7B9EC0",fontFamily:font.mono}}>{k}</div>
              <div style={{fontSize:12,fontWeight:900,color:T.white,fontFamily:font.mono}}>{v}</div>
            </div>
          ))}
        </div>
        {mawpWarning && (
          <div style={{marginTop:10,background:T.redBg,border:`1px solid ${T.red}`,borderRadius:8,padding:"7px 10px",fontSize:11,color:T.red,fontFamily:font.sans,fontWeight:700}}>
            ⚠ 설정압력({inputs.P1} barg)이 MAWP({inputs.mawp} barg)를 초과합니다. 계산 전 수정 필요.
          </div>
        )}
      </div>

      {(() => {
        const blockReason = mawpWarning
          ? "⚠ 설정압 오류 — 수정 후 진행 가능"
          : (kbOverride && !kbOverrideReason.trim())
          ? "⚠ Kb override 근거를 입력해야 진행 가능"
          : null;
        return (
          <button onClick={onSubmit} disabled={!!blockReason}
            style={{width:"100%",padding:"16px",background:blockReason?T.border:T.navyLight,color:T.white,border:"none",borderRadius:14,fontSize:15,fontWeight:900,fontFamily:font.sans,cursor:blockReason?"not-allowed":"pointer",boxShadow:blockReason?"none":`0 5px 0 ${T.navy}`,transition:"all 0.15s",letterSpacing:0.5}}>
            {blockReason || "사양 확정 → 계산 실행"}
          </button>
        );
      })()}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
