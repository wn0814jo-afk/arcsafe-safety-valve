//  WORKFLOW EVIDENCE
//  Calculation Basis + Workflow Decision — snapshot 필드만 읽는 projection.
//  fluid 라벨은 FLUID_CHOICES 테이블 조회일 뿐 계산이 아님 (WF_LABEL과 동일한 성격).
// ════════════════════════════════════════════════════════════════
function _findFluidLabel(inputs) {
  if (!inputs) return "커스텀";
  const match = FLUID_CHOICES.find(f => f.M === inputs.M && f.k === inputs.k);
  return match ? match.label : "커스텀 유체 (직접 입력값)";
}

function WorkflowEvidence({ snapshot }) {
  const wd = snapshot.workflowDecision;
  return (
    <div>
      <div style={{fontSize:9,fontWeight:700,color:T.sub,fontFamily:font.mono,
        letterSpacing:1,marginBottom:6}}>CALCULATION BASIS</div>
      <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12}}>
        <span style={{color:T.sub,fontFamily:font.mono}}>Fluid</span>
        <span style={{color:T.text,fontWeight:700,fontFamily:font.mono}}>{_findFluidLabel(snapshot.inputs)}</span>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12}}>
        <span style={{color:T.sub,fontFamily:font.mono}}>Engine</span>
        <span style={{color:T.text,fontWeight:700,fontFamily:font.mono}}>API520 v{snapshot.engine_version}</span>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:11}}>
        <span style={{color:T.gray,fontFamily:font.mono}}>Snapshot</span>
        <span style={{color:T.gray,fontFamily:font.mono}}>{(snapshot.snapshotHash||"").slice(0,16)}</span>
      </div>

      <div style={{fontSize:9,fontWeight:700,color:T.sub,fontFamily:font.mono,
        letterSpacing:1,margin:"12px 0 6px"}}>WORKFLOW DECISION</div>
      <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12}}>
        <span style={{color:T.sub,fontFamily:font.mono}}>State</span>
        <span style={{color:WF_COLOR[snapshot.workflow]||T.text,fontWeight:700,fontFamily:font.mono}}>
          {WF_LABEL[snapshot.workflow] || snapshot.workflow}
        </span>
      </div>
      {wd && wd.reasons && wd.reasons.length > 0 && (
        <div style={{marginTop:4}}>
          {wd.reasons.map((r,i) => (
            <div key={i} style={{fontSize:11,color:T.sub,fontFamily:font.mono,padding:"2px 0"}}>
              · {r.field} {r.from}{r.unit} → {r.to}{r.unit}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
