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

// C-4.28: 샘플(예시) 데이터를 실제 사용자 데이터와 시각적으로 구분하기
// 위한 판별 상수. SAMPLE_EQUIPMENT/SAMPLE_DISCHARGE_SYSTEMS(asset/schema.js)
// 데이터 자체나 스키마는 전혀 바꾸지 않는다 — UI 표시 판단에만 쓰는 순수
// 참조용 Set. (한계: 사용자가 우연히 같은 tag/name으로 직접 등록하면
// 샘플로 오분류될 수 있음 — 낮은 확률의 표시 전용 리스크로 감수)
const SAMPLE_EQUIPMENT_TAGS = new Set(SAMPLE_EQUIPMENT.map(e=>e.tag));
const SAMPLE_DS_NAMES = new Set(SAMPLE_DISCHARGE_SYSTEMS.map(d=>d.name));

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
    inletPiping: editing.inletPiping
      ? { L: String(editing.inletPiping.L), D: String(editing.inletPiping.D), fittingsK: String(editing.inletPiping.fittingsK) }
      : { L:"", D:"", fittingsK:"" },
    mocId: "",
  } : {
    tag:"", location:"", deviceType:"safetyValve",
    mawp:6.0, setPressure:5.5, overpressure:10,
    inletSize:"3\"", outletSize:"4\"", orifice:"",
    manufacturer:"", model:"", serialNo:"", installedAt:"",
    inletPiping: { L:"", D:"", fittingsK:"" },
    mocId:"",
  });
  const upd = (k,v) => setF(p=>({...p,[k]:v}));
  const updInlet = (k,v) => setF(p=>({...p, inletPiping:{...p.inletPiping, [k]:v}}));
  const psetErr = f.setPressure > f.mawp;
  // INLET-LOSS-001: 인입배관은 선택 항목 — 3개 다 비어있으면 "미등록"으로
  // 저장(null). 일부만 채워진 상태는 부정확한 판정으로 이어지므로 저장을
  // 막는다(fail-fast) — 임의로 나머지를 기본값으로 채우지 않는다.
  const ipAllEmpty = f.inletPiping.L === "" && f.inletPiping.D === "" && f.inletPiping.fittingsK === "";
  const ipPartial = !ipAllEmpty && (f.inletPiping.L === "" || f.inletPiping.D === "" || f.inletPiping.fittingsK === "");
  const ipInvalid = !ipAllEmpty && !ipPartial && (
    isNaN(Number(f.inletPiping.L)) || isNaN(Number(f.inletPiping.D)) || isNaN(Number(f.inletPiping.fittingsK)) ||
    Number(f.inletPiping.D) <= 0 || Number(f.inletPiping.L) < 0 || Number(f.inletPiping.fittingsK) < 0
  );
  const valid = f.tag.trim() && f.mawp>0 && f.setPressure>0 && !psetErr &&
    f.overpressure !== "" && f.overpressure !== null && !isNaN(Number(f.overpressure)) && Number(f.overpressure) >= 0 &&
    !ipPartial && !ipInvalid &&
    (!isRevision || f.mocId.trim().length > 0);

  const handleSave = () => {
    if (!valid) return;
    const inletPipingPayload = ipAllEmpty ? null : {
      L: Number(f.inletPiping.L), D: Number(f.inletPiping.D), fittingsK: Number(f.inletPiping.fittingsK),
    };
    const payload = { ...f, inletPiping: inletPipingPayload };
    if (isRevision) {
      const result = reviseEquipment(editing, payload);
      if (!result.ok) { alert(`${result.field}: ${result.reason}`); return; }
      onSave(result.equipment);
      return;
    }
    try { onSave(createEquipment(payload)); } catch(e) { alert(e.message); }
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
            onChange={e=>{ if(!isRevision) upd("tag",e.target.value); }}
            onInput={e=>{ if(!isRevision) upd("tag",e.target.value); }}
            placeholder="PSV-R201" autoComplete="off"
            disabled={isRevision}
            style={iS({
              border:`1.5px solid ${f.tag.trim()?T.navyLight:T.border}`,
              background:isRevision?T.bg:T.white,
              color:isRevision?T.sub:T.text,
              cursor:isRevision?"not-allowed":"text",
            })}/>
            {isRevision && (
              <div style={{fontSize:9,color:T.gray,fontFamily:font.sans,marginTop:3}}>
                Tag No.는 배출계통 연결의 식별자로 사용되므로 개정 시 변경할 수 없습니다.
              </div>
            )}
          </Field>}
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

      <Section title="인입배관 (선택 — KOSHA D-18-2020 §7.2(1) 압력손실 3% 판정용)">
        <div style={{fontSize:9,color:T.gray,fontFamily:font.sans,marginBottom:8,lineHeight:1.5}}>
          설치대상 용기에서 이 안전밸브 인입 플랜지까지의 실제 배관 형상.
          위 "입구 Size"({f.inletSize || "—"})는 명목 규격 표시일 뿐 — 여기 입력한
          값만 계산에 실제로 쓰입니다. 3개 다 비워두면 미등록(판정 보류) 처리됩니다.
        </div>
        <Row2
          a={<Field label="배관 길이 L (m)">
            <input type="number" value={f.inletPiping.L} step={0.1}
              onChange={e=>updInlet("L",e.target.value)}
              placeholder="예: 3.5" style={iS()}/>
          </Field>}
          b={<Field label="배관 내경 D (m)">
            <input type="number" value={f.inletPiping.D} step={0.001}
              onChange={e=>updInlet("D",e.target.value)}
              placeholder="예: 0.08" style={iS()}/>
          </Field>}
        />
        <Field label="배관 부속 저항계수 ΣK">
          <input type="number" value={f.inletPiping.fittingsK} step={0.1}
            onChange={e=>updInlet("fittingsK",e.target.value)}
            placeholder="예: 1.5" style={iS()}/>
        </Field>
        {ipPartial && (
          <div style={{fontSize:10,color:T.red,fontFamily:font.sans,marginTop:-6,marginBottom:10}}>
            L / D / ΣK 중 일부만 입력됐습니다 — 3개 모두 입력하거나 모두 비워두세요 (임의 기본값을 채우지 않습니다).
          </div>
        )}
        {ipInvalid && (
          <div style={{fontSize:10,color:T.red,fontFamily:font.sans,marginTop:-6,marginBottom:10}}>
            내경(D)은 0보다 커야 하고, 길이(L)·ΣK는 0 이상이어야 합니다.
          </div>
        )}
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
// C-4.28: connectedTags 검증을 공용 함수로 분리. DischargeSystemForm(개정
// 경로)과 DischargeSystemWizard(신규 등록 경로) 양쪽에서 재사용한다.
// Wizard의 "② 연결 설비" 단계는 체크박스라 존재하지 않는 Tag·중복 claim을
// 구조적으로 애초에 만들 수 없지만, UI를 우회하거나 state가 변조된 경우에
// 대비해 저장 시점에는 반드시 이 함수를 다시 돌린다 — C-4.27 검증 자체를
// 대체하는 게 아니라 최종 방어선으로 유지(WF-006). 판정 기준은 C-4.27과
// 완전히 동일(trim 후 완전일치) — 새 normalization 도입하지 않음.
function validateConnectedTags(rawTags, equipments, dischargeSystems, selfId) {
  const seenTags = new Set();
  const internalDupTags = [];
  for (const t of rawTags) {
    if (seenTags.has(t)) internalDupTags.push(t);
    seenTags.add(t);
  }
  const knownTagSet = new Set((equipments||[]).map(e=>e.tag));
  const unknownTags = [...new Set(rawTags.filter(t => !knownTagSet.has(t)))];
  const otherDs = (dischargeSystems||[]).filter(ds => ds.id !== selfId);
  const conflicts = [];
  for (const t of new Set(rawTags)) {
    const owner = otherDs.find(ds => (ds.connectedTags||[]).includes(t));
    if (owner) conflicts.push({ tag:t, ownerName: owner.name });
  }
  const tagsValid = internalDupTags.length===0 && unknownTags.length===0 && conflicts.length===0;
  return { internalDupTags, unknownTags, conflicts, tagsValid };
}

function DischargeSystemForm({ onSave, onCancel, editing, equipments, dischargeSystems }) {
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

  const rawTags = f.connectedTags.split(",").map(t=>t.trim()).filter(Boolean);
  const { internalDupTags, unknownTags, conflicts, tagsValid } =
    validateConnectedTags(rawTags, equipments, dischargeSystems, isRevision ? editing.id : null);
  const valid = f.name.trim() && f.D > 0 && f.L >= 0 && tagsValid &&
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
            placeholder="PSV-R201, PSV-R202"
            style={iS({border:`1.5px solid ${tagsValid?T.border:T.red}`})}/>
          <div style={{fontSize:9,color:T.gray,fontFamily:font.sans,marginTop:3}}>
            이 계통을 공유하는 PSV tag를 쉼표로 구분해 입력
          </div>
          {unknownTags.length > 0 && (
            <div style={{fontSize:10,color:T.red,fontFamily:font.sans,marginTop:4}}>
              등록된 설비에서 찾을 수 없는 Tag가 있습니다: {unknownTags.join(", ")}
            </div>
          )}
          {conflicts.length > 0 && (
            <div style={{fontSize:10,color:T.red,fontFamily:font.sans,marginTop:4}}>
              이미 다른 배출계통에 연결되어 있습니다: {conflicts.map(c=>`${c.tag} (${c.ownerName})`).join(", ")}
            </div>
          )}
          {internalDupTags.length > 0 && (
            <div style={{fontSize:10,color:T.red,fontFamily:font.sans,marginTop:4}}>
              중복 입력된 Tag가 있습니다: {[...new Set(internalDupTags)].join(", ")}
            </div>
          )}
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

// ── DischargeSystemWizard (C-4.28) ─────────────────────────────
// 신규 배출계통 등록 전용 Guided Workflow. ①기본정보→②연결설비→③배관조건
// →④검토→⑤완료. 개정(Revision) 경로는 이번 범위 밖 — 기존
// DischargeSystemForm을 그대로 쓴다(MOC 근거·단일 화면 diff 성격이 강해
// 마법사화 이득이 적음, C-4.28은 "신규 등록"만 다룬다고 명시된 범위).
//
// Wizard UI state(step, 입력 draft)와 domain 저장 모델(connectedTags:
// string[])을 분리한다 — draft.selectedTags(체크박스 선택 결과, 배열)를
// 저장 직전에만 기존 connectedTags 표현으로 흘려보내고, schema/検증 함수는
// 전혀 새로 만들지 않는다(createDischargeSystem·validateConnectedTags 재사용).
const DS_WIZARD_STEPS = ["기본정보","연결 설비","배관 조건","검토","완료"];

function WizardStepIndicator({ step }) {
  return (
    <div style={{display:"flex",gap:4,marginBottom:16}}>
      {DS_WIZARD_STEPS.map((label,i)=>{
        const n = i+1;
        const state = n<step ? "done" : n===step ? "current" : "todo";
        return (
          <div key={label} style={{flex:1,textAlign:"center"}}>
            <div style={{
              width:22,height:22,borderRadius:"50%",margin:"0 auto 3px",
              display:"flex",alignItems:"center",justifyContent:"center",
              fontSize:10,fontWeight:900,fontFamily:font.mono,
              background: state==="done"?T.navyLight : state==="current"?T.navy : T.bg,
              color: state==="todo"?T.gray:T.white,
              border:`1.5px solid ${state==="todo"?T.border:T.navyLight}`,
            }}>{state==="done"?"✓":n}</div>
            <div style={{fontSize:8,fontFamily:font.sans,
              color:state==="current"?T.navy:T.gray,
              fontWeight:state==="current"?800:400}}>{label}</div>
          </div>
        );
      })}
    </div>
  );
}

function WizardNav({ onBack, onNext, onCancel, nextLabel, nextDisabled }) {
  return (
    <div style={{display:"flex",gap:8,marginTop:14}}>
      {onCancel && (
        <button onClick={onCancel} style={{padding:"12px 14px",background:T.bg,
          color:T.sub,border:`1px solid ${T.border}`,borderRadius:11,fontSize:12,
          fontWeight:700,fontFamily:font.mono,cursor:"pointer"}}>취소</button>
      )}
      {onBack && (
        <button onClick={onBack} style={{padding:"12px 14px",background:T.white,
          color:T.navy,border:`1.5px solid ${T.border}`,borderRadius:11,fontSize:12,
          fontWeight:700,fontFamily:font.mono,cursor:"pointer"}}>← 이전</button>
      )}
      <button onClick={onNext} disabled={nextDisabled}
        style={{flex:1,padding:"12px",
          background:nextDisabled?"#CBD5E1":T.navyLight,
          color:T.white,border:"none",borderRadius:11,fontSize:13,
          fontWeight:900,fontFamily:font.sans,
          cursor:nextDisabled?"not-allowed":"pointer",
          boxShadow:nextDisabled?"none":`0 4px 0 ${T.navy}`}}>
        {nextLabel}
      </button>
    </div>
  );
}

function DischargeSystemWizard({ equipments, dischargeSystems, onSave, onDone, onCancel }) {
  const [step, setStep] = useState(1);
  const [data, setData] = useState({
    name:"", destination:"flare",
    L:15, D:0.1, fittingsK:3.0, headerPressure:0.3,
    selectedTags: [],
  });
  const [saveError, setSaveError] = useState(null);
  const [savedDs, setSavedDs] = useState(null);
  const upd = (k,v) => setData(p=>({...p,[k]:v}));

  // WF-007: 아직 아무것도 입력 안 한 첫 화면에서는 확인 없이 바로 취소,
  // 그 외(Step 진행 또는 이름 입력)에는 실수로 잃지 않도록 확인을 받는다.
  const touched = step>1 || data.name.trim().length>0 || data.selectedTags.length>0;
  const handleCancel = () => {
    if (touched && !window.confirm("입력 중인 내용이 있습니다. 등록을 취소하시겠습니까?")) return;
    onCancel();
  };

  // 이미 다른 배출계통이 claim한 tag → 소유 DS 이름 맵(체크박스 비활성화용)
  const claimMap = new Map();
  (dischargeSystems||[]).forEach(ds => (ds.connectedTags||[]).forEach(t => claimMap.set(t, ds.name)));
  const toggleTag = (tag) => {
    if (claimMap.has(tag)) return; // 이미 연결된 설비는 선택 자체가 불가
    setData(p => ({...p, selectedTags: p.selectedTags.includes(tag)
      ? p.selectedTags.filter(t=>t!==tag)
      : [...p.selectedTags, tag]}));
  };

  const step1Valid = data.name.trim().length > 0;
  const step3Valid = data.D > 0 && data.L >= 0;

  const handleSubmit = () => {
    setSaveError(null);
    const rawTags = data.selectedTags;
    // C-4.27 최종 방어선 — WF-006: UI가 이미 막아주지만 저장 직전 재검증.
    const v = validateConnectedTags(rawTags, equipments, dischargeSystems, null);
    if (!v.tagsValid) {
      setSaveError(
        v.unknownTags.length ? `등록된 설비에서 찾을 수 없는 Tag가 있습니다: ${v.unknownTags.join(", ")}` :
        v.conflicts.length ? `이미 다른 배출계통에 연결되어 있습니다: ${v.conflicts.map(c=>`${c.tag} (${c.ownerName})`).join(", ")}` :
        `중복 입력된 Tag가 있습니다: ${[...new Set(v.internalDupTags)].join(", ")}`
      );
      return;
    }
    try {
      const ds = createDischargeSystem({
        name: data.name, destination: data.destination,
        L: data.L, D: data.D, fittingsK: data.fittingsK,
        headerPressure: data.headerPressure,
        connectedTags: rawTags,
      });
      onSave(ds);         // 앱 state/persistence에 등록(기존 onAddDischargeSystem 그대로)
      setSavedDs(ds);
      setStep(5);          // WF-008: 실패 시에는 여기 도달하지 않고 입력값 유지
    } catch(e) {
      // WF-008: 완료 화면으로 넘어가지 않고, 입력값 그대로 유지, 재시도 가능.
      // (참고: 현재 저장 경로는 IndexedDB 쓰기를 fire-and-forget으로 처리해
      // 비동기 저장 실패 신호 자체가 앱 전역에 없음 — 이 catch는 createDischargeSystem
      // 자체의 동기 검증 실패만 잡는다. 비동기 저장 실패 감지는 이번 범위 밖.)
      setSaveError(e.message || "등록하지 못했습니다. 입력 내용은 유지되어 있습니다. 잠시 후 다시 시도하세요.");
    }
  };

  const cardStyle = (state) => ({
    display:"flex",alignItems:"center",gap:10,padding:"12px 14px",
    borderRadius:11,marginBottom:8,
    cursor: state==="disabled" ? "not-allowed" : "pointer",
    border:`1.5px solid ${state==="selected"?T.navyLight:state==="disabled"?T.border:T.border}`,
    background: state==="selected"?T.navy+"0D" : state==="disabled"?T.bg : T.white,
    opacity: state==="disabled" ? 0.72 : 1,
    minHeight:44, // 모바일 터치 영역 확보
  });

  return (
    <div style={{background:T.cardBg,borderRadius:16,padding:18,
      border:`1.5px solid ${T.border}`,boxShadow:"0 4px 16px #0002"}}>
      <WizardStepIndicator step={step}/>

      {step===1 && (
        <div>
          <div style={{fontSize:14,fontWeight:900,color:T.navy,fontFamily:font.mono,marginBottom:4}}>
            ① 기본정보
          </div>
          <div style={{fontSize:11,color:T.sub,fontFamily:font.sans,marginBottom:14}}>
            배출계통의 기본 정보를 입력하세요.
          </div>
          <Section title="계통 정보">
            <Field label="계통 명칭" req>
              <input value={data.name}
                onChange={e=>upd("name",e.target.value)}
                onInput={e=>upd("name",e.target.value)}
                placeholder="LP-FLARE-02" autoComplete="off"
                style={iS({border:`1.5px solid ${data.name.trim()?T.navyLight:T.border}`})}/>
            </Field>
            <Field label="배출 목적지">
              <div style={{display:"flex",gap:6}}>
                {DEST_OPTIONS.map(d=>(
                  <div key={d.id} onClick={()=>upd("destination",d.id)}
                    style={{flex:1,padding:"8px",borderRadius:9,cursor:"pointer",
                      textAlign:"center",
                      border:`2px solid ${data.destination===d.id?T.navyLight:T.border}`,
                      background:data.destination===d.id?T.navy+"0D":T.white}}>
                    <div style={{fontSize:11,fontWeight:700,
                      color:data.destination===d.id?T.navy:T.text,
                      fontFamily:font.sans}}>{d.label}</div>
                    <div style={{fontSize:9,color:T.sub}}>{d.note}</div>
                  </div>
                ))}
              </div>
            </Field>
          </Section>
          <WizardNav onCancel={handleCancel} onNext={()=>step1Valid && setStep(2)}
            nextLabel="다음 →" nextDisabled={!step1Valid}/>
        </div>
      )}

      {step===2 && (
        <div>
          <div style={{fontSize:14,fontWeight:900,color:T.navy,fontFamily:font.mono,marginBottom:4}}>
            ② 연결 설비
          </div>
          <div style={{fontSize:11,color:T.sub,fontFamily:font.sans,marginBottom:14}}>
            이 배출계통에 연결할 설비를 선택하세요. Tag를 직접 입력하지 않습니다 —
            등록된 설비 중에서 고르면 됩니다.
          </div>
          {(equipments||[]).length===0 ? (
            <div style={{fontSize:11,color:T.sub,fontFamily:font.sans,padding:"10px 0"}}>
              등록된 설비가 없습니다. 먼저 설비를 등록해주세요.
            </div>
          ) : (equipments||[]).map(eq=>{
            const claimedBy = claimMap.get(eq.tag);
            const selected = data.selectedTags.includes(eq.tag);
            const state = claimedBy ? "disabled" : selected ? "selected" : "normal";
            return (
              <div key={eq.id} role="checkbox" aria-checked={selected} aria-disabled={!!claimedBy}
                tabIndex={claimedBy?-1:0}
                onClick={()=>toggleTag(eq.tag)}
                onKeyDown={e=>{ if(!claimedBy && (e.key==="Enter"||e.key===" ")) { e.preventDefault(); toggleTag(eq.tag); } }}
                style={cardStyle(state)}>
                <span style={{fontSize:16,lineHeight:1}}>{claimedBy?"⛔":selected?"☑":"☐"}</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:800,fontFamily:font.mono,
                    color:claimedBy?T.gray:T.navy}}>{eq.tag}</div>
                  <div style={{fontSize:10,color:T.sub,fontFamily:font.sans}}>{eq.location}</div>
                  {claimedBy && (
                    <div style={{fontSize:10,color:T.red,fontFamily:font.sans,marginTop:2}}>
                      이미 다른 배출계통에 연결됨 — {claimedBy}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <WizardNav onCancel={handleCancel} onBack={()=>setStep(1)} onNext={()=>setStep(3)}
            nextLabel="다음 →"/>
        </div>
      )}

      {step===3 && (
        <div>
          <div style={{fontSize:14,fontWeight:900,color:T.navy,fontFamily:font.mono,marginBottom:4}}>
            ③ 배관 조건
          </div>
          <div style={{fontSize:11,color:T.sub,fontFamily:font.sans,marginBottom:14}}>
            배관 형상(도면 기준)을 입력하세요.
          </div>
          <Section title="배관 형상 (도면 기준)">
            <Row2
              a={<Field label="배관 길이 L (m)" req>
                <input type="number" value={data.L} step={0.5} min={0}
                  onChange={e=>upd("L",+e.target.value)} style={iS()}/>
              </Field>}
              b={<Field label="배관 내경 D (m)" req>
                <input type="number" value={data.D} step={0.005} min={0.01}
                  onChange={e=>upd("D",+e.target.value)}
                  style={iS({border:`1.5px solid ${data.D>0?T.border:T.red}`})}/>
              </Field>}
            />
            <Row2
              a={<Field label="Fittings ΣK">
                <input type="number" value={data.fittingsK} step={0.1} min={0}
                  onChange={e=>upd("fittingsK",+e.target.value)} style={iS()}/>
              </Field>}
              b={<Field label="Header 압력 (barg)">
                <input type="number" value={data.headerPressure} step={0.05} min={0}
                  onChange={e=>upd("headerPressure",+e.target.value)} style={iS()}/>
              </Field>}
            />
          </Section>
          <WizardNav onCancel={handleCancel} onBack={()=>setStep(2)}
            onNext={()=>step3Valid && setStep(4)} nextLabel="다음 →" nextDisabled={!step3Valid}/>
        </div>
      )}

      {step===4 && (()=>{
        const selectedEquip = (equipments||[]).filter(eq=>data.selectedTags.includes(eq.tag));
        return (
          <div>
            <div style={{fontSize:14,fontWeight:900,color:T.navy,fontFamily:font.mono,marginBottom:4}}>
              ④ 입력 내용 검토
            </div>
            <div style={{fontSize:11,color:T.sub,fontFamily:font.sans,marginBottom:14}}>
              저장하기 전에 입력한 내용을 확인하세요.
            </div>

            <Section title="기본정보">
              <div style={{fontSize:12,fontFamily:font.mono,color:T.text,marginBottom:4}}>
                계통 명칭: <b>{data.name || "—"}</b>
              </div>
              <div style={{fontSize:12,fontFamily:font.mono,color:T.text}}>
                배출 목적지: <b>{DEST_OPTIONS.find(d=>d.id===data.destination)?.label}</b>
              </div>
              <button onClick={()=>setStep(1)} style={{marginTop:8,fontSize:10,
                color:T.navyLight,background:"none",border:"none",cursor:"pointer",
                fontFamily:font.mono,fontWeight:700,padding:0}}>[수정]</button>
            </Section>

            <Section title="연결 설비">
              {selectedEquip.length===0 ? (
                <div style={{fontSize:11,color:T.sub,fontFamily:font.sans}}>선택된 설비 없음</div>
              ) : selectedEquip.map(eq=>(
                <div key={eq.id} style={{fontSize:12,fontFamily:font.mono,color:T.text,marginBottom:3}}>
                  {eq.tag} <span style={{color:T.sub,fontFamily:font.sans,fontSize:10}}>· {eq.location}</span>
                </div>
              ))}
              <button onClick={()=>setStep(2)} style={{marginTop:8,fontSize:10,
                color:T.navyLight,background:"none",border:"none",cursor:"pointer",
                fontFamily:font.mono,fontWeight:700,padding:0}}>[수정]</button>
            </Section>

            <Section title="배관 조건">
              <div style={{fontSize:12,fontFamily:font.mono,color:T.text,marginBottom:3}}>L = {data.L} m · D = {data.D} m</div>
              <div style={{fontSize:12,fontFamily:font.mono,color:T.text}}>ΣK = {data.fittingsK} · Header = {data.headerPressure} barg</div>
              <button onClick={()=>setStep(3)} style={{marginTop:8,fontSize:10,
                color:T.navyLight,background:"none",border:"none",cursor:"pointer",
                fontFamily:font.mono,fontWeight:700,padding:0}}>[수정]</button>
            </Section>

            {saveError && (
              <div style={{background:"#FEF2F2",border:`1px solid ${T.red}`,borderRadius:10,
                padding:"10px 12px",fontSize:11,color:T.red,fontFamily:font.sans,marginBottom:10}}>
                등록하지 못했습니다.<br/>{saveError}<br/>입력 내용은 유지되어 있습니다. 다시 시도해주세요.
              </div>
            )}

            <WizardNav onCancel={handleCancel} onBack={()=>setStep(3)}
              onNext={handleSubmit} nextLabel="배출계통 저장 →"/>
          </div>
        );
      })()}

      {step===5 && savedDs && (
        <div>
          <div style={{textAlign:"center",padding:"10px 0 18px"}}>
            <div style={{fontSize:32,marginBottom:8}}>✅</div>
            <div style={{fontSize:14,fontWeight:900,color:T.navy,fontFamily:font.mono}}>
              ⑤ 등록 완료
            </div>
            <div style={{fontSize:11,color:T.sub,fontFamily:font.sans,marginTop:4}}>
              배출계통이 정상적으로 등록되었습니다.
            </div>
          </div>
          <Section title="배출계통">
            <div style={{fontSize:13,fontWeight:800,fontFamily:font.mono,color:T.navy}}>{savedDs.name}</div>
          </Section>
          <Section title="연결 설비">
            {savedDs.connectedTags.length===0 ? (
              <div style={{fontSize:11,color:T.sub,fontFamily:font.sans}}>없음</div>
            ) : savedDs.connectedTags.map(tag=>(
              <div key={tag} style={{fontSize:12,fontFamily:font.mono,color:T.text}}>{tag}</div>
            ))}
          </Section>
          <button onClick={()=>onDone(savedDs)} style={{width:"100%",padding:"12px",
            background:T.navyLight,color:T.white,border:"none",borderRadius:11,
            fontSize:13,fontWeight:900,fontFamily:font.sans,cursor:"pointer",
            boxShadow:`0 4px 0 ${T.navy}`}}>
            설비대장으로 돌아가기
          </button>
        </div>
      )}
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
    // INLET-LOSS-001: dot-path 필드 — _getPath()로 읽어야 값이 나온다
    // (일반 selected[k] 방식은 중첩 객체라 undefined가 됨).
    ["inletPiping.L","인입배관 길이 L (m)"], ["inletPiping.D","인입배관 내경 D (m)"],
    ["inletPiping.fittingsK","인입배관 ΣK"],
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
                  {Array.isArray(_getPath(selected,k)) ? (_getPath(selected,k).join(", ") || "—")
                    : (_getPath(selected,k) ?? "—") === "" ? "—" : String(_getPath(selected,k) ?? "—")}
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
            {SAMPLE_EQUIPMENT_TAGS.has(eq.tag) && (
              <span style={{marginLeft:6,fontSize:8,padding:"1px 6px",borderRadius:8,
                background:"#F3F0FF",color:"#7C5CFC",border:"1px solid #D9CFFF",
                fontFamily:font.sans,fontWeight:700}}>예시</span>
            )}
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

      <div style={{display:"flex",gap:6,marginBottom:6}}>
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

      {ds ? (
        <div style={{background:T.blueBg,borderRadius:8,padding:"5px 10px",
          fontSize:10,color:T.navyLight,fontFamily:font.mono,display:"flex",
          alignItems:"center",justifyContent:"space-between"}}>
          <span>⟶ {ds.name}</span>
          <span>{ds.destination==="flare"?"플레어":ds.destination==="atm"?"대기":"밀폐"} · L={ds.L}m · Ø{Math.round(ds.D*1000)}mm</span>
        </div>
      ) : (
        // C-4.27 문제A(C-4.26 P2): 미연결 상태를 침묵시키지 않는다 — 장식용
        // 아이콘이 아니라 실제 계산에 영향(Kb=1.0 보수적 가정)을 준다는
        // 사실을 텍스트로 명시한다. GO로 바꾸거나 자동 연결하지 않음 —
        // 표시만 추가, Kb 계산 로직은 변경하지 않는다.
        <div style={{background:"#FEF3C7",borderRadius:8,padding:"5px 10px",
          fontSize:10,color:"#92400E",fontFamily:font.mono,border:"1px solid #FDE68A"}}>
          ⚠ 배출계통 미연결 · Kb 보수적 가정 적용
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
                       onReviseDischargeSystem, onBack,
                       autoOpenNewEquipmentForm }) {
  const [tab,      setTab]      = useState("equipment"); // equipment | discharge
  const [showEqForm, setShowEqForm] = useState(!!autoOpenNewEquipmentForm); // C-4.30
  const [showDsForm, setShowDsForm] = useState(false); // C-4.28: 이제 DischargeSystemWizard를 연다
  const [editingEq,  setEditingEq]  = useState(null); // 개정 대상 Equipment
  const [editingDs,  setEditingDs]  = useState(null); // 개정 대상 DischargeSystem
  const [viewingEqHistory, setViewingEqHistory] = useState(null); // B1: 이력 조회 대상 Equipment id
  const [viewingDsHistory, setViewingDsHistory] = useState(null); // B1: 이력 조회 대상 DischargeSystem id
  const [showSampleEq, setShowSampleEq] = useState(false); // C-4.28: 예시 설비는 기본 접힘(Secondary)

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
          {/* C-4.28: 새 설비 등록 = Primary CTA. 예시 데이터보다 먼저, 더 강조된 스타일 */}
          {!showEqForm && !editingEq && (
            <button onClick={()=>setShowEqForm(true)}
              style={{width:"100%",padding:"12px",background:T.navyLight,color:T.white,
                border:"none",borderRadius:12,fontSize:13,fontWeight:900,
                fontFamily:font.sans,cursor:"pointer",boxShadow:`0 4px 0 ${T.navy}`,
                marginBottom:14}}>
              + 새 설비 등록
            </button>
          )}
          {(() => {
            const realEq   = equipments.filter(eq=>!SAMPLE_EQUIPMENT_TAGS.has(eq.tag));
            const sampleEq = equipments.filter(eq=> SAMPLE_EQUIPMENT_TAGS.has(eq.tag));
            return (
              <>
                {realEq.length === 0 && sampleEq.length > 0 && !showSampleEq && (
                  <div style={{textAlign:"center",padding:"24px 20px",color:T.gray}}>
                    <div style={{fontSize:32,marginBottom:6}}>🔧</div>
                    <div style={{fontSize:12,color:T.sub}}>등록된 설비가 없습니다</div>
                  </div>
                )}
                {realEq.map(eq => (
                  <EquipmentCard key={eq.id} eq={eq} dischargeSystem={findDs(eq)}
                    onSelect={onSelectEquipment} onEdit={setEditingEq}
                    onViewHistory={(e)=>setViewingEqHistory(e.id)}/>
                ))}
                {sampleEq.length > 0 && (
                  <div style={{marginTop:realEq.length?4:0}}>
                    <button onClick={()=>setShowSampleEq(v=>!v)}
                      style={{width:"100%",padding:"9px",background:"transparent",
                        color:T.sub,border:`1px dashed ${T.border}`,borderRadius:10,
                        fontSize:11,fontWeight:700,fontFamily:font.sans,cursor:"pointer",
                        marginBottom:showSampleEq?8:0}}>
                      {showSampleEq ? "▲ 예시 데이터 접기" : `▼ 예시 데이터로 구조 참고하기 (${sampleEq.length}건)`}
                    </button>
                    {showSampleEq && sampleEq.map(eq => (
                      <EquipmentCard key={eq.id} eq={eq} dischargeSystem={findDs(eq)}
                        onSelect={onSelectEquipment} onEdit={setEditingEq}
                        onViewHistory={(e)=>setViewingEqHistory(e.id)}/>
                    ))}
                  </div>
                )}
              </>
            );
          })()}
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
              <DischargeSystemWizard
                equipments={equipments} dischargeSystems={dischargeSystems}
                onSave={ds=>onAddDischargeSystem(ds)}
                onDone={()=>setShowDsForm(false)}
                onCancel={()=>setShowDsForm(false)}/>
            </div>
          )}
          {editingDs && (
            <div style={{marginBottom:12}}>
              <DischargeSystemForm
                editing={editingDs}
                equipments={equipments} dischargeSystems={dischargeSystems}
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
                    {SAMPLE_DS_NAMES.has(ds.name) && (
                      <span style={{marginLeft:6,fontSize:8,padding:"1px 6px",borderRadius:8,
                        background:"#F3F0FF",color:"#7C5CFC",border:"1px solid #D9CFFF",
                        fontFamily:font.sans,fontWeight:700}}>예시</span>
                    )}
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
