//  AUDIT EVIDENCE
//  "왜 이 결과가 나왔는가"를 감사자가 한 화면에서 볼 수 있게 조립.
//  AUDIT-001: 여기서도 하위 컴포넌트에서도 Snapshot 외부 Asset을 조회하지 않는다.
//  AUDIT-004: snapshot/approvals 어떤 필드도 여기서 쓰거나(assign) 지우지 않는다 — 표시만.
//  AUDIT-005: Evidence는 workflow 단계와 무관하게 항상 렌더링된다(DRAFT부터).
//             Approval 파트만 승인 전엔 빈 상태로 보여준다 — "Evidence는 항상 존재,
//             Approval은 조건부 존재"를 분리. 헤더 라벨만 단계에 따라 다르게 표시
//             (승인 전: 검토 근거 / 승인 후: 승인 기록) — 승인자가 "무엇을 승인했는지"를
//             검토 시작 시점부터 추적 가능해야 하므로 숨기지 않는다.
// ════════════════════════════════════════════════════════════════
function AuditEvidence({ snapshot, approvals, verifiedResults }) {
  const [showPkg, setShowPkg] = useState(false);
  const approved = snapshot.workflow === "APPROVED" || snapshot.workflow === "CLOSED";
  const headerLabel = approved ? "✓ 승인 기록 · AUDIT EVIDENCE" : "검토 근거 · EVIDENCE CHAIN";

  // ReportView 화면에 보이는 것과 실제 export 대상(ReportPackage)이 같은 Snapshot에서
  // 파생됐는지 확인 — Package는 여기서 "만들기만" 하고 계산/재검증은 절대 안 함.
  const pkg = buildReportPackage(snapshot, {
    approvalRecords: approvals,
    approvalVerificationResults: verifiedResults,
  });
  const pkgValid = validateReportPackage(pkg);
  const identityMatch = pkg.identity?.snapshotHash === snapshot.snapshotHash;

  return (
    <div style={{background:T.cardBg,borderRadius:14,border:`1px solid ${T.border}`,
      overflow:"hidden",marginBottom:12}}>
      <div style={{padding:"10px 14px",background:T.navy,color:T.white,
        fontSize:11,fontWeight:900,fontFamily:font.mono,letterSpacing:1}}>
        {headerLabel}
      </div>
      <div style={{padding:"12px 14px",borderBottom:`1px solid ${T.border}`}}>
        <AssetEvidence snapshot={snapshot} />
      </div>
      <div style={{padding:"12px 14px",borderBottom:`1px solid ${T.border}`}}>
        <WorkflowEvidence snapshot={snapshot} />
      </div>
      <div style={{padding:"12px 14px",borderBottom:`1px solid ${T.border}`}}>
        <ApprovalEvidence snapshot={snapshot} approvals={approvals} verifiedResults={verifiedResults} />
      </div>
      <div style={{padding:"10px 14px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontSize:10,fontFamily:font.mono,
            color:(pkgValid.ok && identityMatch)?T.green:T.red}}>
            {(pkgValid.ok && identityMatch) ? "✓ ReportPackage 무결성 확인됨" : `✗ ${pkgValid.reason || "identity mismatch"}`}
          </span>
          <div style={{display:"flex",gap:6}}>
            <button onClick={()=>setShowPkg(s=>!s)}
              style={{fontSize:10,padding:"3px 8px",background:T.bg,color:T.navyLight,
                border:`1px solid ${T.navyLight}`,borderRadius:6,cursor:"pointer",fontFamily:font.mono}}>
              {showPkg?"JSON 닫기":"패키지 JSON 보기"}
            </button>
            <button onClick={()=>{
                const r = renderPDF(pkg);
                if (!r.ok) alert(`PDF 생성 실패: ${r.reason}`);
              }}
              disabled={!pkgValid.ok || !identityMatch}
              style={{fontSize:10,padding:"3px 8px",
                background:(pkgValid.ok&&identityMatch)?T.navyLight:T.gray,color:T.white,
                border:"none",borderRadius:6,
                cursor:(pkgValid.ok&&identityMatch)?"pointer":"not-allowed",fontFamily:font.mono}}>
              PDF 내보내기
            </button>
          </div>
        </div>
        {showPkg && (
          <pre style={{marginTop:8,padding:10,background:T.bg,borderRadius:8,
            fontSize:9,color:T.sub,fontFamily:font.mono,overflowX:"auto",maxHeight:240}}>
            {JSON.stringify(pkg, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
