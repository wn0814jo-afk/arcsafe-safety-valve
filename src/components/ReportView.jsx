//  REPORT VIEW — Snapshot projection
// ════════════════════════════════════════════════════════════════
function ReportView({ snap, approvals, caseSnapshotHistory, onWorkflowAdvance, onApprovalSubmit }) {
  const [simMode, setSimMode] = useState("IDLE");
  const [sim, setSim] = useState({pressure:2.0,direction:1,valveOpen:false,ratio:0});
  const [hist, setHist] = useState([2.0]);
  const [reportTab, setReportTab] = useState("checklist");
  const simRef = useRef(null);

  // 서명 검증은 여기서 1회만 계산 — ApprovalHistory와 AuditEvidence가 결과 공유
  // (두 곳에서 각자 verifyApprovalRecord를 부르면 중복 호출)
  const [verifiedResults, setVerifiedResults] = useState({});
  useEffect(() => {
    let cancelled = false;
    const caseObj = { snapshotHistory: caseSnapshotHistory || [] };
    (async () => {
      const entries = {};
      for (const rec of (approvals || [])) {
        entries[rec.approvalId] = await verifyApprovalRecord(rec, caseObj, approvals);
      }
      if (!cancelled) setVerifiedResults(entries);
    })();
    return () => { cancelled = true; };
  }, [approvals, caseSnapshotHistory]);

  const setPoint = snap.inputs.P1;
  const mawp     = snap.inputs.mawp;

  useEffect(() => {
    if (simMode !== "RUNNING") { clearInterval(simRef.current); return; }
    simRef.current = setInterval(() => {
      setSim(prev => {
        const next = stepSim(prev, setPoint, mawp);
        setHist(h => [...h.slice(-API_CONST.HISTORY_SIZE), next.pressure]);
        return next;
      });
    }, 50);
    return () => clearInterval(simRef.current);
  }, [simMode, setPoint, mawp]);

  const resetSim = () => {
    setSimMode("IDLE");
    setSim({pressure:1.0,direction:1,valveOpen:false,ratio:0});
    setHist([1.0]);
  };

  const r = snap.result;
  const allOK = r.checklist && Object.values(r.checklist).every(Boolean);
  const failCount = r.checklist ? Object.values(r.checklist).filter(v=>!v).length : 0;
  const nextStates = WF_TRANSITIONS[snap.workflow] || [];

  // PDF 리포트 — AuditEvidence와 동일한 ReportPackage 사용 (계산 재실행 없음, 표시된 Snapshot과 동일 identity)
  const pkg = buildReportPackage(snap, {
    approvalRecords: approvals,
    approvalVerificationResults: verifiedResults,
  });
  const pkgValid = validateReportPackage(pkg);
  const pkgIdentityMatch = pkg.identity?.snapshotHash === snap.snapshotHash;
  const handleExportPDF = () => {
    const res = renderPDF(pkg);
    if (!res.ok) alert(`PDF 생성 실패: ${res.reason}`);
  };

  const TAB = (id, label) => (
    <button key={id} onClick={()=>setReportTab(id)} style={{padding:"9px 14px",border:"none",cursor:"pointer",borderRadius:9,fontWeight:700,fontSize:11,fontFamily:font.mono,
      background:reportTab===id?T.navyLight:T.bg,color:reportTab===id?T.white:T.sub,
      boxShadow:reportTab===id?`0 3px 0 ${T.navy}`:"0 2px 0 #ccc",transition:"all 0.15s"}}>
      {label}
    </button>
  );

  return (
    <div>
      {/* Snapshot 헤더 */}
      <div style={{background:T.cardBg,borderRadius:14,padding:"14px 16px",marginBottom:12,border:`1.5px solid ${T.border}`,boxShadow:"0 2px 8px #0001"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
          <div>
            <div style={{fontSize:17,fontWeight:900,color:T.navy,fontFamily:font.mono}}>{snap.valveTag}</div>
            <div style={{fontSize:11,color:T.sub,fontFamily:font.sans,marginTop:2}}>
              {snap.deviceType === "safetyValve" ? "안전밸브" : "럽처디스크"} · API 520/526 계산
            </div>
            <div style={{fontSize:10,color:T.gray,fontFamily:font.mono,marginTop:4}}>{snap.createdAt.slice(0,19).replace("T"," ")} · {snap.id}</div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{padding:"5px 12px",borderRadius:20,background:WF_COLOR[snap.workflow]+"22",border:`1.5px solid ${WF_COLOR[snap.workflow]}`,fontSize:11,fontWeight:700,color:WF_COLOR[snap.workflow],fontFamily:font.mono}}>
              {WF_LABEL[snap.workflow]}
            </div>
            <div style={{padding:"5px 12px",borderRadius:20,background:allOK?T.greenBg:T.redBg,border:`1.5px solid ${allOK?T.green:T.red}`,fontSize:11,fontWeight:700,color:allOK?T.green:T.red,fontFamily:font.mono}}>
              {allOK?"적정":"부적정"}
            </div>
          </div>
        </div>

        {/* 결과 요약 */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginTop:12}}>
          {[
            ["오리피스", r.selected?.letter ?? "-"],
            ["필요 면적", `${r.areaCm2?.toFixed(3)} cm²`],
            ["여유율", `${r.margin?.toFixed(3)}×`],
          ].map(([k,v])=>(
            <div key={k} style={{background:T.bg,borderRadius:9,padding:"8px 10px",textAlign:"center"}}>
              <div style={{fontSize:9,color:T.sub,fontFamily:font.mono}}>{k}</div>
              <div style={{fontSize:16,fontWeight:900,color:T.navyLight,fontFamily:font.mono,marginTop:2}}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 적정성 결론 — 화면 진입 즉시 보이는 최종 판정 */}
      <div style={{background:allOK?T.greenBg:T.redBg,border:`2px solid ${allOK?T.green:T.red}`,
        borderRadius:14,padding:"14px 16px",marginBottom:12,display:"flex",alignItems:"center",
        justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:34,height:34,borderRadius:"50%",background:allOK?T.green:T.red,
            color:T.white,display:"flex",alignItems:"center",justifyContent:"center",
            fontSize:17,fontWeight:900,flexShrink:0}}>{allOK?"✓":"✗"}</div>
          <div>
            <div style={{fontSize:14,fontWeight:900,color:allOK?T.greenDk:T.redDk,fontFamily:font.sans}}>
              {allOK
                ? "적정 — 이 사양은 API 520/521 기준을 모두 충족합니다"
                : `부적정 — 기준 미충족 항목이 있어 조치가 필요합니다 (${failCount}건)`}
            </div>
            <div style={{fontSize:10,color:T.sub,fontFamily:font.sans,marginTop:3}}>
              아래 "✅ PSM 체크" 탭에서 항목별 근거를 확인하세요
            </div>
          </div>
        </div>
        <button onClick={handleExportPDF}
          disabled={!pkgValid.ok || !pkgIdentityMatch}
          title={(!pkgValid.ok || !pkgIdentityMatch) ? "리포트 데이터 무결성 확인 중..." : "PDF 리포트 다운로드"}
          style={{padding:"10px 16px",background:(pkgValid.ok&&pkgIdentityMatch)?T.navy:T.gray,
            color:T.white,border:"none",borderRadius:10,fontSize:12,fontWeight:900,
            fontFamily:font.mono,cursor:(pkgValid.ok&&pkgIdentityMatch)?"pointer":"not-allowed",
            boxShadow:(pkgValid.ok&&pkgIdentityMatch)?`0 3px 0 ${T.navyMid}`:"none",
            whiteSpace:"nowrap"}}>
          📄 PDF 리포트 다운로드
        </button>
      </div>

      {/* 리포트 탭 */}
      <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}}>
        {TAB("sim","📊 시뮬레이션")}
        {TAB("evidence","🧮 계산 근거")}
        {TAB("checklist","✅ PSM 체크")}
        {TAB("audit", (snap.workflow === "APPROVED" || snap.workflow === "CLOSED")
          ? "✓ 승인 기록" : "🔍 검토 근거")}
      </div>

      {reportTab === "sim" && (
        <div>
          <div style={{background:T.cardBg,borderRadius:14,padding:12,marginBottom:10,border:`1px solid ${T.border}`}}>
            <PipeFlowRenderer snap={snap} sim={sim}/>
          </div>
          <div style={{background:T.cardBg,borderRadius:14,padding:12,marginBottom:10,border:`1px solid ${T.border}`}}>
            <PressChartRenderer hist={hist} snap={snap}/>
          </div>
          <div style={{display:"flex",gap:8}}>
            {simMode === "RUNNING"
              ? <button onClick={()=>setSimMode("IDLE")} style={{flex:1,padding:"11px",background:T.orange,color:T.white,border:"none",borderRadius:10,fontWeight:700,fontSize:12,fontFamily:font.mono,cursor:"pointer",boxShadow:`0 4px 0 #CC7000`}}>⏸ 정지</button>
              : <button onClick={()=>setSimMode("RUNNING")} style={{flex:1,padding:"11px",background:T.blue,color:T.white,border:"none",borderRadius:10,fontWeight:700,fontSize:12,fontFamily:font.mono,cursor:"pointer",boxShadow:`0 4px 0 ${T.blueDk}`}}>▶ 시뮬 시작</button>
            }
            <button onClick={resetSim} style={{padding:"11px 16px",background:T.bg,color:T.sub,border:`1px solid ${T.border}`,borderRadius:10,fontWeight:700,fontSize:12,fontFamily:font.mono,cursor:"pointer"}}>↺ 초기화</button>
          </div>
        </div>
      )}

      {reportTab === "evidence" && (
        <div>
          {snap.evidence.map(step => <EvidenceCard key={step.id} step={step}/>)}
        </div>
      )}

      {reportTab === "checklist" && (
        <div style={{background:T.cardBg,borderRadius:14,padding:14,border:`1px solid ${T.border}`}}>
          <ChecklistRenderer checklist={snap.result.checklist}/>
        </div>
      )}

      {reportTab === "audit" && (
        <AuditEvidence snapshot={snap} approvals={approvals} verifiedResults={verifiedResults} />
      )}

      {/* Workflow 전환 — REVIEW는 전자서명(ApprovalForm)을 거쳐야 함 */}
      {snap.workflow === "REVIEW" ? (
        <ApprovalForm snap={snap} onSubmit={onApprovalSubmit} />
      ) : (
        nextStates.length > 0 && (
          <WorkflowTransition
            currentState={snap.workflow}
            nextStates={nextStates}
            onAdvance={onWorkflowAdvance}
          />
        )
      )}

      <ApprovalHistory approvals={approvals} verifiedResults={verifiedResults} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
