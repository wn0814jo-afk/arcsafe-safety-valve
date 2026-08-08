//  DASHBOARD
// ════════════════════════════════════════════════════════════════
const INITIAL_CASES = [];  // 설비대장에서 선택 후 생성

function CaseCard({ c, onOpen }) {
  const hasSnap = !!c.latestSnap;
  const allOK   = hasSnap && c.latestSnap.result?.checklist &&
                  Object.values(c.latestSnap.result.checklist).every(Boolean);
  return (
    <button onClick={()=>onOpen(c)}
      style={{display:"block",width:"100%",textAlign:"left",background:T.cardBg,
        borderRadius:14,padding:"14px 16px",marginBottom:10,
        border:`1.5px solid ${T.border}`,cursor:"pointer",
        boxShadow:"0 2px 8px #0001",
        WebkitTapHighlightColor:"rgba(26,63,111,0.15)",
        fontFamily:font.sans,appearance:"none",WebkitAppearance:"none"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
        <div>
          <div style={{fontSize:15,fontWeight:900,color:T.navy,fontFamily:font.mono}}>{c.valveTag}</div>
          {c.asset && (
            <div style={{fontSize:10,color:T.sub,fontFamily:font.mono,marginTop:1}}>
              {c.asset.location} · SET {c.asset.setPressure}b
            </div>
          )}
        </div>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          {hasSnap && (
            <span style={{padding:"3px 9px",borderRadius:12,
              background:allOK?T.greenBg:T.redBg,
              border:`1px solid ${allOK?T.green:T.red}`,
              fontSize:10,fontWeight:700,color:allOK?T.green:T.red,fontFamily:font.mono}}>
              {allOK?"PASS":"FAIL"}
            </span>
          )}
          <span style={{padding:"3px 9px",borderRadius:12,
            background:WF_COLOR[c.workflow]+"18",
            border:`1px solid ${WF_COLOR[c.workflow]}`,
            fontSize:10,fontWeight:700,color:WF_COLOR[c.workflow],fontFamily:font.mono}}>
            {WF_LABEL[c.workflow]}
          </span>
        </div>
      </div>
      <div style={{display:"flex",gap:12,fontSize:11,color:T.sub,fontFamily:font.mono}}>
        <span>{c.fluid}</span><span>·</span><span>{c.reviewType}</span>
      </div>
      {hasSnap && (
        <div style={{marginTop:8,display:"flex",gap:8}}>
          {[
            ["오리피스", c.latestSnap.result.selected?.letter],
            ["여유율",   `${c.latestSnap.result.margin?.toFixed(2)}×`],
            ["면적",     `${c.latestSnap.result.areaCm2?.toFixed(1)} cm²`],
          ].map(([k,v])=>(
            <div key={k} style={{background:T.bg,borderRadius:7,padding:"4px 8px",flex:1,textAlign:"center"}}>
              <div style={{fontSize:8,color:T.gray,fontFamily:font.mono}}>{k}</div>
              <div style={{fontSize:12,fontWeight:900,color:T.navyLight,fontFamily:font.mono}}>{v}</div>
            </div>
          ))}
        </div>
      )}
      <div style={{marginTop:8,textAlign:"right",fontSize:10,color:T.blue,fontFamily:font.mono,fontWeight:700}}>
        {hasSnap ? "결과 보기 →" : "검토 시작 →"}
      </div>
    </button>
  );
}

function AboutBanner() {
  const [open, setOpen] = useState(true);
  if (!open) {
    return (
      <button onClick={()=>setOpen(true)}
        style={{display:"block",width:"100%",textAlign:"left",background:"transparent",
          border:`1px dashed ${T.border}`,borderRadius:10,padding:"6px 10px",
          marginBottom:12,fontSize:10,color:T.sub,fontFamily:font.sans,cursor:"pointer"}}>
        ⓘ 이 앱은 무엇을 위한 도구인가요?
      </button>
    );
  }
  return (
    <div style={{background:T.navy,borderRadius:14,padding:"14px 16px",marginBottom:14,
      boxShadow:"0 2px 8px #0002"}}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between"}}>
        <div style={{fontSize:12,fontWeight:900,color:T.white,fontFamily:font.sans,lineHeight:1.5}}>
          PSV(안전밸브) 사양이 API 520/521 기준에 맞는지 검토하고, 그 근거를 기록으로 남기는 도구입니다.
        </div>
        <button onClick={()=>setOpen(false)}
          style={{background:"transparent",border:"none",color:T.blueBg,fontSize:14,
            cursor:"pointer",padding:0,marginLeft:10,lineHeight:1}}>×</button>
      </div>
      <div style={{marginTop:10,display:"flex",flexDirection:"column",gap:6}}>
        {[
          ["🧮","설비를 고르면 사양이 자동으로 채워지고, 오리피스·여유율·면적이 계산됩니다"],
          ["📄","검토가 끝나면 결과 리포트와 검토 이력(Snapshot)이 남습니다"],
          ["🔁","사양이 바뀌면 MOC 번호로 근거를 남기고 개정 이력을 추적합니다"],
        ].map(([icon,txt])=>(
          <div key={txt} style={{display:"flex",gap:8,alignItems:"flex-start"}}>
            <span style={{fontSize:13}}>{icon}</span>
            <span style={{fontSize:11,color:T.blueBg,fontFamily:font.sans,lineHeight:1.5}}>{txt}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Dashboard({ cases, onOpenCase, onNewCase, onOpenAssetMaster }) {
  const [reviewType, setReviewType] = useState("정기 PSM 검토");
  const REVIEW_OPTIONS = ["정기 PSM 검토","최초 설치 검토","변경 검토 (MOC)","사고 후 검토"];

  return (
    <div>
      <AboutBanner/>

      {/* 메인 CTA — 설비대장에서 선택 */}
      <button onClick={onOpenAssetMaster}
        style={{width:"100%",padding:"16px",background:T.navyLight,color:T.white,
          border:"none",borderRadius:14,fontSize:15,fontWeight:900,
          fontFamily:font.sans,cursor:"pointer",
          boxShadow:`0 5px 0 ${T.navy}`,marginBottom:8,
          WebkitTapHighlightColor:"rgba(255,255,255,0.2)"}}>
        + 설비 선택 → 새 검토 시작
      </button>
      <div style={{fontSize:10,color:T.sub,fontFamily:font.sans,textAlign:"center",marginBottom:16}}>
        설비대장에서 PSV를 선택하면 사양이 자동으로 채워집니다
      </div>

      {/* 진행 중인 검토 */}
      {cases.length > 0 && (
        <>
          <div style={{fontSize:10,fontWeight:700,color:T.sub,fontFamily:font.mono,marginBottom:10,letterSpacing:1}}>
            진행 중인 검토 ({cases.length})
          </div>
          {cases.map(c => <CaseCard key={c.id} c={c} onOpen={onOpenCase}/>)}
        </>
      )}

      {cases.length === 0 && (
        <div style={{textAlign:"center",padding:"40px 20px",color:T.gray,fontFamily:font.sans}}>
          <div style={{fontSize:40,marginBottom:10}}>📋</div>
          <div style={{fontSize:13,color:T.sub,fontWeight:700}}>진행 중인 검토가 없습니다</div>
          <div style={{fontSize:11,color:T.gray,marginTop:4}}>위 버튼으로 설비를 선택해 검토를 시작하세요</div>
        </div>
      )}
    </div>
  );
}
