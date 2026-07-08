//  APPROVAL FORM — 전자서명 UI
//  hash 계산, 서명 검증, workflow 판단 전부 금지 — submitApproval()만 호출한다.
//  REVIEW 상태에서만 노출 (ReportView가 조건부 렌더링으로 보장).
// ════════════════════════════════════════════════════════════════
function ApprovalForm({ snap, onSubmit }) {
  const [signer,     setSigner]     = useState("");
  const [role,       setRole]       = useState(APPROVAL_ROLES[0]);
  const [decision,   setDecision]   = useState("approve");
  const [comment,    setComment]    = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState(null);

  const canSubmit = signer.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    const result = await onSubmit({ decision, comment, signer: signer.trim(), role });
    setSubmitting(false);
    if (!result || !result.ok) {
      setError(result?.reason || "승인 처리에 실패했습니다.");
      return;
    }
    setComment("");
  };

  const accent = decision === "approve" ? T.green : T.red;

  return (
    <div style={{marginTop:14,background:T.cardBg,borderRadius:14,padding:14,border:`2px solid ${T.navyLight}`}}>
      <div style={{fontSize:10,fontWeight:700,color:T.navyLight,fontFamily:font.mono,marginBottom:2,letterSpacing:1}}>
        전자서명 · APPROVAL
      </div>
      <div style={{fontSize:10,color:T.gray,fontFamily:font.mono,marginBottom:10}}>
        서명 대상: {snap.id} · hash {(snap.snapshotHash || "").slice(0,12)}…
      </div>

      <div style={{display:"flex",gap:8,marginBottom:8}}>
        <input
          value={signer}
          onChange={e=>setSigner(e.target.value)}
          placeholder="서명자 이름"
          style={{flex:1,padding:"8px 10px",borderRadius:9,border:`1px solid ${T.border}`,fontSize:12,fontFamily:font.sans,outline:"none",boxSizing:"border-box"}}
        />
        <select
          value={role}
          onChange={e=>setRole(e.target.value)}
          style={{padding:"8px 10px",borderRadius:9,border:`1px solid ${T.border}`,fontSize:11,fontFamily:font.mono,background:T.bg}}
        >
          {APPROVAL_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>

      <div style={{display:"flex",gap:8,marginBottom:10}}>
        <button onClick={()=>setDecision("approve")} style={{flex:1,padding:"9px",borderRadius:9,
          border:`1.5px solid ${decision==="approve"?T.green:T.border}`,
          background:decision==="approve"?T.greenBg:T.bg,
          color:decision==="approve"?T.green:T.sub,
          fontWeight:700,fontSize:12,fontFamily:font.mono,cursor:"pointer"}}>
          ✓ 승인
        </button>
        <button onClick={()=>setDecision("request_change")} style={{flex:1,padding:"9px",borderRadius:9,
          border:`1.5px solid ${decision==="request_change"?T.red:T.border}`,
          background:decision==="request_change"?T.redBg:T.bg,
          color:decision==="request_change"?T.red:T.sub,
          fontWeight:700,fontSize:12,fontFamily:font.mono,cursor:"pointer"}}>
          ↺ 조치 요청
        </button>
      </div>

      <textarea
        value={comment}
        onChange={e=>setComment(e.target.value)}
        placeholder="승인/반려 사유 — 서명 대상에 포함되어 위변조 시 감지됩니다"
        rows={3}
        style={{width:"100%",borderRadius:9,border:`1px solid ${T.border}`,padding:"8px 10px",fontSize:11,fontFamily:font.sans,color:T.text,resize:"none",boxSizing:"border-box",background:T.bg,marginBottom:10,outline:"none"}}
      />

      {error && (
        <div style={{fontSize:11,color:T.red,fontFamily:font.mono,marginBottom:8}}>⚠ {error}</div>
      )}

      <button
        onClick={handleSubmit}
        disabled={!canSubmit}
        style={{width:"100%",padding:"11px",
          background: canSubmit ? accent : T.gray,
          color:T.white,border:"none",borderRadius:10,fontSize:12,fontWeight:700,fontFamily:font.mono,
          cursor:canSubmit?"pointer":"not-allowed",
          boxShadow:canSubmit?`0 3px 0 ${accent}88`:"none"}}
      >
        {submitting ? "서명 처리 중…" : `전자서명 후 ${decision==="approve"?"승인":"조치 요청"}`}
      </button>
    </div>
  );
}

//  APPROVAL HISTORY — 서명 검증 배지 타임라인
//  검증(verifyApprovalRecord)은 이 컴포넌트가 직접 하지 않는다.
//  ReportView가 1회 계산한 verifiedResults를 그대로 표시만 한다.
//  (AuditEvidence의 ApprovalEvidence와 동일한 결과를 공유 — 중복 검증 호출 방지)
// ════════════════════════════════════════════════════════════════
function ApprovalHistory({ approvals, verifiedResults }) {
  if (!approvals || approvals.length === 0) return null;

  return (
    <div style={{marginTop:14}}>
      <div style={{fontSize:10,fontWeight:700,color:T.sub,fontFamily:font.mono,marginBottom:8,letterSpacing:1}}>
        승인 이력 · APPROVAL TIMELINE
      </div>
      {approvals.slice().reverse().map(rec => {
        const v  = (verifiedResults || {})[rec.approvalId];
        const ok = v?.valid;
        const badgeColor = v === undefined ? T.gray : ok ? T.green : T.red;
        return (
          <div key={rec.approvalId} style={{background:T.cardBg,borderRadius:12,padding:"10px 12px",marginBottom:8,border:`1px solid ${T.border}`}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:6}}>
              <div style={{fontSize:12,fontWeight:700,color:T.navy,fontFamily:font.mono}}>
                {rec.approver} <span style={{color:T.sub,fontWeight:400}}>({rec.role})</span>
              </div>
              <div style={{fontSize:10,fontWeight:700,fontFamily:font.mono,color:badgeColor}}>
                {v === undefined ? "검증 중…" : ok ? "✓ 서명 유효" : "✗ 위변조 의심"}
              </div>
            </div>
            <div style={{fontSize:11,color:T.sub,fontFamily:font.sans,marginTop:4}}>
              {rec.decision === "approve" ? "승인" : "조치 요청"} · {(rec.approvedAt || "").slice(0,19).replace("T"," ")}
            </div>
            {rec.comment && (
              <div style={{fontSize:11,color:T.text,fontFamily:font.sans,marginTop:6,background:T.bg,borderRadius:8,padding:"6px 8px"}}>
                “{rec.comment}”
              </div>
            )}
            {v && !ok && (
              <div style={{fontSize:10,color:T.red,fontFamily:font.mono,marginTop:6}}>
                [{v.contract}] {v.reason}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
