//  ASSET MASTER — Equipment + DischargeSystem 등록/조회/선택
// ════════════════════════════════════════════════════════════════

const DEST_OPTIONS = [
  { id:"flare",  label:"플레어 헤더",  note:"대기 연소" },
  { id:"atm",    label:"대기 직방출",  note:"비독성·비가연만" },
  { id:"closed", label:"밀폐 시스템",  note:"회수·처리" },
];
const DEVICE_OPTIONS = [
  { id:"safetyValve", label:"🔧 안전밸브" },
  { id:"ruptureDisk",  label:"💥 럽처디스크" },
];

// ── 공통 스타일 헬퍼 ────────────────────────────────────────
const iS = (extra={}) => ({
  width:"100%", padding:"10px 12px", borderRadius:9,
  border:`1.5px solid ${T.border}`, fontSize:13,
  fontFamily:font.mono, color:T.text, background:T.white,
  boxSizing:"border-box", outline:"none",
  ...extra,
});
const Lbl = ({txt, req}) => (
  <div style={{fontSize:10,fontWeight:700,color:T.sub,fontFamily:font.mono,marginBottom:4}}>
    {txt}{req && <span style={{color:T.red}}> *</span>}
  </div>
);
const Field = ({label, req, children}) => (
  <div style={{marginBottom:12}}><Lbl txt={label} req={req}/>{children}</div>
);
const Row2 = ({a, b}) => (
  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>{a}{b}</div>
);
const Section = ({title, children}) => (
  <div style={{background:T.bg,borderRadius:12,padding:"13px 13px 4px",
    marginBottom:12,border:`1px solid ${T.border}`}}>
    <div style={{fontSize:10,fontWeight:700,color:T.sub,fontFamily:font.mono,
      marginBottom:10,letterSpacing:1}}>{title}</div>
    {children}
  </div>
);

// ── EquipmentForm ─────────────────────────────────────────────
function EquipmentForm({ onSave, onCancel, editing }) {
  const isRevision = !!editing;
  const [f, setF] = useState(editing ? {
    tag: editing.tag, location: editing.location, deviceType: editing.deviceType,
    mawp: editing.mawp, setPressure: editing.setPressure,
    overpressure: editing.overpressure, orifice: editing.orifice,
    inletSize: editing.inletSize, outletSize: editing.outletSize,
    manufacturer: editing.manufacturer, model: editing.model,
    serialNo: editing.serialNo, installedAt: editing.installedAt,
    mocId: "",
  } : {
    tag:"", location:"", deviceType:"safetyValve",
    mawp:6.0, setPressure:5.5, overpressure:10,
    inletSize:"3\"", outletSize:"4\"", orifice:"",
    manufacturer:"", model:"", serialNo:"", installedAt:"",
    mocId:"",
  });
  const upd = (k,v) => setF(p=>({...p,[k]:v}));
  const psetErr = f.setPressure > f.mawp;
  const valid = f.tag.trim() && f.mawp>0 && f.setPressure>0 && !psetErr &&
    f.overpressure !== "" && f.overpressure !== null && !isNaN(Number(f.overpressure)) && Number(f.overpressure) >= 0 &&
    (!isRevision || f.mocId.trim().length > 0);

  const handleSave = () => {
    if (!valid) return;
    if (isRevision) {
      const result = reviseEquipment(editing, f);
      if (!result.ok) { alert(`${result.field}: ${result.reason}`); return; }
      onSave(result.equipment);
      return;
    }
    try { onSave(createEquipment(f)); } catch(e) { alert(e.message); }
  };

  return (
    <div style={{background:T.cardBg,borderRadius:16,padding:18,
      border:`1.5px solid ${T.border}`,boxShadow:"0 4px 16px #0002"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <div style={{fontSize:14,fontWeight:900,color:T.navy,fontFamily:font.mono}}>
          {isRevision ? `설비 개정 — ${editing.tag}` : "PSV 설비 등록"}
        </div>
        {isRevision && (
          <div style={{fontSize:10,fontWeight:700,color:T.orange,fontFamily:font.mono}}>
            Rev.{editing.revision} → Rev.{editing.revision + 1}
          </div>
        )}
      </div>

      {isRevision && (
        <Section title="MOC (변경 관리)">
          <Field label="MOC 번호" req>
            <input value={f.mocId}
              onChange={e=>upd("mocId",e.target.value)}
              placeholder="MOC-2026-0012"
              style={iS({border:`1.5px solid ${f.mocId.trim()?T.navyLight:T.red}`})}/>
            <div style={{fontSize:9,color:T.gray,fontFamily:font.sans,marginTop:3}}>
              설비 사양 개정은 MOC 번호 없이 저장할 수 없습니다 — 근거 없는 변경 차단.
            </div>
          </Field>
        </Section>
      )}

      <Section title="기본 정보">
        <Row2
          a={<Field label="Tag No." req><input value={f.tag}
            onChange={e=>upd("tag",e.target.value)}
            onInput={e=>upd("tag",e.target.value)}
            placeholder="PSV-R201" autoComplete="off"
            style={iS({border:`1.5px solid ${f.tag.trim()?T.navyLight:T.border}`})}/></Field>}
          b={<Field label="설치 위치"><input value={f.location}
            onChange={e=>upd("location",e.target.value)}
            placeholder="반응기 R-201 상부"
            style={iS()}/></Field>}
        />
        <Field label="밸브 종류">
          <div style={{display:"flex",gap:8}}>
            {DEVICE_OPTIONS.map(d=>(
              <div key={d.id} onClick={()=>upd("deviceType",d.id)}
                style={{flex:1,padding:"8px 10px",borderRadius:9,cursor:"pointer",
                  textAlign:"center",
                  border:`2px solid ${f.deviceType===d.id?T.navyLight:T.border}`,
                  background:f.deviceType===d.id?T.navy+"0D":T.white,
                  fontSize:12,fontWeight:700,
                  color:f.deviceType===d.id?T.navy:T.text,
                  fontFamily:font.sans}}>
                {d.label}
              </div>
            ))}
          </div>
        </Field>
      </Section>

      <Section title="압력 및 오리피스">
        <Row2
          a={<Field label="MAWP (barg)" req>
            <input type="number" value={f.mawp} step={0.1} min={0.1}
              onChange={e=>upd("mawp",+e.target.value)} style={iS()}/>
          </Field>}
          b={<Field label="설정압 (barg)" req>
            <input type="number" value={f.setPressure} step={0.1} min={0.1}
              onChange={e=>upd("setPressure",+e.target.value)}
              style={iS({border:`1.5px solid ${psetErr?T.red:T.border}`})}/>
            {psetErr && <div style={{fontSize:9,color:T.red,marginTop:3}}>MAWP 초과</div>}
          </Field>}
        />
        <Row2
          a={<Field label="초과압력 Overpressure (%)" req>
            <input type="number" value={f.overpressure} step={1} min={0} max={50}
              onChange={e=>upd("overpressure",+e.target.value)} style={iS()}/>
            <div style={{fontSize:9,color:T.gray,fontFamily:font.sans,marginTop:3}}>
              relieving pressure 절대압 산정에 사용 (API 520): P1abs=Pset×(1+OP%)+대기압. 단일밸브 기본 10%.
            </div>
          </Field>}
          b={<div/>}
        />
        <Row2
          a={<Field label="오리피스">
            <input value={f.orifice}
              onChange={e=>upd("orifice",e.target.value.toUpperCase())}
              placeholder="P" style={iS()}/>
          </Field>}
          b={<Field label="입구/출구 Size">
            <div style={{display:"flex",gap:6}}>
              <input value={f.inletSize} onChange={e=>upd("inletSize",e.target.value)}
                placeholder='3"' style={iS({width:"50%"})}/>
              <input value={f.outletSize} onChange={e=>upd("outletSize",e.target.value)}
                placeholder='4"' style={iS({width:"50%"})}/>
            </div>
          </Field>}
        />
      </Section>

      <Section title="제조사 정보 (선택)">
        <Row2
          a={<Field label="제조사"><input value={f.manufacturer}
            onChange={e=>upd("manufacturer",e.target.value)}
            placeholder="Crosby" style={iS()}/></Field>}
          b={<Field label="모델"><input value={f.model}
            onChange={e=>upd("model",e.target.value)}
            placeholder="JOS-E" style={iS()}/></Field>}
        />
        <Row2
          a={<Field label="Serial No."><input value={f.serialNo}
            onChange={e=>upd("serialNo",e.target.value)}
            placeholder="SN-2024-001" style={iS()}/></Field>}
          b={<Field label="설치일"><input type="date" value={f.installedAt}
            onChange={e=>upd("installedAt",e.target.value)}
            style={iS()}/></Field>}
        />
      </Section>

      <div style={{display:"flex",gap:10}}>
        <button onClick={onCancel}
          style={{flex:1,padding:"12px",background:T.bg,color:T.sub,
            border:`1px solid ${T.border}`,borderRadius:11,
            fontSize:12,fontWeight:700,fontFamily:font.mono,cursor:"pointer"}}>
          취소
        </button>
        <button onClick={handleSave}
          style={{flex:2,padding:"12px",
            background:valid?T.navyLight:"#CBD5E1",
            color:T.white,border:"none",borderRadius:11,fontSize:13,
            fontWeight:900,fontFamily:font.sans,
            cursor:valid?"pointer":"not-allowed",
            boxShadow:valid?`0 4px 0 ${T.navy}`:"none"}}>
          {valid?(isRevision?"개정 저장 →":"설비 등록 →"):"필수 항목 입력 필요"}
        </button>
      </div>
    </div>
  );
}

// ── DischargeSystemForm ───────────────────────────────────────
// editing이 있으면 "개정" 모드: mocId 필수, revision은 자동 증가(읽기 전용 표시)
function DischargeSystemForm({ onSave, onCancel, editing }) {
  const isRevision = !!editing;
  const [f, setF] = useState(editing ? {
    name: editing.name, destination: editing.destination,
    L: editing.L, D: editing.D, fittingsK: editing.fittingsK,
    headerPressure: editing.headerPressure,
    connectedTags: (editing.connectedTags || []).join(", "),
    mocId: "",
  } : {
    name:"", destination:"flare",
    L:15, D:0.1, fittingsK:3.0, headerPressure:0.3, connectedTags:"",
    mocId:"",
  });
  const upd = (k,v) => setF(p=>({...p,[k]:v}));
  const valid = f.name.trim() && f.D > 0 && f.L >= 0 &&
    (!isRevision || f.mocId.trim().length > 0);

  const handleSave = () => {
    if (!valid) return;
    const tags = f.connectedTags.split(",").map(t=>t.trim()).filter(Boolean);
    if (isRevision) {
      const result = reviseDischargeSystem(editing, { ...f, connectedTags: tags });
      if (!result.ok) { alert(`${result.field}: ${result.reason}`); return; }
      onSave(result.dischargeSystem);
      return;
    }
    try {
      onSave(createDischargeSystem({ ...f, connectedTags: tags }));
    } catch(e) { alert(e.message); }
  };

  return (
    <div style={{background:T.cardBg,borderRadius:16,padding:18,
      border:`1.5px solid ${T.border}`,boxShadow:"0 4px 16px #0002"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <div style={{fontSize:14,fontWeight:900,color:T.navy,fontFamily:font.mono}}>
          {isRevision ? `배출계통 개정 — ${editing.name}` : "배출계통 등록"}
        </div>
        {isRevision && (
          <div style={{fontSize:10,fontWeight:700,color:T.orange,fontFamily:font.mono}}>
            Rev.{editing.revision} → Rev.{editing.revision + 1}
          </div>
        )}
      </div>

      {isRevision && (
        <Section title="MOC (변경 관리)">
          <Field label="MOC 번호" req>
            <input value={f.mocId}
              onChange={e=>upd("mocId",e.target.value)}
              placeholder="MOC-2026-0012"
              style={iS({border:`1.5px solid ${f.mocId.trim()?T.navyLight:T.red}`})}/>
            <div style={{fontSize:9,color:T.gray,fontFamily:font.sans,marginTop:3}}>
              배관 개정은 MOC 번호 없이 저장할 수 없습니다 — 근거 없는 변경 차단.
            </div>
          </Field>
        </Section>
      )}

      <Section title="계통 정보">
        <Field label="계통 명칭" req>
          <input value={f.name}
            onChange={e=>upd("name",e.target.value)}
            onInput={e=>upd("name",e.target.value)}
            placeholder="LP-FLARE-01" autoComplete="off"
            style={iS({border:`1.5px solid ${f.name.trim()?T.navyLight:T.border}`})}/>
        </Field>
        <Field label="배출 목적지">
          <div style={{display:"flex",gap:6}}>
            {DEST_OPTIONS.map(d=>(
              <div key={d.id} onClick={()=>upd("destination",d.id)}
                style={{flex:1,padding:"8px",borderRadius:9,cursor:"pointer",
                  textAlign:"center",
                  border:`2px solid ${f.destination===d.id?T.navyLight:T.border}`,
                  background:f.destination===d.id?T.navy+"0D":T.white}}>
                <div style={{fontSize:11,fontWeight:700,
                  color:f.destination===d.id?T.navy:T.text,
                  fontFamily:font.sans}}>{d.label}</div>
                <div style={{fontSize:9,color:T.sub}}>{d.note}</div>
              </div>
            ))}
          </div>
        </Field>
      </Section>

      <Section title="배관 형상 (도면 기준)">
        <Row2
          a={<Field label="배관 길이 L (m)" req>
            <input type="number" value={f.L} step={0.5} min={0}
              onChange={e=>upd("L",+e.target.value)} style={iS()}/>
          </Field>}
          b={<Field label="배관 내경 D (m)" req>
            <input type="number" value={f.D} step={0.005} min={0.01}
              onChange={e=>upd("D",+e.target.value)}
              style={iS({border:`1.5px solid ${f.D>0?T.border:T.red}`})}/>
          </Field>}
        />
        <Row2
          a={<Field label="Fittings ΣK">
            <input type="number" value={f.fittingsK} step={0.1} min={0}
              onChange={e=>upd("fittingsK",+e.target.value)} style={iS()}/>
          </Field>}
          b={<Field label="Header 압력 (barg)">
            <input type="number" value={f.headerPressure} step={0.05} min={0}
              onChange={e=>upd("headerPressure",+e.target.value)} style={iS()}/>
          </Field>}
        />
        <Field label="연결 PSV Tag (쉼표 구분)">
          <input value={f.connectedTags}
            onChange={e=>upd("connectedTags",e.target.value)}
            placeholder="PSV-R201, PSV-R202" style={iS()}/>
          <div style={{fontSize:9,color:T.gray,fontFamily:font.sans,marginTop:3}}>
            이 계통을 공유하는 PSV tag를 쉼표로 구분해 입력
          </div>
        </Field>
      </Section>

      <div style={{display:"flex",gap:10}}>
        <button onClick={onCancel}
          style={{flex:1,padding:"12px",background:T.bg,color:T.sub,
            border:`1px solid ${T.border}`,borderRadius:11,
            fontSize:12,fontWeight:700,fontFamily:font.mono,cursor:"pointer"}}>
          취소
        </button>
        <button onClick={handleSave}
          style={{flex:2,padding:"12px",
            background:valid?T.navyLight:"#CBD5E1",
            color:T.white,border:"none",borderRadius:11,fontSize:13,
            fontWeight:900,fontFamily:font.sans,
            cursor:valid?"pointer":"not-allowed",
            boxShadow:valid?`0 4px 0 ${T.navy}`:"none"}}>
          {valid?(isRevision?"개정 저장 →":"배출계통 등록 →"):"필수 항목 입력 필요"}
        </button>
      </div>
    </div>
  );
}

// ── RevisionHistoryPanel ────────────────────────────────────────
// B1: Asset Revision History — 100% 읽기 전용(Read-only).
// 책임: Revision 목록 표시 / Rev·MOC ID 배지 / 현재(최신) 표시 / 선택 / 상세 표시.
// 의도적으로 하지 않는 것: Diff(B2), Impact Analysis(B3), 되돌리기, 수정.
// 이 컴포넌트는 onSave/onRevise류 콜백을 전혀 받지 않는다 — 구조적으로 쓰기 경로가 없다.
function RevisionHistoryPanel({ title, history, id, kind, allSnapshots, onClose }) {
  const revisions = getRevisionsFor(history, id);           // 오름차순
  const latest    = getLatestRevision(history, id);
  const [selected, setSelected] = useState(latest);
  // 비교 대상 revision — 기본값은 선택된 revision의 직전(N-1). 자동 계산이며 저장하지 않는다.
  const defaultCompareRev = selected
    ? revisions.find(r => r.revision === selected.revision - 1) || null
    : null;
  const [compareRevNum, setCompareRevNum] = useState(defaultCompareRev?.revision ?? "");

  if (revisions.length === 0) return null;

  const EQ_FIELDS = [
    ["tag","Tag No."], ["location","설치 위치"],
    ["mawp","MAWP (barg)"], ["setPressure","설정압 (barg)"],
    ["overpressure","Overpressure (%)"], ["orifice","오리피스"],
    ["inletSize","입구 Size"], ["outletSize","출구 Size"],
    ["manufacturer","제조사"], ["model","모델"],
    ["serialNo","Serial No."], ["installedAt","설치일"],
  ];
  const DS_FIELDS = [
    ["name","계통 명칭"], ["destination","배출 목적지"],
    ["L","배관 길이 L (m)"], ["D","배관 내경 D (m)"],
    ["fittingsK","Fittings ΣK"], ["headerPressure","Header 압력 (barg)"],
    ["connectedTags","연결 PSV Tag"],
  ];
  const fields = kind === "equipment" ? EQ_FIELDS : DS_FIELDS;
  const fieldLabel = k => (fields.find(f => f[0] === k) || [k, k])[1];

  // ── B2: Diff — 선택된 revision을 compareRevNum(있으면)과 비교 ────
  const compareRev = compareRevNum === ""
    ? null
    : revisions.find(r => r.revision === Number(compareRevNum)) || null;
  const diff = (selected && compareRev)
    ? (kind === "equipment"
        ? diffEquipmentRevision(compareRev, selected)
        : diffDischargeSystemRevision(compareRev, selected))
    : [];

  // ── B3: Impact — 선택된 revision이 어디에 쓰였는지 (allSnapshots 필요) ──
  const revisionKey = selected ? `${selected.id}@${selected.revision}` : null;
  const impact = (revisionKey && allSnapshots)
    ? analyzeRevisionImpact(revisionKey, allSnapshots)
    : null;

  return (
    <div style={{background:T.cardBg,borderRadius:16,padding:16,
      border:`1.5px solid ${T.border}`,boxShadow:"0 4px 16px #0002",marginBottom:12}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
        <div style={{fontSize:13,fontWeight:900,color:T.navy,fontFamily:font.mono}}>
          Revision 이력 — {title}
        </div>
        <button onClick={onClose}
          style={{padding:"5px 12px",background:T.bg,color:T.sub,
            border:`1px solid ${T.border}`,borderRadius:8,
            fontSize:10,fontWeight:700,fontFamily:font.mono,cursor:"pointer"}}>
          닫기
        </button>
      </div>

      {/* Revision 목록: 최신이 위로 오도록 내림차순 표시 */}
      <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:14}}>
        {[...revisions].reverse().map(rev => {
          const isLatest   = latest && rev.revision === latest.revision;
          const isSelected = selected && rev.revision === selected.revision;
          return (
            <div key={`${rev.id}@${rev.revision}`}
              onClick={()=>{
                setSelected(rev);
                const prev = revisions.find(r => r.revision === rev.revision - 1);
                setCompareRevNum(prev ? prev.revision : "");
              }}
              style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                padding:"8px 12px",borderRadius:9,cursor:"pointer",
                border:`1.5px solid ${isSelected?T.navyLight:T.border}`,
                background:isSelected?T.navy+"0D":T.white}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:11,fontWeight:900,color:T.navy,fontFamily:font.mono}}>
                  Rev.{rev.revision}
                </span>
                {isLatest && (
                  <span style={{fontSize:9,padding:"2px 7px",borderRadius:10,
                    background:T.blueBg,color:T.blue,border:`1px solid ${T.blue}`,
                    fontFamily:font.mono,fontWeight:700}}>현재</span>
                )}
                {rev.mocId && (
                  <span style={{fontSize:9,padding:"2px 7px",borderRadius:10,
                    background:T.bg,color:T.sub,border:`1px solid ${T.border}`,
                    fontFamily:font.mono}}>MOC {rev.mocId}</span>
                )}
              </div>
              <span style={{fontSize:9,color:T.gray,fontFamily:font.mono}}>
                {rev.revision === 1 ? "최초 등록" : "개정"}
              </span>
            </div>
          );
        })}
      </div>

      {/* 선택된 Revision 상세 (읽기 전용) */}
      {selected && (
        <div style={{background:T.bg,borderRadius:12,padding:"12px 13px",
          border:`1px solid ${T.border}`,marginBottom:12}}>
          <div style={{fontSize:10,fontWeight:700,color:T.sub,fontFamily:font.mono,
            marginBottom:10,letterSpacing:1}}>
            Rev.{selected.revision} 상세
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            {fields.map(([k,label]) => (
              <div key={k}>
                <div style={{fontSize:9,color:T.gray,fontFamily:font.mono}}>{label}</div>
                <div style={{fontSize:11,fontWeight:700,color:T.navyLight,fontFamily:font.mono}}>
                  {Array.isArray(selected[k]) ? (selected[k].join(", ") || "—")
                    : (selected[k] ?? "—") === "" ? "—" : String(selected[k] ?? "—")}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* B2: 변경사항(Diff) — 읽기 전용. 쓰기 콜백 없음, diffEquipmentRevision/
          diffDischargeSystemRevision 결과를 그대로 표시만 한다. */}
      {selected && revisions.length > 1 && (
        <div style={{background:T.white,borderRadius:12,padding:"12px 13px",
          border:`1px solid ${T.border}`,marginBottom:12}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
            marginBottom:10}}>
            <div style={{fontSize:10,fontWeight:700,color:T.sub,fontFamily:font.mono,
              letterSpacing:1}}>변경사항 (Diff)</div>
            <select value={compareRevNum} onChange={e=>setCompareRevNum(e.target.value)}
              style={{fontSize:9,fontFamily:font.mono,padding:"3px 6px",
                borderRadius:6,border:`1px solid ${T.border}`,color:T.sub,background:T.bg}}>
              <option value="">비교 안 함</option>
              {revisions.filter(r=>r.revision!==selected.revision).map(r=>(
                <option key={r.revision} value={r.revision}>Rev.{r.revision}과 비교</option>
              ))}
            </select>
          </div>
          {!compareRev ? (
            <div style={{fontSize:10,color:T.gray,fontFamily:font.mono}}>
              비교 대상을 선택하세요.
            </div>
          ) : diff.length === 0 ? (
            <div style={{fontSize:10,color:T.gray,fontFamily:font.mono}}>
              Rev.{compareRev.revision} → Rev.{selected.revision}: 변경된 필드 없음
            </div>
          ) : (
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {diff.map(c => (
                <div key={c.field} style={{display:"flex",alignItems:"center",
                  justifyContent:"space-between",fontSize:11,fontFamily:font.mono}}>
                  <span style={{color:T.sub}}>{fieldLabel(c.field)}</span>
                  <span style={{fontWeight:700,color:T.navyLight}}>
                    {String(c.from ?? "—")} → <span style={{color:T.orange}}>{String(c.to ?? "—")}</span>
                    {c.unit ? ` ${c.unit}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* B3: 영향도(Impact) — 읽기 전용. analyzeRevisionImpact() 결과를 그대로 표시만 한다. */}
      {selected && impact && (
        <div style={{background:T.white,borderRadius:12,padding:"12px 13px",
          border:`1px solid ${T.border}`}}>
          <div style={{fontSize:10,fontWeight:700,color:T.sub,fontFamily:font.mono,
            marginBottom:10,letterSpacing:1}}>영향도 (Impact) — Rev.{selected.revision}</div>
          {impact.affectedSnapshots.length === 0 ? (
            <div style={{fontSize:10,color:T.gray,fontFamily:font.mono}}>
              이 Revision을 사용한 Case가 아직 없습니다.
            </div>
          ) : (
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              <div>
                <div style={{fontSize:9,color:T.gray,fontFamily:font.mono}}>사용 중인 Case</div>
                <div style={{fontSize:14,fontWeight:900,color:T.navy,fontFamily:font.mono}}>
                  {impact.affectedCases.length}건
                </div>
              </div>
              <div>
                <div style={{fontSize:9,color:T.gray,fontFamily:font.mono}}>영향받는 Snapshot</div>
                <div style={{fontSize:14,fontWeight:900,color:T.navy,fontFamily:font.mono}}>
                  {impact.affectedSnapshots.length}건
                </div>
              </div>
              <div>
                <div style={{fontSize:9,color:T.gray,fontFamily:font.mono}}>현재도 최신으로 사용 중</div>
                <div style={{fontSize:14,fontWeight:900,color:T.blue,fontFamily:font.mono}}>
                  {impact.latestAffected.length}건
                </div>
              </div>
              <div>
                <div style={{fontSize:9,color:T.gray,fontFamily:font.mono}}>이미 대체됨(과거 이력)</div>
                <div style={{fontSize:14,fontWeight:900,color:T.gray,fontFamily:font.mono}}>
                  {impact.obsoleteSnapshots.length}건
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── EquipmentCard ─────────────────────────────────────────────
function EquipmentCard({ eq, dischargeSystem, onSelect, onEdit, onViewHistory }) {
  const ds = dischargeSystem;
  return (
    <div
      style={{display:"block",width:"100%",textAlign:"left",
        background:T.cardBg,borderRadius:14,padding:"13px 15px",
        marginBottom:10,border:`1.5px solid ${T.border}`,
        boxShadow:"0 2px 6px #0001",
        fontFamily:font.sans}}>
      <div style={{display:"flex",alignItems:"flex-start",
        justifyContent:"space-between",marginBottom:5}}>
        <div>
          <div style={{fontSize:15,fontWeight:900,color:T.navy,fontFamily:font.mono}}>
            {eq.tag}
            <span style={{marginLeft:6,fontSize:9,fontWeight:700,color:T.sub}}>
              Rev.{eq.revision ?? 1}
            </span>
          </div>
          <div style={{fontSize:10,color:T.sub,fontFamily:font.mono,marginTop:1}}>
            {eq.location}
          </div>
        </div>
        <div style={{display:"flex",gap:5,flexShrink:0}}>
          <span style={{fontSize:9,padding:"2px 7px",borderRadius:10,
            background:T.blueBg,color:T.blue,border:`1px solid ${T.blue}`,
            fontFamily:font.mono,fontWeight:700}}>
            {eq.orifice||"?"}
          </span>
          <span style={{fontSize:9,padding:"2px 7px",borderRadius:10,
            background:T.bg,color:T.sub,border:`1px solid ${T.border}`,
            fontFamily:font.mono}}>
            {eq.deviceType==="safetyValve"?"S.V":"R.D"}
          </span>
        </div>
      </div>

      <div style={{display:"flex",gap:6,marginBottom:ds?6:0}}>
        {[
          ["SET",  `${eq.setPressure}b`],
          ["OP",   `${eq.overpressure}%`],
          ["MAWP", `${eq.mawp}b`],
          ["IN/OUT",`${eq.inletSize}/${eq.outletSize}`],
        ].map(([k,v])=>(
          <div key={k} style={{background:T.bg,borderRadius:6,
            padding:"3px 8px",flex:1,textAlign:"center"}}>
            <div style={{fontSize:8,color:T.gray,fontFamily:font.mono}}>{k}</div>
            <div style={{fontSize:11,fontWeight:700,color:T.navyLight,
              fontFamily:font.mono}}>{v}</div>
          </div>
        ))}
      </div>

      {ds && (
        <div style={{background:T.blueBg,borderRadius:8,padding:"5px 10px",
          fontSize:10,color:T.navyLight,fontFamily:font.mono,display:"flex",
          alignItems:"center",justifyContent:"space-between"}}>
          <span>⟶ {ds.name}</span>
          <span>{ds.destination==="flare"?"플레어":ds.destination==="atm"?"대기":"밀폐"} · L={ds.L}m · Ø{Math.round(ds.D*1000)}mm</span>
        </div>
      )}

      <div style={{marginTop:8,display:"flex",gap:8,justifyContent:"flex-end"}}>
        <button onClick={()=>onViewHistory(eq)}
          style={{padding:"5px 12px",background:T.white,color:T.sub,
            border:`1px solid ${T.border}`,borderRadius:8,
            fontSize:10,fontWeight:700,fontFamily:font.mono,cursor:"pointer"}}>
          이력 보기
        </button>
        <button onClick={()=>onEdit(eq)}
          style={{padding:"5px 12px",background:T.bg,color:T.navyLight,
            border:`1px solid ${T.navyLight}`,borderRadius:8,
            fontSize:10,fontWeight:700,fontFamily:font.mono,cursor:"pointer"}}>
          설비 개정 (MOC) →
        </button>
        <button onClick={()=>onSelect(eq)}
          style={{padding:"5px 12px",background:T.navyLight,color:T.white,
            border:"none",borderRadius:8,
            fontSize:10,fontWeight:700,fontFamily:font.mono,cursor:"pointer"}}>
          이 설비로 검토 시작 →
        </button>
      </div>
    </div>
  );
}

// ── AssetMaster ───────────────────────────────────────────────
function AssetMaster({ equipments, dischargeSystems,
                       equipmentHistory, dischargeHistory, allSnapshots,
                       onSelectEquipment,
                       onAddEquipment, onReviseEquipment,
                       onAddDischargeSystem,
                       onReviseDischargeSystem, onBack }) {
  const [tab,      setTab]      = useState("equipment"); // equipment | discharge
  const [showEqForm, setShowEqForm] = useState(false);
  const [showDsForm, setShowDsForm] = useState(false);
  const [editingEq,  setEditingEq]  = useState(null); // 개정 대상 Equipment
  const [editingDs,  setEditingDs]  = useState(null); // 개정 대상 DischargeSystem
  const [viewingEqHistory, setViewingEqHistory] = useState(null); // B1: 이력 조회 대상 Equipment id
  const [viewingDsHistory, setViewingDsHistory] = useState(null); // B1: 이력 조회 대상 DischargeSystem id

  // Equipment에 매칭되는 DischargeSystem 찾기
  const findDs = (eq) => dischargeSystems.find(
    ds => ds.connectedTags.includes(eq.tag)
  ) || null;

  const Tab = ({id, label}) => (
    <button onClick={()=>setTab(id)}
      style={{flex:1,padding:"9px",border:"none",borderRadius:9,cursor:"pointer",
        fontSize:12,fontWeight:700,fontFamily:font.mono,
        background:tab===id?T.navyLight:T.bg,
        color:tab===id?T.white:T.sub,
        boxShadow:tab===id?`0 3px 0 ${T.navy}`:"0 2px 0 #ccc"}}>
      {label}
    </button>
  );

  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
        <button onClick={onBack}
          style={{padding:"8px 12px",background:T.bg,border:`1px solid ${T.border}`,
            borderRadius:9,fontSize:13,fontWeight:700,color:T.sub,
            fontFamily:font.mono,cursor:"pointer"}}>←</button>
        <div>
          <div style={{fontSize:16,fontWeight:900,color:T.navy,fontFamily:font.mono}}>
            설비대장
          </div>
          <div style={{fontSize:10,color:T.sub,fontFamily:font.sans}}>
            PSV 설비 선택 → 검토 시작
          </div>
        </div>
      </div>

      {/* 탭 */}
      <div style={{display:"flex",gap:6,marginBottom:14}}>
        <Tab id="equipment" label={`🔧 설비 (${equipments.length})`}/>
        <Tab id="discharge" label={`⟶ 배출계통 (${dischargeSystems.length})`}/>
      </div>

      {/* Equipment 탭 */}
      {tab === "equipment" && (
        <>
          {!showEqForm && !editingEq && equipments.length > 0 && (
            <div style={{background:T.blueBg,border:`1px solid ${T.blue}`,borderRadius:10,
              padding:"10px 14px",marginBottom:12,fontSize:12,color:T.navyLight,
              fontFamily:font.sans,fontWeight:600}}>
              ↓ 아래 설비 카드에서 <b>"이 설비로 검토 시작"</b>을 누르면 그 설비 사양이 자동으로
              채워진 검토 화면으로 넘어갑니다.
            </div>
          )}
          {showEqForm && (
            <div style={{marginBottom:12}}>
              <EquipmentForm
                onSave={eq=>{ onAddEquipment(eq); setShowEqForm(false); }}
                onCancel={()=>setShowEqForm(false)}/>
            </div>
          )}
          {editingEq && (
            <div style={{marginBottom:12}}>
              <EquipmentForm
                editing={editingEq}
                onSave={eq=>{ onReviseEquipment(eq); setEditingEq(null); }}
                onCancel={()=>setEditingEq(null)}/>
            </div>
          )}
          {viewingEqHistory && (
            <RevisionHistoryPanel
              title={viewingEqHistory}
              history={equipmentHistory}
              id={viewingEqHistory}
              kind="equipment"
              allSnapshots={allSnapshots}
              onClose={()=>setViewingEqHistory(null)}/>
          )}
          {equipments.length === 0 ? (
            <div style={{textAlign:"center",padding:"40px 20px",color:T.gray}}>
              <div style={{fontSize:36,marginBottom:8}}>🔧</div>
              <div style={{fontSize:13,color:T.sub}}>등록된 설비가 없습니다</div>
            </div>
          ) : (
            equipments.map(eq => (
              <EquipmentCard key={eq.id} eq={eq} dischargeSystem={findDs(eq)}
                onSelect={onSelectEquipment} onEdit={setEditingEq}
                onViewHistory={(e)=>setViewingEqHistory(e.id)}/>
            ))
          )}
          {!showEqForm && !editingEq && (
            <button onClick={()=>setShowEqForm(true)}
              style={{width:"100%",padding:"10px",background:"transparent",color:T.sub,
                border:`1px dashed ${T.border}`,borderRadius:12,fontSize:12,fontWeight:700,
                fontFamily:font.sans,cursor:"pointer",marginTop:equipments.length?12:0}}>
              + 새 설비 등록 (목록에 없는 신규 설비만)
            </button>
          )}
        </>
      )}

      {/* DischargeSystem 탭 */}
      {tab === "discharge" && (
        <>
          {!showDsForm && !editingDs && (
            <button onClick={()=>setShowDsForm(true)}
              style={{width:"100%",padding:"12px",background:T.navyLight,color:T.white,
                border:"none",borderRadius:12,fontSize:13,fontWeight:900,
                fontFamily:font.sans,cursor:"pointer",boxShadow:`0 4px 0 ${T.navy}`,
                marginBottom:12}}>
              + 배출계통 등록
            </button>
          )}
          {showDsForm && (
            <div style={{marginBottom:12}}>
              <DischargeSystemForm
                onSave={ds=>{ onAddDischargeSystem(ds); setShowDsForm(false); }}
                onCancel={()=>setShowDsForm(false)}/>
            </div>
          )}
          {editingDs && (
            <div style={{marginBottom:12}}>
              <DischargeSystemForm
                editing={editingDs}
                onSave={ds=>{ onReviseDischargeSystem(ds); setEditingDs(null); }}
                onCancel={()=>setEditingDs(null)}/>
            </div>
          )}
          {viewingDsHistory && (
            <RevisionHistoryPanel
              title={viewingDsHistory}
              history={dischargeHistory}
              id={viewingDsHistory}
              kind="discharge"
              allSnapshots={allSnapshots}
              onClose={()=>setViewingDsHistory(null)}/>
          )}
          {dischargeSystems.length === 0 ? (
            <div style={{textAlign:"center",padding:"40px 20px",color:T.gray}}>
              <div style={{fontSize:36,marginBottom:8}}>⟶</div>
              <div style={{fontSize:13,color:T.sub}}>등록된 배출계통이 없습니다</div>
            </div>
          ) : (
            dischargeSystems.map(ds => (
              <div key={ds.id}
                style={{background:T.cardBg,borderRadius:14,padding:"13px 15px",
                  marginBottom:10,border:`1.5px solid ${T.border}`}}>
                <div style={{display:"flex",alignItems:"center",
                  justifyContent:"space-between",marginBottom:6}}>
                  <div style={{fontSize:14,fontWeight:900,color:T.navy,fontFamily:font.mono}}>
                    {ds.name}
                    <span style={{marginLeft:6,fontSize:9,fontWeight:700,color:T.sub}}>
                      Rev.{ds.revision}
                    </span>
                  </div>
                  <span style={{fontSize:10,padding:"3px 9px",borderRadius:10,
                    background:T.blueBg,color:T.blue,border:`1px solid ${T.blue}`,
                    fontFamily:font.mono,fontWeight:700}}>
                    {DESTINATION_LABEL[ds.destination]}
                  </span>
                </div>
                <div style={{display:"flex",gap:6}}>
                  {[
                    ["L", `${ds.L}m`],
                    ["D", `Ø${Math.round(ds.D*1000)}mm`],
                    ["ΣK", ds.fittingsK],
                    ["P_hdr", `${ds.headerPressure}b`],
                  ].map(([k,v])=>(
                    <div key={k} style={{background:T.bg,borderRadius:6,
                      padding:"3px 8px",flex:1,textAlign:"center"}}>
                      <div style={{fontSize:8,color:T.gray,fontFamily:font.mono}}>{k}</div>
                      <div style={{fontSize:11,fontWeight:700,color:T.navyLight,
                        fontFamily:font.mono}}>{v}</div>
                    </div>
                  ))}
                </div>
                {ds.connectedTags.length > 0 && (
                  <div style={{marginTop:6,fontSize:10,color:T.sub,fontFamily:font.mono}}>
                    연결: {ds.connectedTags.join(", ")}
                  </div>
                )}
                <div style={{marginTop:8,display:"flex",gap:8,justifyContent:"flex-end"}}>
                  <button onClick={()=>setViewingDsHistory(ds.id)}
                    style={{padding:"5px 12px",background:T.white,color:T.sub,
                      border:`1px solid ${T.border}`,borderRadius:8,
                      fontSize:10,fontWeight:700,fontFamily:font.mono,cursor:"pointer"}}>
                    이력 보기
                  </button>
                  <button onClick={()=>setEditingDs(ds)}
                    style={{padding:"5px 12px",background:T.bg,color:T.navyLight,
                      border:`1px solid ${T.navyLight}`,borderRadius:8,
                      fontSize:10,fontWeight:700,fontFamily:font.mono,cursor:"pointer"}}>
                    배관 개정 (MOC) →
                  </button>
                </div>
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}
