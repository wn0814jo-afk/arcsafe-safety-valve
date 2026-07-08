//  WORKFLOW TRANSITION — 코멘트 포함 전환 UI
// ════════════════════════════════════════════════════════════════
function WorkflowTransition({ currentState, nextStates, onAdvance }) {
  const [comment, setComment] = useState("");
  const [selected, setSelected] = useState(nextStates[0]);

  return (
    <div style={{marginTop:14,background:T.cardBg,borderRadius:14,padding:14,border:`1px solid ${T.border}`}}>
      <div style={{fontSize:10,fontWeight:700,color:T.sub,fontFamily:font.mono,marginBottom:10,letterSpacing:1}}>WORKFLOW 전환</div>
      <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
        {nextStates.map(ns => (
          <button key={ns} onClick={()=>setSelected(ns)} style={{padding:"8px 14px",background:selected===ns?WF_COLOR[ns]+"22":T.bg,border:`1.5px solid ${selected===ns?WF_COLOR[ns]:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,color:selected===ns?WF_COLOR[ns]:T.sub,fontFamily:font.mono,cursor:"pointer",transition:"all 0.12s"}}>
            {WF_LABEL[ns]}
          </button>
        ))}
      </div>
      <textarea
        value={comment}
        onChange={e=>setComment(e.target.value)}
        placeholder="전환 사유 또는 검토 의견 (선택)"
        rows={2}
        style={{width:"100%",borderRadius:9,border:`1px solid ${T.border}`,padding:"8px 10px",fontSize:11,fontFamily:font.sans,color:T.text,resize:"none",boxSizing:"border-box",background:T.bg,marginBottom:10,outline:"none"}}
      />
      <button onClick={()=>{ onAdvance(selected, comment); setComment(""); }} style={{width:"100%",padding:"11px",background:WF_COLOR[selected],color:T.white,border:"none",borderRadius:10,fontSize:12,fontWeight:700,fontFamily:font.mono,cursor:"pointer",boxShadow:`0 3px 0 ${WF_COLOR[selected]}88`}}>
        → {WF_LABEL[selected]}(으)로 전환
      </button>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
