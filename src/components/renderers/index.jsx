//  REPORT RENDERERS (Snapshot projection — UI 컴포넌트 아님)
// ════════════════════════════════════════════════════════════════

// PipeFlow — Snapshot.result 기준 렌더링
function PipeFlowRenderer({ snap, sim }) {
  const { valveOpen, ratio, pressure } = sim;
  const [offset, setOffset] = useState(0);
  const deviceType = snap.deviceType;
  const setPoint   = snap.inputs.P1;
  const mawp       = snap.inputs.mawp;

  useEffect(() => {
    const id = setInterval(() => setOffset(o => (o + 3) % 40), 50);
    return () => clearInterval(id);
  }, []);

  const pColor     = ratio < 0.65 ? T.green : ratio < 0.88 ? T.yellow : T.red;
  const orangeColor= T.orange;

  return (
    <svg viewBox="0 0 700 265" style={{ width:"100%", height:"auto" }}>
      <defs>
        <pattern id="fp2" x="0" y="0" width="40" height="20" patternUnits="userSpaceOnUse" patternTransform={`translate(${offset},0)`}>
          <circle cx="10" cy="10" r="3" fill={T.blue} opacity="0.4"/>
          <circle cx="30" cy="10" r="3" fill={T.blue} opacity="0.4"/>
        </pattern>
        <pattern id="dp2" x="0" y="0" width="40" height="20" patternUnits="userSpaceOnUse" patternTransform={`translate(${valveOpen?offset:0},0)`}>
          <circle cx="10" cy="10" r="3" fill={T.orange} opacity={valveOpen?0.5:0.08}/>
          <circle cx="30" cy="10" r="3" fill={T.orange} opacity={valveOpen?0.5:0.08}/>
        </pattern>
        <filter id="sh2"><feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#00000020"/></filter>
        <filter id="gl2"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>

      <rect width="700" height="265" fill="#EEF4FF" rx="16"/>

      {/* VESSEL */}
      <rect x="14" y="78" width="62" height="104" rx="10" fill={T.blueBg} stroke={T.blue} strokeWidth="2.5" filter="url(#sh2)"/>
      <rect x="14" y={78+104*(1-ratio)} width="62" height={104*ratio} rx="10" fill={pColor} opacity="0.3" style={{transition:"height 0.1s,y 0.1s"}}/>
      <text x="45" y="197" textAnchor="middle" fontSize="9" fontWeight="700" fill={T.sub} fontFamily="monospace">VESSEL</text>
      <text x="45" y="209" textAnchor="middle" fontSize="8" fill={pColor} fontFamily="monospace" fontWeight="700">{pressure.toFixed(1)}b</text>

      {/* 게이지 */}
      <circle cx="45" cy="58" r="23" fill={T.white} stroke={pColor} strokeWidth="3" filter="url(#sh2)"/>
      <path d={`M45 58 L${45+17*Math.cos((ratio*180-210)*Math.PI/180)} ${58+17*Math.sin((ratio*180-210)*Math.PI/180)}`} stroke={pColor} strokeWidth="3" strokeLinecap="round"/>
      <circle cx="45" cy="58" r="3" fill={pColor}/>
      <text x="45" y="87" textAnchor="middle" fontSize="8" fill={T.sub} fontFamily="monospace">PI-01</text>

      {/* 업스트림 */}
      <rect x="76" y="112" width="162" height="32" rx="7" fill={T.white} stroke={T.border} strokeWidth="2"/>
      <rect x="78" y="114" width="158" height="28" rx="6" fill="url(#fp2)" opacity={Math.min(ratio*1.3,1)}/>
      <text x="157" y="106" textAnchor="middle" fontSize="10" fontWeight="700" fill={T.blue} fontFamily="monospace">UPSTREAM</text>
      <text x="157" y="157" textAnchor="middle" fontSize="9" fill={T.sub} fontFamily="monospace">P1 = {pressure.toFixed(2)} barg</text>

      {/* 밸브 */}
      {deviceType === "safetyValve" ? (
        <g>
          <rect x="240" y="98" width="66" height="62" rx="10"
            fill={valveOpen?T.orangeBg:T.blueBg} stroke={valveOpen?T.orange:T.blue}
            strokeWidth="3" filter="url(#sh2)" style={{transition:"all 0.3s"}}/>
          {[0,1,2,3].map(i=>(
            <path key={i} d={`M${250+i*10} 108 Q${255+i*10} 119 ${260+i*10} 108`}
              fill="none" stroke={valveOpen?T.orange:T.blue} strokeWidth="1.5"/>
          ))}
          <rect x="254" y={valveOpen?148:155} width="25" height="7" rx="3"
            fill={valveOpen?T.orange:T.blue} filter={valveOpen?"url(#gl2)":"none"} style={{transition:"all 0.25s"}}/>
          {valveOpen && <>
            <line x1="273" y1="98" x2="273" y2="68" stroke={T.orange} strokeWidth="2.5" strokeDasharray="4,2"/>
            <polygon points="273,56 265,72 281,72" fill={T.orange}/>
          </>}
          <text x="273" y="173" textAnchor="middle" fontSize="9" fontWeight="700"
            fill={valveOpen?T.orange:T.blue} fontFamily="monospace">{valveOpen?"OPEN ▲":"S.V ✅"}</text>
          <text x="273" y="185" textAnchor="middle" fontSize="8" fill={T.yellow} fontFamily="monospace">Set: {setPoint}b</text>
        </g>
      ) : (
        <g>
          <rect x="240" y="103" width="66" height="52" rx="10"
            fill={valveOpen?"#FFDFE0":"#F1E0FF"} stroke={valveOpen?T.red:"#CE82FF"}
            strokeWidth="3" filter="url(#sh2)" style={{transition:"all 0.3s"}}/>
          {valveOpen ? <>
            <line x1="250" y1="113" x2="296" y2="145" stroke={T.red} strokeWidth="4" strokeLinecap="round"/>
            <line x1="296" y1="113" x2="250" y2="145" stroke={T.red} strokeWidth="4" strokeLinecap="round"/>
            <line x1="273" y1="103" x2="273" y2="68" stroke={T.red} strokeWidth="2.5" strokeDasharray="4,2"/>
            <polygon points="273,56 265,72 281,72" fill={T.red}/>
          </> : <ellipse cx="273" cy="129" rx="23" ry="13" fill="none" stroke="#CE82FF" strokeWidth="2.5"/>}
          <text x="273" y="168" textAnchor="middle" fontSize="9" fontWeight="700"
            fill={valveOpen?T.red:"#CE82FF"} fontFamily="monospace">{valveOpen?"BURST 💥":"R.D ✅"}</text>
          <text x="273" y="180" textAnchor="middle" fontSize="8" fill={T.yellow} fontFamily="monospace">Burst: {setPoint}b</text>
        </g>
      )}

      {/* 다운스트림 */}
      <rect x="307" y="112" width="162" height="32" rx="7" fill={T.white} stroke={T.border} strokeWidth="2"/>
      <rect x="309" y="114" width="158" height="28" rx="6" fill="url(#dp2)" opacity={valveOpen?1:0.3}/>
      <text x="388" y="106" textAnchor="middle" fontSize="10" fontWeight="700"
        fill={valveOpen?T.orange:T.gray} fontFamily="monospace">DOWNSTREAM</text>
      <text x="388" y="157" textAnchor="middle" fontSize="9" fill={T.sub} fontFamily="monospace">
        {valveOpen?"▶ 방출 중":"── 정상 운전"}
      </text>

      {/* 플레어 */}
      <rect x="472" y="88" width="52" height="72" rx="8" fill={T.yellowBg} stroke={T.yellow} strokeWidth="2" filter="url(#sh2)"/>
      <rect x="488" y="38" width="18" height="50" rx="4" fill={T.yellowBg} stroke={T.yellow} strokeWidth="2"/>
      {valveOpen && <>
        <ellipse cx="497" cy="28" rx="10" ry="14" fill={T.yellow} opacity="0.85" filter="url(#gl2)"/>
        <ellipse cx="497" cy="20" rx="6" ry="10" fill="#FFA500" opacity="0.9"/>
        <ellipse cx="497" cy="13" rx="4" ry="7" fill={T.red} opacity="0.7"/>
      </>}
      <text x="497" y="172" textAnchor="middle" fontSize="9" fontWeight="700" fill={T.yellow} fontFamily="monospace">FLARE</text>

      {/* 상태 패널 */}
      <rect x="540" y="86" width="144" height="114" rx="13" fill={T.white} stroke={T.border} strokeWidth="2" filter="url(#sh2)"/>
      <text x="612" y="104" textAnchor="middle" fontSize="9" fontWeight="700" fill={T.sub} fontFamily="monospace">PRESSURE STATUS</text>
      <rect x="555" y="112" width="114" height="13" rx="6" fill="#F0F4FA"/>
      <rect x="555" y="112" width={Math.min(ratio*114,114)} height="13" rx="6" fill={pColor} style={{transition:"width 0.1s"}}/>
      <text x="612" y="142" textAnchor="middle" fontSize="22" fontWeight="900" fill={pColor} fontFamily="monospace">{pressure.toFixed(1)}</text>
      <text x="612" y="156" textAnchor="middle" fontSize="9" fill={T.sub} fontFamily="monospace">barg</text>
      <rect x="557" y="164" width="110" height="24" rx="9"
        fill={valveOpen?T.orangeBg:T.greenBg} stroke={valveOpen?T.orange:T.green} strokeWidth="1.5"/>
      <text x="612" y="180" textAnchor="middle" fontSize="9" fontWeight="700"
        fill={valveOpen?T.orange:T.green} fontFamily="monospace">{valveOpen?"▲ RELIEVING":"● NORMAL"}</text>
    </svg>
  );
}

// PressChartRenderer — Snapshot.inputs 기준
function PressChartRenderer({ hist, snap }) {
  const setPoint = snap.inputs.P1;
  const mawp     = snap.inputs.mawp;
  const W=580, H=115;
  const mx = mawp * 1.3;
  const y  = p => H-20-((p/mx)*(H-30));
  const x  = (i,n) => 38+(i/Math.max(n-1,1))*(W-50);
  const pts= hist.map((p,i)=>({x:x(i,hist.length),y:y(p)}));
  const ln = pts.map((p,i)=>`${i===0?"M":"L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const ar = pts.length>1?`${ln} L${pts[pts.length-1].x},${H-20} L${pts[0].x},${H-20} Z`:"";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:115,borderRadius:10}}>
      <defs>
        <linearGradient id="ag2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={T.blue} stopOpacity="0.3"/>
          <stop offset="100%" stopColor={T.blue} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <rect width={W} height={H} fill="#F0F4FA" rx="10"/>
      {[.25,.5,.75,1].map(r=><line key={r} x1="38" y1={y(mx*r)} x2={W-10} y2={y(mx*r)} stroke={T.border} strokeWidth="1"/>)}
      <line x1="38" y1={y(mawp)} x2={W-10} y2={y(mawp)} stroke={T.red} strokeWidth="1.5" strokeDasharray="5,3"/>
      <text x={W-12} y={y(mawp)-3} fontSize="8" fill={T.red} textAnchor="end" fontFamily="monospace" fontWeight="700">MAWP {mawp}b</text>
      <line x1="38" y1={y(setPoint)} x2={W-10} y2={y(setPoint)} stroke={T.yellow} strokeWidth="1.5" strokeDasharray="5,3"/>
      <text x={W-12} y={y(setPoint)-3} fontSize="8" fill={T.yellow} textAnchor="end" fontFamily="monospace" fontWeight="700">SET {setPoint}b</text>
      {ar && <path d={ar} fill="url(#ag2)"/>}
      {pts.length>1 && <path d={ln} fill="none" stroke={T.blue} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>}
      <line x1="38" y1="5" x2="38" y2={H-20} stroke={T.border} strokeWidth="1.5"/>
      <line x1="38" y1={H-20} x2={W-10} y2={H-20} stroke={T.border} strokeWidth="1.5"/>
    </svg>
  );
}

// EvidenceCard — Snapshot.evidence 렌더링
function EvidenceCard({ step }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{border:`2px solid ${step.ok?T.green:T.red}`,borderRadius:12,overflow:"hidden",marginBottom:10,boxShadow:"0 2px 8px #0001"}}>
      <div onClick={()=>setOpen(o=>!o)} style={{display:"flex",alignItems:"center",gap:12,padding:"11px 15px",cursor:"pointer",background:step.ok?T.greenBg:T.redBg}}>
        <div style={{width:28,height:28,borderRadius:"50%",background:step.ok?T.green:T.red,display:"flex",alignItems:"center",justifyContent:"center",color:T.white,fontWeight:900,fontSize:13,flexShrink:0}}>
          {step.ok?"✓":"✗"}
        </div>
        <div style={{flex:1}}>
          <div style={{fontSize:13,fontWeight:700,color:T.text,fontFamily:font.mono}}>Step {step.id}: {step.title}</div>
          <div style={{fontSize:11,color:T.sub,marginTop:2,fontFamily:font.mono}}>{step.result}</div>
        </div>
        <span style={{fontSize:11,color:T.sub}}>{open?"▲":"▼"}</span>
      </div>
      {open && (
        <div style={{background:T.white,padding:"12px 15px",borderTop:`1px solid ${T.border}`}}>
          <div style={{background:"#F0F4FA",borderRadius:8,padding:"7px 12px",fontFamily:font.mono,fontSize:11,color:T.blue,marginBottom:8}}>{step.formula}</div>
          <p style={{fontSize:11,color:T.sub,margin:0,lineHeight:1.65}}>{step.detail}</p>
        </div>
      )}
    </div>
  );
}

// ChecklistRenderer — Snapshot.result.checklist 렌더링
function ChecklistRenderer({ checklist, backpress, accumulation, inletLoss, dataGaps }) {
  const vtLabel = backpress?.valveType==="BELLOWS" ? "벨로우즈형(밸런스형)" : "스프링식";
  const allowPct = backpress?.allowableRatio!=null ? (backpress.allowableRatio*100).toFixed(0) : "10";
  const accAllowPct = accumulation?.allowableRatio!=null ? (accumulation.allowableRatio*100).toFixed(0) : "110";
  const accScenarioLabel = accumulation
    ? (accumulation.fireScenario ? "화재 보호 목적" : `비화재, 밸브 ${accumulation.valveCount>=2?"2개 이상":"1개"} 설치`)
    : "";
  const items = [
    { key:"capacityOK",     label:"방출용량 충족",    detail:"선정 오리피스 면적 ≥ 필요 면적" },
    { key:"backPressureOK", label:"배압(背壓) 허용 범위 이내", detail:`P2/P1 < ${allowPct}% (${vtLabel} 기준, KOSHA D-18 §7.2(4)) — 배출 배관이 밸브 작동을 방해하지 않는지 확인` },
    { key:"mawpOK",         label:"설정압 ≤ 최고허용운전압력(MAWP)",    detail:"설정압이 설비가 견딜 수 있는 최고압력을 넘지 않는지 확인" },
    { key:"kdOK",           label:"방출계수 Kd 충족 (≥ 0.9)",         detail:"밸브가 실제로 얼마나 잘 배출하는지 나타내는 보정값, 최소 권고 기준 충족" },
    { key:"marginOK",       label:"여유율 충분 (≥ 1.0)",     detail:"필요량보다 여유있게 설계됐는지 — 선정 오리피스 면적의 여유 정도" },
    { key:"accumulationOK", label:"축적압력 허용 범위 이내 (Overpressure Guardrail)",
      detail:`1+OP/100 ≤ ${accAllowPct}% (${accScenarioLabel} 기준, KOSHA D-18 §4.4) — 초과 시 자동 보정 없이 NO-GO` },
    { key:"inletLossOK",    label:"인입배관 압력손실 허용 범위 이내",
      detail: inletLoss?.pressureLossAvailable
        ? `ΔP/Pset ≤ ${(inletLoss.allowableRatio*100).toFixed(0)}% (KOSHA D-18 §7.2(1)) — 인입배관 내 압력손실이 설정압력의 ${(inletLoss.allowableRatio*100).toFixed(0)}%를 넘지 않는지 확인`
        : "인입배관 형상(길이/내경/fittings) 데이터가 없어 판정 보류 — 입력 부족을 적정(GO)으로 취급하지 않음" },
  ];
  return (
    <div>
      {(dataGaps && dataGaps.length > 0) && (
        <div style={{display:"flex",gap:10,alignItems:"flex-start",padding:"10px 13px",borderRadius:10,marginBottom:8,background:T.amberBg||"#fff7e6",border:`1.5px solid ${T.amber||"#d97706"}`}}>
          <div style={{width:24,height:24,borderRadius:"50%",background:T.amber||"#d97706",display:"flex",alignItems:"center",justifyContent:"center",color:T.white,fontWeight:900,fontSize:12,flexShrink:0}}>!</div>
          <div>
            <div style={{fontSize:12,fontWeight:700,color:T.text,fontFamily:font.mono}}>판정 보류 — 입력 부족 (INSUFFICIENT INPUT)</div>
            <div style={{fontSize:10,color:T.sub,marginTop:2}}>{dataGaps.join(", ")} 데이터가 없어 전체 판정을 확정할 수 없음 — 개별 항목이 전부 충족이어도 "적정(GO)"으로 표시하지 않음</div>
          </div>
        </div>
      )}
      {items.map(({ key, label, detail }) => {
        const hasKey = checklist && Object.prototype.hasOwnProperty.call(checklist, key);
        if (!hasKey) {
          return (
            <div key={key} style={{display:"flex",gap:10,alignItems:"flex-start",padding:"10px 13px",borderRadius:10,marginBottom:8,background:T.bg,border:`1.5px dashed ${T.border}`}}>
              <div style={{width:24,height:24,borderRadius:"50%",background:T.gray||"#9ca3af",display:"flex",alignItems:"center",justifyContent:"center",color:T.white,fontWeight:900,fontSize:12,flexShrink:0}}>—</div>
              <div>
                <div style={{fontSize:12,fontWeight:700,color:T.sub,fontFamily:font.mono}}>{label}</div>
                <div style={{fontSize:10,color:T.gray||"#9ca3af",marginTop:2}}>{detail}</div>
              </div>
            </div>
          );
        }
        const ok = checklist[key];
        return (
          <div key={key} style={{display:"flex",gap:10,alignItems:"flex-start",padding:"10px 13px",borderRadius:10,marginBottom:8,background:ok?T.greenBg:T.redBg,border:`1.5px solid ${ok?T.green:T.red}`}}>
            <div style={{width:24,height:24,borderRadius:"50%",background:ok?T.green:T.red,display:"flex",alignItems:"center",justifyContent:"center",color:T.white,fontWeight:900,fontSize:12,flexShrink:0}}>{ok?"✓":"✗"}</div>
            <div>
              <div style={{fontSize:12,fontWeight:700,color:T.text,fontFamily:font.mono}}>{label}</div>
              <div style={{fontSize:10,color:T.sub,marginTop:2}}>{detail}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
