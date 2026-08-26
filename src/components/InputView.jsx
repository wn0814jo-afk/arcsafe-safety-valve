//  PARAMETER DECISION VIEW (구 InputView)
//  역할: "값 입력" → "사양 결정"
// ════════════════════════════════════════════════════════════════

// ── RELIEF LOAD — 숫자 입력 필드 (Engine 계약과 동일한 undefined/number만 전달) ──
// UI는 계산하지 않는다는 원칙에 따라, 여기서 하는 일은 "빈 문자열→undefined,
// 그 외→Number()"인 입력 마셜링뿐이다 — 검증/판정은 전부 relief_load.js의
// calculate*Scenario()가 한다. 0이 유효한 필드는 0을 그대로 통과시키고,
// 숫자가 아닌 값은 여기서 임의로 고치지 않고 그대로 Number()에 흘려보내
// (NaN이 되면) Engine이 스스로 거부하게 한다 — UI가 검증 로직을 복제하지 않음.
function ScenarioNumberField({ label, unit, value, onChange, placeholder }) {
  return (
    <div style={{marginBottom:8}}>
      <div style={{fontSize:10,color:T.sub,fontFamily:font.mono,marginBottom:3}}>{label}{unit?` (${unit})`:""}</div>
      <input type="number"
        value={value === undefined ? "" : value}
        placeholder={placeholder || "값 입력"}
        onChange={e => {
          const v = e.target.value;
          onChange(v === "" ? undefined : +v);
        }}
        style={{width:"100%",padding:"9px 11px",borderRadius:9,border:`1.5px solid ${T.border}`,
          fontSize:13,fontFamily:font.mono,fontWeight:700,color:T.navy,background:T.white,boxSizing:"border-box"}}/>
    </div>
  );
}

// ── RELIEF LOAD — enum 토글(phase, failureMode 등) ──
function ScenarioEnumToggle({ label, options, value, onChange }) {
  return (
    <div style={{marginBottom:10}}>
      <div style={{fontSize:10,color:T.sub,fontFamily:font.mono,marginBottom:5}}>{label}</div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
        {options.map(({id,label:optLabel})=>(
          <div key={id} onClick={()=>onChange(id)}
            style={{flex:"1 1 auto",minWidth:90,padding:"9px 10px",borderRadius:9,cursor:"pointer",textAlign:"center",
              border:`2px solid ${value===id?T.navyLight:T.border}`,
              background:value===id?T.navy+"0D":T.white,
              fontSize:11,fontWeight:700,color:value===id?T.navy:T.text,fontFamily:font.sans}}>
            {optLabel}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── RELIEF LOAD — 시나리오별 원시 입력 폼 ──
// 각 시나리오는 조건부 필드만 보여준다(원문에 없는 필드를 요구하지 않음).
function ReliefLoadScenarioInputForm({ scenarioType, scenarioInput, onFieldChange }) {
  if (scenarioType === "OUTLET_BLOCKED") {
    return (
      <div>
        <ScenarioEnumToggle label="PHASE" value={scenarioInput.phase}
          onChange={v=>onFieldChange("phase",v)}
          options={[{id:"LIQUID",label:"액체(Liquid)"},{id:"VAPOR",label:"증기(Vapor)"}]}/>
        <ScenarioNumberField label="최대 유입량 (Inflow)" unit="kg/h"
          value={scenarioInput.inflow_kgh} onChange={v=>onFieldChange("inflow_kgh",v)}/>
        {scenarioInput.phase === "VAPOR" && (
          <ScenarioNumberField label="생성량 (Generation Rate)" unit="kg/h"
            value={scenarioInput.generationRate_kgh} onChange={v=>onFieldChange("generationRate_kgh",v)}/>
        )}
      </div>
    );
  }
  if (scenarioType === "OVERFILLING") {
    return (
      <ScenarioNumberField label="최대 유입량 (Inflow)" unit="kg/h"
        value={scenarioInput.inflow_kgh} onChange={v=>onFieldChange("inflow_kgh",v)}/>
    );
  }
  if (scenarioType === "CONTROL_VALVE_FAIL") {
    const mode = scenarioInput.failureMode;
    return (
      <div>
        <ScenarioEnumToggle label="FAILURE MODE" value={mode}
          onChange={v=>onFieldChange("failureMode",v)}
          options={[
            {id:"INLET_VALVE",  label:"인입 밸브 고장"},
            {id:"OUTLET_VALVE", label:"출구 밸브 고장"},
            {id:"FAIL_STATIONARY", label:"Fail-stationary"},
          ]}/>
        {(mode === "INLET_VALVE" || mode === "OUTLET_VALVE") && (
          <div>
            <ScenarioNumberField label="유입량 (Inflow)" unit="kg/h"
              value={scenarioInput.inflow_kgh} onChange={v=>onFieldChange("inflow_kgh",v)}/>
            <ScenarioNumberField label="유출량 (Outflow)" unit="kg/h"
              value={scenarioInput.outflow_kgh} onChange={v=>onFieldChange("outflow_kgh",v)}/>
          </div>
        )}
        {mode === "FAIL_STATIONARY" && (
          <div>
            <ScenarioNumberField label="유입량 (Inflow)" unit="kg/h"
              value={scenarioInput.inflow_kgh} onChange={v=>onFieldChange("inflow_kgh",v)}/>
            <ScenarioNumberField label="개방 가정 유출량 (Open Outflow)" unit="kg/h"
              value={scenarioInput.openOutflow_kgh} onChange={v=>onFieldChange("openOutflow_kgh",v)}/>
            <ScenarioNumberField label="폐쇄 가정 유출량 (Closed Outflow)" unit="kg/h"
              value={scenarioInput.closedOutflow_kgh} onChange={v=>onFieldChange("closedOutflow_kgh",v)}/>
          </div>
        )}
      </div>
    );
  }
  if (scenarioType === "ABNORMAL_HEAT_VAPOR") {
    const mode = scenarioInput.failureMode;
    return (
      <div>
        <ScenarioEnumToggle label="FAILURE MODE" value={mode}
          onChange={v=>onFieldChange("failureMode",v)}
          options={[
            {id:"ABNORMAL_HEAT_INPUT",       label:"비정상 열 입력"},
            {id:"INADVERTENT_VALVE_OPENING", label:"부주의한 밸브 개방"},
            {id:"CHECK_VALVE_FAILURE",       label:"체크밸브 고장"},
          ]}/>
        {mode === "ABNORMAL_HEAT_INPUT" && (
          <div>
            <ScenarioNumberField label="증기 발생량 (Vapor Generation)" unit="kg/h"
              value={scenarioInput.vaporGeneration_kgh} onChange={v=>onFieldChange("vaporGeneration_kgh",v)}/>
            <ScenarioNumberField label="정상 유출량 (Outflow)" unit="kg/h"
              value={scenarioInput.outflow_kgh} onChange={v=>onFieldChange("outflow_kgh",v)}/>
          </div>
        )}
        {mode === "INADVERTENT_VALVE_OPENING" && (
          <div>
            <ScenarioNumberField label="유입량 (Inflow)" unit="kg/h"
              value={scenarioInput.inflow_kgh} onChange={v=>onFieldChange("inflow_kgh",v)}/>
            <ScenarioNumberField label="유출량 (Outflow, 0 허용 — 차감 없음)" unit="kg/h"
              value={scenarioInput.outflow_kgh} onChange={v=>onFieldChange("outflow_kgh",v)}/>
          </div>
        )}
        {mode === "CHECK_VALVE_FAILURE" && (
          <div style={{background:T.orangeBg,border:`1.5px solid ${T.orange}`,borderRadius:10,
            padding:"10px 12px",fontSize:11,color:"#7A4F00",fontFamily:font.sans,lineHeight:1.6}}>
            KOSHA D-18-2020 §5.8(3): 역류 상황 및 역류량 추정 기법 선정은 사용자가 결정해야 합니다 —
            원문에 계산식이 없어 이 앱은 자동으로 산정하지 않습니다. 별도 공학적 판단이 필요합니다.
          </div>
        )}
      </div>
    );
  }
  return null;
}

// ── RELIEF LOAD — 시나리오 계산 결과 패널 ──
function ReliefLoadScenarioResultPanel({ result, adapter }) {
  if (!result) return null;
  if (result.status === "NEEDS_ENGINEERING_DECISION") {
    return (
      <div style={{background:T.orangeBg,border:`1.5px solid ${T.orange}`,borderRadius:10,
        padding:"10px 12px",marginTop:8,fontSize:11,color:"#7A4F00",fontFamily:font.sans,lineHeight:1.6}}>
        <div style={{fontWeight:900,marginBottom:3}}>NEEDS_ENGINEERING_DECISION</div>
        {result.reason}
      </div>
    );
  }
  if (result.status === "INSUFFICIENT_INPUT") {
    return (
      <div style={{background:T.bg,border:`1.5px dashed ${T.border}`,borderRadius:10,
        padding:"10px 12px",marginTop:8,fontSize:11,color:T.sub,fontFamily:font.sans}}>
        입력을 완료하면 결과가 표시됩니다{result.reason ? ` (${result.reason})` : ""}.
      </div>
    );
  }
  if (result.status === "OK") {
    const isGoverning = adapter?.valid === true;
    return (
      <div style={{background: isGoverning ? T.greenBg : T.bg,
        border:`1.5px solid ${isGoverning ? T.greenDk : T.border}`,borderRadius:12,
        padding:"12px 14px",marginTop:8}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
          <span style={{fontSize:10,fontWeight:700,color:T.sub,fontFamily:font.mono,letterSpacing:0.5}}>SCENARIO RESULT</span>
          {isGoverning && (
            <span style={{fontSize:9,padding:"2px 8px",borderRadius:6,background:T.greenDk,color:T.white,
              fontFamily:font.mono,fontWeight:700}}>GOVERNING RELIEF LOAD</span>
          )}
        </div>
        <div style={{fontSize:22,fontWeight:900,color:T.navy,fontFamily:font.mono}}>
          {result.W.toLocaleString(undefined,{maximumFractionDigits:1})} <span style={{fontSize:13,color:T.sub}}>kg/h</span>
        </div>
        <div style={{fontSize:10,color:T.sub,fontFamily:font.sans,marginTop:6,lineHeight:1.6}}>{result.formula}</div>
      </div>
    );
  }
  return null;
}

// ── RELIEF LOAD — 시나리오 선택 + 입력 + 결과 통합 섹션 ──
function ReliefLoadScenarioSection({
  scenarioType, scenarioInput, scenarioResult, adapter,
  onScenarioTypeChange, onFieldChange,
}) {
  const SCENARIOS = [
    { id:"OUTLET_BLOCKED",     label:"출구 차단",          tag:"§5.1" },
    { id:"OVERFILLING",         label:"과충전",              tag:"§5.6" },
    { id:"CONTROL_VALVE_FAIL",  label:"자동제어밸브 고장",   tag:"§5.7" },
    { id:"ABNORMAL_HEAT_VAPOR", label:"비정상 열/증기 유입", tag:"§5.8" },
  ];
  return (
    <div style={{background:T.cardBg,borderRadius:14,padding:14,marginBottom:10,border:`1.5px solid ${T.border}`}}>
      <div style={{fontSize:12,fontWeight:900,color:T.navy,fontFamily:font.sans,marginBottom:3}}>Relief Load — §5 시나리오 기반 산정</div>
      <div style={{fontSize:10,color:T.sub,fontFamily:font.sans,marginBottom:10,lineHeight:1.5}}>
        KOSHA D-18-2020 §5 산정 시나리오를 입력하면 소요분출량(W)을 자동으로 산정합니다.
        선택하지 않으면 위의 설계 방출량(Manual W)이 그대로 사용됩니다.
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
        {SCENARIOS.map(s=>(
          <div key={s.id} onClick={()=>onScenarioTypeChange(s.id)}
            style={{padding:"10px 11px",borderRadius:10,cursor:"pointer",
              border:`2px solid ${scenarioType===s.id?T.navyLight:T.border}`,
              background:scenarioType===s.id?T.navy+"0D":T.white}}>
            <div style={{fontSize:9,color:T.sub,fontFamily:font.mono,marginBottom:2}}>{s.tag}</div>
            <div style={{fontSize:11,fontWeight:700,color:scenarioType===s.id?T.navy:T.text,fontFamily:font.sans}}>{s.label}</div>
          </div>
        ))}
      </div>
      {scenarioType !== null && (
        <button onClick={()=>onScenarioTypeChange(null)}
          style={{fontSize:10,color:T.sub,background:"none",border:`1px dashed ${T.border}`,
            borderRadius:7,padding:"5px 10px",cursor:"pointer",fontFamily:font.mono,marginBottom:10}}>
          시나리오 사용 안 함 → Manual W로 복귀
        </button>
      )}

      {scenarioType !== null && (
        <div style={{background:T.bg,borderRadius:10,padding:"10px 12px",border:`1px solid ${T.border}`}}>
          <ReliefLoadScenarioInputForm scenarioType={scenarioType} scenarioInput={scenarioInput} onFieldChange={onFieldChange}/>
          <ReliefLoadScenarioResultPanel result={scenarioResult} adapter={adapter}/>
        </div>
      )}
    </div>
  );
}

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

// §5.x 시나리오 id → Report에 노출할 근거 라벨(§ 조항 표기)
const RELIEF_LOAD_BASIS_LABEL = {
  OUTLET_BLOCKED:      "§5.1 출구 차단",
  OVERFILLING:          "§5.6 과충전",
  CONTROL_VALVE_FAIL:   "§5.7 자동제어밸브 고장",
  ABNORMAL_HEAT_VAPOR:  "§5.8 비정상 열/증기 유입",
};

function InputView({ inputs, deviceType, onChange, onDeviceChange, onSubmit, dischargeSystem, equipment,
  reliefLoadScenarioType, reliefLoadScenarioInput, reliefLoadScenarioResult, reliefLoadAdapter,
  effectiveW, effectiveWSource, onReliefLoadScenarioTypeChange, onReliefLoadScenarioInputChange }) {
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
  const allowableBpPct = getAllowableBackpressureRatio(inputs.valveType) * 100;
  const bpWarning = bpRatio > allowableBpPct ? "배압 초과" : bpRatio > allowableBpPct/2 ? "Kb 확인" : null;

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

      {/* ── 1b. 밸브 형식 (배압 허용비율 결정) — 안전밸브인 경우에만 ── */}
      {deviceType === "safetyValve" && (
        <div style={{marginBottom:16}}>
          <div style={{fontSize:10,fontWeight:700,color:T.sub,fontFamily:font.mono,letterSpacing:0.5,marginBottom:6}}>
            VALVE TYPE — 배압 허용비율을 결정합니다
          </div>
          <div style={{display:"flex",gap:8}}>
            {[
              ["SPRING", "스프링식(일반형)", "배압 ≤ 설정압력의 10%"],
              ["BELLOWS","벨로우즈형(밸런스형)", "배압 ≤ 설정압력의 50%"],
            ].map(([v,l,sub])=>(
              <div key={v} onClick={()=>onChange("valveType",v)}
                style={{flex:1,padding:"10px 12px",borderRadius:10,cursor:"pointer",
                  border:`2px solid ${(inputs.valveType||"SPRING")===v?T.navyLight:T.border}`,
                  background:(inputs.valveType||"SPRING")===v?T.navy+"0D":T.cardBg,
                  transition:"all 0.15s"}}>
                <div style={{fontSize:12,fontWeight:900,color:(inputs.valveType||"SPRING")===v?T.navy:T.text,fontFamily:font.sans}}>{l}</div>
                <div style={{fontSize:9,color:T.sub,marginTop:2,fontFamily:font.mono}}>{sub}</div>
              </div>
            ))}
          </div>
          <div style={{fontSize:9,color:T.gray,fontFamily:font.sans,marginTop:5,lineHeight:1.5}}>
            출처: KOSHA GUIDE D-18-2020 §7.2(4). 파일럿식은 원문에 수치 기준이 없어 이 앱에서 아직 지원하지 않습니다 — 실제 파일럿식 밸브는 제작사 데이터시트를 별도로 확인하세요.
          </div>
        </div>
      )}


      {/* ── 2. 방출 시나리오 ── */}
      <SectionHeader step="2" title="방출 시나리오" sub="어떤 상황에서 밸브가 열리는가 — API 521 시나리오"/>
      <div style={{position:"relative"}}>
        <div style={{position:"absolute",top:-6,right:0,zIndex:1,fontSize:9,padding:"2px 8px",borderRadius:6,
          fontFamily:font.mono,fontWeight:700,
          background: reliefLoadScenarioType !== null ? T.orangeBg : T.greenBg,
          color: reliefLoadScenarioType !== null ? "#946200" : T.greenDk,
          border:`1px solid ${reliefLoadScenarioType !== null ? T.orange : T.green}`}}>
          {reliefLoadScenarioType !== null ? "참고용 — 미사용" : "MANUAL INPUT 사용 중"}
        </div>
        <DecisionSlider
          param="W" label="설계 방출량 (Manual)" unit="kg/h"
          value={inputs.W} min={500} max={10000} step={100}
          onChange={v=>onChange("W",v)}
          basis="HAZOP 또는 API 521 시나리오 계산서 기반. 화재, 반응 폭주, 냉각 상실 등 최대 방출 시나리오 중 지배 케이스 적용. 설계 여유 없이 계산된 최대값 사용. 아래 Relief Load 시나리오를 선택하면 이 값 대신 시나리오 산정값이 사용됩니다."
        />
      </div>

      {/* ── 2b. Relief Load — §5 시나리오 기반 W 산정 (선택) ── */}
      <ReliefLoadScenarioSection
        scenarioType={reliefLoadScenarioType}
        scenarioInput={reliefLoadScenarioInput}
        scenarioResult={reliefLoadScenarioResult}
        adapter={reliefLoadAdapter}
        onScenarioTypeChange={onReliefLoadScenarioTypeChange}
        onFieldChange={onReliefLoadScenarioInputChange}
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

      {/* ── ACCUMULATION-001: 축적압력 허용성 검증 — sizing과 별개 정책 ── */}
      <div style={{background:T.cardBg,borderRadius:10,padding:"10px 12px",marginBottom:10,
        border:`1.5px solid ${T.border}`}}>
        <div style={{fontSize:9,color:T.gray,fontFamily:font.mono,marginBottom:6}}>
          ACCUMULATION GUARDRAIL — 이 Overpressure가 시나리오상 허용되는지 검증 (KOSHA D-18 §4.4)
        </div>
        <div style={{display:"flex",gap:8,marginBottom:6}}>
          {[[1,"밸브 1개 설치"],[2,"밸브 2개 이상 설치"]].map(([v,l])=>(
            <div key={v} onClick={()=>onChange("valveCount",v)}
              style={{flex:1,padding:"8px 10px",borderRadius:8,cursor:"pointer",
                border:`2px solid ${(inputs.valveCount||1)===v?T.navyLight:T.border}`,
                background:(inputs.valveCount||1)===v?T.navy+"0D":T.bg}}>
              <div style={{fontSize:11,fontWeight:900,color:(inputs.valveCount||1)===v?T.navy:T.text,fontFamily:font.sans}}>{l}</div>
            </div>
          ))}
        </div>
        <div style={{display:"flex",gap:8,marginBottom:8}}>
          {[[false,"화재 보호 목적 아님"],[true,"화재 보호 목적"]].map(([v,l])=>(
            <div key={String(v)} onClick={()=>onChange("fireScenario",v)}
              style={{flex:1,padding:"8px 10px",borderRadius:8,cursor:"pointer",
                border:`2px solid ${!!inputs.fireScenario===v?T.navyLight:T.border}`,
                background:!!inputs.fireScenario===v?T.navy+"0D":T.bg}}>
              <div style={{fontSize:11,fontWeight:900,color:!!inputs.fireScenario===v?T.navy:T.text,fontFamily:font.sans}}>{l}</div>
            </div>
          ))}
        </div>
        {(() => {
          const allowRatio = getAllowableAccumulationRatio(!!inputs.fireScenario, inputs.valveCount || 1);
          const actualRatio = typeof inputs.OP === "number" && !isNaN(inputs.OP) ? 1 + inputs.OP/100 : null;
          const go = actualRatio != null && actualRatio <= allowRatio;
          return actualRatio == null ? null : (
            <div style={{fontSize:11,fontWeight:900,fontFamily:font.mono,
              color: go ? T.green : T.red}}>
              {go ? "✓ GO" : "✗ NO-GO"} — 현재 축적압력 {(actualRatio*100).toFixed(0)}%
              {" "}(허용 한도 {(allowRatio*100).toFixed(0)}%, KOSHA D-18 §4.4)
              {!go && <span style={{display:"block",fontWeight:600,color:T.sub,marginTop:2}}>
                입력 축적압력이 적용 기준을 초과합니다 — 밸브 수량/화재 시나리오를 재확인하거나
                설비대장에서 Overpressure 값을 낮춰야 합니다. 자동 보정하지 않습니다.
              </span>}
            </div>
          );
        })()}
      </div>

      {/* ── INLET-LOSS-001: 인입배관 압력손실 — read-only, Engine이 판정 소유 ── */}
      <div style={{background:T.cardBg,borderRadius:10,padding:"10px 12px",marginBottom:10,
        border:`1.5px solid ${T.border}`}}>
        <div style={{fontSize:9,color:T.gray,fontFamily:font.mono,marginBottom:6}}>
          INLET PRESSURE LOSS — 인입배관 압력손실 ≤ 설정압력 × {(getAllowableInletLossRatio()*100).toFixed(0)}% (KOSHA D-18-2020 §7.2(1))
        </div>
        {(() => {
          const ip = equipment?.inletPiping;
          if (!ip) {
            return (
              <div style={{fontSize:11,fontWeight:700,color:T.gray,fontFamily:font.mono}}>
                — 판정 보류 (INSUFFICIENT INPUT) — 설비대장에 인입배관(L/D/ΣK)이 등록되어 있지 않습니다.
                <div style={{fontSize:9,color:T.sub,fontWeight:400,marginTop:3,fontFamily:font.sans}}>
                  임의로 추정하지 않습니다 — 실제 판정이 필요하면 설비대장에서 등록하세요.
                </div>
              </div>
            );
          }
          const Pset = inputs.P1;
          const fric = computeInletFrictionLoss({ W:inputs.W, T:inputs.T, M:inputs.M, Pset, inletPiping: ip });
          const result = evaluateInletPressureLossPolicy(Pset, fric);
          if (!result.pressureLossAvailable) {
            return (
              <div style={{fontSize:11,fontWeight:700,color:T.gray,fontFamily:font.mono}}>
                — 판정 보류 (INSUFFICIENT INPUT) — {result.reason}
              </div>
            );
          }
          const go = result.pressureLossOK;
          return (
            <div>
              <div style={{fontSize:10,color:T.sub,fontFamily:font.mono,marginBottom:4}}>
                L={ip.L}m · D={Math.round(ip.D*1000)}mm · ΣK={ip.fittingsK}
              </div>
              <div style={{fontSize:11,fontWeight:900,fontFamily:font.mono,color: go ? T.green : T.red}}>
                {go ? "✓ GO" : "✗ NO-GO"} — ΔP {result.pressureLoss.toFixed(4)} bar
                {" "}({(result.pressureLossRatio*100).toFixed(2)}%, 허용 {(result.allowablePressureLoss).toFixed(4)} bar = {(result.allowableRatio*100).toFixed(0)}%)
                {!go && <span style={{display:"block",fontWeight:600,color:T.sub,marginTop:2}}>
                  인입배관 압력손실이 기준을 초과합니다 — 배관 내경을 늘리거나 길이/부속을 줄이는 재설계가 필요합니다.
                  자동 보정하지 않습니다.
                </span>}
              </div>
            </div>
          );
        })()}
      </div>

      <DecisionSlider
        param="P2" label="배압 (Back Pressure)" unit="barg"
        value={inputs.P2} min={0} max={5} step={0.05}
        onChange={v=>onChange("P2",v)}
        basis={`플레어 헤더 또는 방출 배관 압력. 현재 P2/P1 = ${bpRatio}%. 허용 한도 = ${(inputs.valveType==="BELLOWS"?"벨로우즈형":"스프링식")} 기준 ${allowableBpPct.toFixed(0)}% (KOSHA D-18 §7.2(4)).${bpRatio>allowableBpPct?" 한도 초과 — 벨로우즈형 전환 또는 배관 재설계 검토.":""}`}
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

        {/* Governing Relief Load — 실제 sizing에 쓰이는 W와 그 근거를 명확히 표시.
            Manual/Scenario 두 값이 동시에 "사용 중"으로 보이지 않도록 하나만 강조. */}
        <div style={{background:"#FFFFFF12",borderRadius:10,padding:"10px 12px",marginBottom:10}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
            <span style={{fontSize:9,color:"#7B9EC0",fontFamily:font.mono,letterSpacing:0.5}}>GOVERNING RELIEF LOAD</span>
            <span style={{fontSize:9,padding:"2px 7px",borderRadius:5,fontFamily:font.mono,fontWeight:700,
              background: effectiveWSource==="GOVERNING_RELIEF_LOAD" ? T.green : "#FFFFFF22",
              color: effectiveWSource==="GOVERNING_RELIEF_LOAD" ? T.navy : "#B8CBE0"}}>
              {effectiveWSource==="GOVERNING_RELIEF_LOAD" ? "SCENARIO 기반" : "MANUAL 기반"}
            </span>
          </div>
          <div style={{fontSize:20,fontWeight:900,color:T.white,fontFamily:font.mono}}>
            {Number(effectiveW).toLocaleString(undefined,{maximumFractionDigits:1})} <span style={{fontSize:12,color:"#7B9EC0"}}>kg/h</span>
          </div>
          {effectiveWSource==="GOVERNING_RELIEF_LOAD" && (
            <div style={{fontSize:9,color:"#7B9EC0",fontFamily:font.mono,marginTop:2}}>
              Basis: {RELIEF_LOAD_BASIS_LABEL[reliefLoadScenarioType]} — Manual W({inputs.W} kg/h)는 사용되지 않음
            </div>
          )}
        </div>

        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
          {[
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
        const reliefLoadIncomplete = reliefLoadScenarioType !== null && reliefLoadAdapter?.valid !== true;
        const blockReason = mawpWarning
          ? "⚠ 설정압 오류 — 수정 후 진행 가능"
          : (kbOverride && !kbOverrideReason.trim())
          ? "⚠ Kb override 근거를 입력해야 진행 가능"
          : reliefLoadIncomplete
          ? "⚠ Relief Load 시나리오 입력을 완료해야 진행 가능"
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
