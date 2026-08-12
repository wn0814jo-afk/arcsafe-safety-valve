//  CASE VIEW
// ════════════════════════════════════════════════════════════════
function CaseView({ caseData, dischargeSystems, onBack, onSnapshotCreate, onApprovalUpdate }) {
  const equipment = caseData.equipment || null;

  // 매칭 DischargeSystem — connectedTags 또는 명시적 지정
  const dischargeSystem = caseData.dischargeSystemId
    ? (dischargeSystems || []).find(ds => ds.id === caseData.dischargeSystemId) || null
    : equipment
    ? (dischargeSystems || []).find(ds => ds.connectedTags?.includes(equipment.tag)) || null
    : null;

  // Equipment 값으로 inputs 초기화
  const initialInputs = {
    ...R201_DEFAULTS,
    ...(equipment ? {
      P1:   equipment.setPressure,
      mawp: equipment.mawp,
      // PRESSURE-001: overpressure는 Case 입력값이 아니라 Asset(Equipment)
      // 데이터. Equipment에 없으면 계산을 막아야 하므로 여기서 임의
      // 기본값을 몰래 대입하지 않는다 (누락 시 validateInputs에서 거부).
      OP:   equipment.overpressure,
      P2:   dischargeSystem?.headerPressure ?? R201_DEFAULTS.P2,
    } : {}),
  };

  const startScreen = caseData.latestSnap ? "report" : "input";
  const [screen,     setScreen]     = useState(startScreen);
  const [inputs,     setInputs]     = useState(initialInputs);
  const [deviceType, setDeviceType] = useState(
    equipment?.deviceType ?? "safetyValve"
  );
  const [snapshot, setSnapshot] = useState(caseData.latestSnap || null);
  const [approvals, setApprovals] = useState(caseData.approvals || []);

  const handleInputChange = (key, val) => setInputs(p => ({ ...p, [key]: val }));

  const handleCalculate = () => {
    const engineResult = api520Engine(inputs, deviceType, equipment?.inletPiping || null);
    if (!engineResult.valid) {
      alert(`입력 오류: ${engineResult.error.field} — ${engineResult.error.reason}`);
      return;
    }
    // Engine이 workflow 결정 — timestamp는 UI에서 주입 (Engine 순수성 유지)
    const wfDec = computeWorkflowState(null, equipment, dischargeSystem);
    const snap = createSnapshot({
      caseId:           caseData.id,
      valveTag:         caseData.valveTag,
      deviceType,
      inputs,
      engineResult,
      equipment,
      dischargeSystem,
      workflowDecision: { ...wfDec, state: "INSPECTION" },
    });
    setSnapshot(snap);
    onSnapshotCreate(caseData.id, snap);
    setScreen("report");
  };

  // workflow 변경 = 새 Snapshot 생성 (patch 금지)
  // snapshotHash가 workflow를 포함해 계산되므로, workflow가 바뀌면
  // 반드시 새로운 identity(새 hash)를 가진 Snapshot이어야 한다.
  // inputs/engineResult는 재사용 — Engine을 다시 돌리는 게 아니라
  // "동일 계산 결과 + 새 workflow 결정"을 새 버전으로 기록하는 것.
  //
  // build/commit을 분리한 이유(중요): Approval은 "지금 보고 있는(REVIEW) 버전"이
  // 아니라 "승인 결과로 확정될 다음 버전(APPROVED/ACTION_REQUIRED)"의 hash에
  // 서명해야 한다. 순서를 반대로 하면(서명 먼저 → 전이 나중) 서명 직후
  // Snapshot이 교체되면서 approval.snapshotHash가 가리키는 버전이 case에서
  // 사라져 "승인은 됐는데 최종 상태에는 승인 기록이 없는" 상태가 된다.
  const _buildAdvancedSnapshot = (nextState, comment) => {
    const wfDec = computeWorkflowState(snapshot, equipment, dischargeSystem);
    const newSnap = createSnapshot({
      caseId:           caseData.id,
      valveTag:         caseData.valveTag,
      deviceType,
      inputs:           snapshot.inputs,
      engineResult:     snapshot.result,
      equipment,
      dischargeSystem,
      workflowDecision: { ...wfDec, state: nextState },
    });
    // lastComment는 hash 계산 대상 아님 (승인/반려 사유 메모, 결정 내용 아님)
    return comment ? Object.freeze({ ...newSnap, lastComment: comment }) : newSnap;
  };

  const _commitSnapshot = (snap) => {
    setSnapshot(snap);
    onSnapshotCreate(caseData.id, snap);
  };

  const handleWorkflowAdvance = (nextState, comment) => {
    _commitSnapshot(_buildAdvancedSnapshot(nextState, comment));
  };

  // ApprovalForm → 여기 하나만 거쳐서 처리한다.
  // 1) "승인 후 확정될 다음 버전(Snapshot)"을 먼저 만든다 (아직 커밋 안 함)
  // 2) 그 Snapshot의 hash에 서명한다 (submitApproval)
  // 3) 서명 성공한 경우에만 그 Snapshot을 실제로 커밋한다
  //    → case의 "현재/최종" Snapshot이 항상 서명 대상과 정확히 일치한다.
  const handleApprovalSubmit = async ({ decision, comment, signer, role }) => {
    if (!snapshot || snapshot.workflow !== "REVIEW") {
      alert("승인 대기(REVIEW) 상태에서만 서명할 수 있습니다.");
      return { ok: false, reason: "not in REVIEW state" };
    }
    const nextState = decision === "approve" ? "APPROVED" : "ACTION_REQUIRED";
    const nextSnap  = _buildAdvancedSnapshot(nextState, comment);

    const result = await submitApproval(
      { snapshot: nextSnap, decision, comment, signer, role },
      approvals
    );
    if (!result.ok) {
      alert(`승인 처리 실패 [${result.contract}]: ${result.reason}`);
      return result;
    }
    setApprovals(result.history);
    onApprovalUpdate(caseData.id, result.history);
    _commitSnapshot(nextSnap);
    return result;
  };

  const wfColor = WF_COLOR[snapshot?.workflow ?? caseData.workflow];
  const wfLabel = WF_LABEL[snapshot?.workflow ?? caseData.workflow];

  // Engine이 결정한 workflow 상태 — UI는 읽기만 함
  const wfDecision = computeWorkflowState(snapshot, equipment, dischargeSystem);

  // MOC 결과는 wfDecision.reasons에서 추출 (Engine 결과 projection)
  const mocResult = {
    changed: wfDecision.reasons.length > 0,
    diffs:   wfDecision.reasons,  // { field, from, to, unit, type }
  };

  // Snapshot workflow와 Engine 결정값이 다르면 Snapshot 갱신
  // (Engine이 상태를 결정하면 Snapshot이 그것을 반영 — UI는 트리거만)
  useEffect(() => {
    if (!snapshot) return;
    if (wfDecision.state === snapshot.workflow) return;
    const locked = ["APPROVED","CLOSED"];
    if (locked.includes(snapshot.workflow)) return;
    handleWorkflowAdvance(
      wfDecision.state,
      wfDecision.reasons.map(r=>`${r.type}: ${r.field} ${r.from}→${r.to}`).join(", ")
    );
  }, [wfDecision.state]);

  const tabs = [
    { id:"info",   label:"정보" },
    { id:"input",  label:"사양 결정" },
    ...(snapshot ? [{ id:"report", label:"검토 결과" }] : []),
  ];

  return (
    <div>
      {/* 헤더 */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
        <button onClick={onBack}
          style={{padding:"8px 12px",background:T.bg,border:`1px solid ${T.border}`,
            borderRadius:9,fontSize:13,fontWeight:700,color:T.sub,
            fontFamily:font.mono,cursor:"pointer",flexShrink:0}}>←</button>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:17,fontWeight:900,color:T.navy,
            fontFamily:font.mono,overflow:"hidden",
            textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
            {caseData.valveTag}
          </div>
          <div style={{fontSize:10,color:T.sub,fontFamily:font.mono}}>
            {equipment?.location || caseData.location || ""}
            {dischargeSystem ? ` → ${dischargeSystem.name}` : ""}
          </div>
        </div>
        <div style={{padding:"5px 11px",borderRadius:20,
          background:wfColor+"18",border:`1.5px solid ${wfColor}`,
          fontSize:10,fontWeight:700,color:wfColor,fontFamily:font.mono,flexShrink:0}}>
          {wfLabel}
        </div>
      </div>

      {/* 탭 */}
      <div style={{display:"flex",gap:6,marginBottom:14,
        borderBottom:`1px solid ${T.border}`,paddingBottom:10}}>
        {tabs.map(({id,label})=>(
          <button key={id} onClick={()=>setScreen(id)}
            style={{padding:"8px 16px",border:"none",borderRadius:9,cursor:"pointer",
              fontSize:12,fontWeight:700,fontFamily:font.mono,
              background:screen===id?T.navyLight:T.bg,
              color:screen===id?T.white:T.sub,
              boxShadow:screen===id?`0 3px 0 ${T.navy}`:"0 2px 0 #ccc"}}>
            {label}
            {id==="report" && snapshot && (
              <span style={{marginLeft:4,fontSize:9,
                color:screen===id?"#AED6F1":
                  Object.values(snapshot.result?.checklist||{}).every(Boolean)
                  ?T.green:T.red}}>●</span>
            )}
          </button>
        ))}
      </div>

      {/* MOC 감지 배너 */}
      {mocResult.changed && (
        <div style={{background:"#FFF8E1",border:`2px solid ${T.orange}`,
          borderRadius:12,padding:"12px 14px",marginBottom:12}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
            <span style={{fontSize:18}}>⚠</span>
            <div>
              <div style={{fontSize:12,fontWeight:900,color:"#7A4F00",fontFamily:font.sans}}>
                설비가 변경되었습니다 — 재검토 필요
              </div>
              <div style={{fontSize:10,color:"#7A4F00",fontFamily:font.sans,marginTop:1}}>
                이 검토는 아래 조건으로 수행됐습니다. 현재 설비 조건과 다릅니다.
              </div>
            </div>
          </div>

          {/* Revision 비교 */}
          <div style={{display:"flex",gap:8,marginBottom:8}}>
            {[
              ["Equipment",
               snapshot?.assetRefs?.equipmentRevision,
               equipment?.revision,
               equipment?.mocId],
              ["Discharge Sys.",
               snapshot?.assetRefs?.dischargeRevision,
               dischargeSystem?.revision,
               dischargeSystem?.mocId],
            ].filter(([,sv]) => sv != null).map(([label, snapRev, curRev, mocId]) => (
              <div key={label} style={{flex:1,background:"#FFFDE7",borderRadius:9,
                padding:"8px 10px",border:`1px solid #FFD54F`}}>
                <div style={{fontSize:9,color:T.sub,fontFamily:font.mono,marginBottom:3}}>{label}</div>
                <div style={{fontSize:12,fontFamily:font.mono,color:"#7A4F00"}}>
                  Rev.{snapRev}
                  {snapRev !== curRev && (
                    <span style={{color:T.green,fontWeight:700}}> → Rev.{curRev}</span>
                  )}
                </div>
                {mocId && (
                  <div style={{fontSize:9,color:T.blue,fontFamily:font.mono,marginTop:2}}>
                    {mocId}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* 변경 필드 목록 */}
          {mocResult.diffs.map((d,i) => (
            <div key={i} style={{display:"flex",alignItems:"center",gap:8,
              padding:"4px 0",borderTop:`1px solid #FFD54F`,
              fontSize:11,fontFamily:font.mono}}>
              <span style={{color:T.sub,minWidth:110}}>{d.field}</span>
              <span style={{color:T.red,textDecoration:"line-through"}}>
                {d.from}{d.unit}
              </span>
              <span style={{color:T.sub}}>→</span>
              <span style={{color:T.green,fontWeight:700}}>
                {d.to}{d.unit}
              </span>
            </div>
          ))}

          <button onClick={()=>setScreen("input")}
            style={{marginTop:10,width:"100%",padding:"10px",
              background:T.orange,color:T.white,border:"none",borderRadius:9,
              fontSize:12,fontWeight:700,fontFamily:font.sans,cursor:"pointer",
              boxShadow:`0 3px 0 #CC7000`}}>
            변경된 조건으로 재검토 →
          </button>
        </div>
      )}

      {/* 정보 탭 */}
      {screen === "info" && (
        <div>
          {/* Equipment */}
          {equipment && (
            <div style={{background:T.cardBg,borderRadius:14,padding:14,
              marginBottom:10,border:`1px solid ${T.border}`}}>
              <div style={{fontSize:10,fontWeight:700,color:T.sub,
                fontFamily:font.mono,marginBottom:8,letterSpacing:1}}>EQUIPMENT</div>
              {[
                ["Tag", equipment.tag],
                ["위치", equipment.location],
                ["제조사/모델", `${equipment.manufacturer} ${equipment.model}`.trim()||"-"],
                ["MAWP / SET", `${equipment.mawp} / ${equipment.setPressure} barg`],
                ["오리피스", equipment.orifice||"-"],
                ["IN / OUT", `${equipment.inletSize} / ${equipment.outletSize}`],
              ].map(([k,v])=>(
                <div key={k} style={{display:"flex",justifyContent:"space-between",
                  padding:"6px 0",borderBottom:`1px solid ${T.border}`,fontSize:12}}>
                  <span style={{color:T.sub,fontFamily:font.mono}}>{k}</span>
                  <span style={{color:T.text,fontWeight:700,fontFamily:font.mono}}>{v}</span>
                </div>
              ))}
            </div>
          )}
          {/* DischargeSystem */}
          {dischargeSystem && (
            <div style={{background:T.cardBg,borderRadius:14,padding:14,
              marginBottom:10,border:`1px solid ${T.border}`}}>
              <div style={{fontSize:10,fontWeight:700,color:T.sub,
                fontFamily:font.mono,marginBottom:8,letterSpacing:1}}>DISCHARGE SYSTEM</div>
              {[
                ["계통명", dischargeSystem.name],
                ["배출 목적지", DESTINATION_LABEL[dischargeSystem.destination]],
                ["L / D", `${dischargeSystem.L}m / Ø${Math.round(dischargeSystem.D*1000)}mm`],
                ["Fittings ΣK", dischargeSystem.fittingsK],
                ["Header 압력", `${dischargeSystem.headerPressure} barg`],
              ].map(([k,v])=>(
                <div key={k} style={{display:"flex",justifyContent:"space-between",
                  padding:"6px 0",borderBottom:`1px solid ${T.border}`,fontSize:12}}>
                  <span style={{color:T.sub,fontFamily:font.mono}}>{k}</span>
                  <span style={{color:T.text,fontWeight:700,fontFamily:font.mono}}>{v}</span>
                </div>
              ))}
            </div>
          )}
          <button onClick={()=>setScreen("input")}
            style={{width:"100%",padding:"14px",background:T.navyLight,color:T.white,
              border:"none",borderRadius:14,fontSize:14,fontWeight:900,
              fontFamily:font.sans,cursor:"pointer",boxShadow:`0 5px 0 ${T.navy}`}}>
            {snapshot?"사양 재결정 →":"사양 결정 시작 →"}
          </button>
        </div>
      )}

      {screen === "input" && (
        <InputView inputs={inputs} deviceType={deviceType}
          dischargeSystem={dischargeSystem} equipment={equipment}
          onChange={handleInputChange} onDeviceChange={setDeviceType}
          onSubmit={handleCalculate}/>
      )}

      {screen === "report" && snapshot && (
        <ReportView snap={snapshot} approvals={approvals}
                    caseSnapshotHistory={caseData.snapshotHistory}
                    onWorkflowAdvance={handleWorkflowAdvance}
                    onApprovalSubmit={handleApprovalSubmit}/>
      )}

      {screen === "report" && !snapshot && (
        <div style={{textAlign:"center",padding:"40px 20px",color:T.sub}}>
          <div style={{fontSize:32,marginBottom:12}}>📋</div>
          <div style={{fontSize:14,fontWeight:700,color:T.navy,marginBottom:8}}>
            아직 계산 결과가 없습니다
          </div>
          <button onClick={()=>setScreen("input")}
            style={{padding:"12px 24px",background:T.navyLight,color:T.white,
              border:"none",borderRadius:11,fontSize:13,fontWeight:700,
              fontFamily:font.sans,cursor:"pointer"}}>
            사양 결정 시작 →
          </button>
        </div>
      )}
    </div>
  );
}
