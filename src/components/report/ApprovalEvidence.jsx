//  APPROVAL EVIDENCE
//  현재 보고 있는 snapshot(snapshotHash)에 실제로 서명된 Approval만 필터링해 보여준다.
//  검증(verifyApprovalRecord)은 여기서 호출하지 않는다 — ReportView가 1회 계산해
//  넘겨주는 verifiedResults를 그대로 표시만 (ApprovalHistory와 동일 결과 공유).
//  AUDIT-005: Evidence(Asset/Workflow)는 항상 존재하지만 Approval은 조건부 —
//  승인 전에는 빈 상태를 명확히 보여준다(감춤 없이).
// ════════════════════════════════════════════════════════════════
function ApprovalEvidence({ snapshot, approvals, verifiedResults }) {
  const matched = (approvals || []).filter(a => a.snapshotHash === snapshot.snapshotHash);
  const emptyMsg = snapshot.workflow === "REVIEW"
    ? "승인 대기 중 — 아래 전자서명 양식에서 진행하세요"
    : "이 버전에 대한 승인 없음";

  return (
    <div>
      <div style={{fontSize:9,fontWeight:700,color:T.sub,fontFamily:font.mono,
        letterSpacing:1,marginBottom:6}}>APPROVAL</div>
      {matched.length === 0 ? (
        <div style={{fontSize:12,color:T.gray,fontFamily:font.mono}}>{emptyMsg}</div>
      ) : (
        matched.map(rec => {
          const v  = (verifiedResults || {})[rec.approvalId];
          const ok = v?.valid;
          return (
            <div key={rec.approvalId} style={{display:"flex",justifyContent:"space-between",
              alignItems:"center",padding:"4px 0",fontSize:12}}>
              <span style={{color:T.text,fontWeight:700,fontFamily:font.mono}}>
                {v === undefined ? "· " : ok ? "✓ " : "✗ "}{rec.approver}
              </span>
              <span style={{color:T.sub,fontFamily:font.mono,fontSize:11}}>
                {(rec.approvedAt||"").slice(0,10)}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}
