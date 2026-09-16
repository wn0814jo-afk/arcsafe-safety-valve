//  DASHBOARD
// ════════════════════════════════════════════════════════════════
const INITIAL_CASES = [];  // 설비대장에서 선택 후 생성

function CaseCard({ c, onOpen }) {
  const hasSnap = !!c.latestSnap;
  // INLET-LOSS-001: verdict가 단일 출처 — checklist.every(Boolean)를
  // 여기서 다시 계산하지 않는다(dataGaps가 있으면 GO가 아니어야 함).
  // 구버전 Snapshot(verdict 필드 없음) 호환 폴백만 유지.
  // C-4.25 VERDICT-FALLBACK-001: 이 폴백도 dataGaps를 반드시 먼저 본다 —
  // "verdict 없음 + dataGaps 있음 + checklist.every(Boolean)이 우연히
  // true"인 구버전 Snapshot을 GO로 오판하지 않기 위함(inletLossOK처럼
  // 데이터 부족 시 checklist에서 키 자체가 생략되는 필드가 있어 every()가
  // 이를 놓칠 수 있다 — computeAdequacyVerdict()와 동일한 우선순위를
  // 여기서도 재현한다). dataGaps가 없을 때의 기존 checklist 폴백 동작은
  // 그대로 유지(VERDICT-FALLBACK-002).
  const hasDataGaps = (c.latestSnap?.result?.dataGaps?.length ?? 0) > 0;
  const verdict = hasSnap
    ? (c.latestSnap.result?.verdict
        || (hasDataGaps
             ? "INSUFFICIENT_INPUT"
             : (c.latestSnap.result?.checklist && Object.values(c.latestSnap.result.checklist).every(Boolean) ? "GO" : "NO_GO")))
    : null;
  const allOK = verdict === "GO";
  const insufficientInput = verdict === "INSUFFICIENT_INPUT";
  // C-4.25 FLUID-001~003: 유체 표시의 authoritative source는 Snapshot뿐이다
  // (Case.fluid 같은 복제 상태를 두지 않는다). WorkflowEvidence.jsx의
  // _findFluidLabel()을 그대로 재사용 — 신규 매핑 테이블을 만들지 않는다.
  // FLUID-004: 구버전 persisted Case 객체의 fluid 필드는 여기서 절대
  // 읽지 않는다 — Snapshot이 있으면 Snapshot이, 없으면 "미정"이 항상 이긴다.
  const fluidLabel = hasSnap ? _findFluidLabel(c.latestSnap.inputs) : "미정";
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
              background:insufficientInput?(T.amberBg||"#fff7e6"):(allOK?T.greenBg:T.redBg),
              border:`1px solid ${insufficientInput?(T.amber||"#d97706"):(allOK?T.green:T.red)}`,
              fontSize:10,fontWeight:700,
              color:insufficientInput?(T.amber||"#d97706"):(allOK?T.green:T.red),fontFamily:font.mono}}>
              {insufficientInput ? "판정 보류" : (allOK?"적정":"부적정")}
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
        <span>{fluidLabel}</span><span>·</span><span>{c.reviewType}</span>
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

function Dashboard({ cases, onOpenCase, onNewCase, onOpenAssetMaster, onWipeAllData }) {
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

      {/* C-4.22-B PERSISTENCE-005: 과도한 경고 UI 없이 짧은 고지 한 줄 +
          접근하기 어려운 위치에 최소한의 초기화 링크만 둔다. */}
      <div style={{marginTop:28,paddingTop:14,borderTop:`1px solid ${T.border}`,textAlign:"center"}}>
        <div style={{fontSize:9,color:T.gray,fontFamily:font.sans,marginBottom:6}}>
          이 자료는 현재 기기·브라우저에만 저장됩니다. 다른 기기에서는 확인할 수 없습니다.
        </div>
        {onWipeAllData && (
          <button onClick={onWipeAllData}
            style={{background:"none",border:"none",color:T.gray,fontSize:9,
              fontFamily:font.sans,textDecoration:"underline",cursor:"pointer",padding:4}}>
            이 기기의 저장 데이터 초기화
          </button>
        )}
      </div>
    </div>
  );
}
