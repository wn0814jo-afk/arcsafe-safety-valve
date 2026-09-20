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

// C-4.30: 첫 화면에서는 기본적으로 접혀있다("정보를 삭제하지 않되, 아무
// 행동도 하기 전에 학습을 강요하지 않는다" 원칙). 필요하면 사용자가 직접
// 펼쳐서 API 520/521·Snapshot·MOC 같은 상세 설명을 볼 수 있다 — 내용 자체는
// 그대로 유지, 노출 시점만 지연.
function AboutBanner({ defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen);
  if (!open) {
    return (
      <button onClick={()=>setOpen(true)}
        style={{display:"block",width:"100%",textAlign:"left",background:"transparent",
          border:`1px dashed ${T.border}`,borderRadius:10,padding:"6px 10px",
          marginBottom:14,fontSize:10,color:T.sub,fontFamily:font.sans,cursor:"pointer"}}>
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

// ── EntryCard — First-Run 메뉴의 Primary/Secondary 카드 공용 컴포넌트 ──
function EntryCard({ emphasis, title, desc, onClick }) {
  const isPrimary = emphasis === "primary";
  return (
    <button onClick={onClick}
      style={{display:"block",width:"100%",textAlign:"left",
        background:isPrimary?T.navyLight:T.white,
        color:isPrimary?T.white:T.navy,
        border:isPrimary?"none":`1.5px solid ${T.border}`,
        borderRadius:14,padding:"16px 18px",marginBottom:10,cursor:"pointer",
        boxShadow:isPrimary?`0 5px 0 ${T.navy}`:"0 2px 8px #0001",
        fontFamily:font.sans,appearance:"none",WebkitAppearance:"none",
        WebkitTapHighlightColor:"rgba(0,0,0,0.1)"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <span style={{fontSize:15,fontWeight:900}}>{title}</span>
        <span style={{fontSize:15,fontWeight:900}}>→</span>
      </div>
      <div style={{fontSize:11,marginTop:4,
        color:isPrimary?T.blueBg:T.sub,fontWeight:isPrimary?600:400}}>
        {desc}
      </div>
    </button>
  );
}

// C-4.30: 첫 화면 — "무엇을 하시겠어요?"를 사용자 목적 중심으로 먼저
// 받는다. 데이터 모델(설비/배출계통/Case/Snapshot/MOC)은 여기서 설명하지
// 않고, 실제로 필요한 다음 화면(ReviewEntryScreen)에서 그때그때만 노출.
function FirstRunMenu({ hasCases, onStartReview, onShowExisting, onStartExample }) {
  return (
    <div>
      <AboutBanner defaultOpen={false}/>

      <div style={{fontSize:14,fontWeight:900,color:T.navy,fontFamily:font.sans,
        marginBottom:12,textAlign:"center"}}>
        무엇을 하시겠어요?
      </div>

      <EntryCard emphasis="primary"
        title="안전밸브 사양 검토하기"
        desc="내 안전밸브가 적정한지 확인합니다."
        onClick={onStartReview}/>

      {hasCases && (
        <EntryCard emphasis="secondary"
          title="기존 검토 이어하기"
          desc="이전에 작성한 검토를 계속합니다."
          onClick={onShowExisting}/>
      )}

      <button onClick={onStartExample}
        style={{display:"block",width:"100%",textAlign:"center",background:"transparent",
          border:"none",color:T.blue,fontSize:11,fontWeight:700,fontFamily:font.sans,
          cursor:"pointer",padding:"8px 4px",marginTop:2}}>
        처음이라면 예시로 검토해보기
      </button>
    </div>
  );
}

// C-4.30: "기존 검토 이어하기"를 눌렀을 때만 보여주는 목록 — 여기서도
// 사용자에게는 "Case"라는 말을 쓰지 않는다(카드 자체가 밸브Tag·위치·
// 판정만 보여줌).
function ExistingReviewList({ cases, onOpen, onBack }) {
  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
        <button onClick={onBack}
          style={{padding:"8px 12px",background:T.bg,border:`1px solid ${T.border}`,
            borderRadius:9,fontSize:13,fontWeight:700,color:T.sub,
            fontFamily:font.mono,cursor:"pointer"}}>←</button>
        <div style={{fontSize:14,fontWeight:900,color:T.navy,fontFamily:font.sans}}>
          진행 중인 검토
        </div>
      </div>
      {cases.length === 0 ? (
        <div style={{textAlign:"center",padding:"40px 20px",color:T.gray,fontFamily:font.sans}}>
          <div style={{fontSize:40,marginBottom:10}}>📋</div>
          <div style={{fontSize:13,color:T.sub,fontWeight:700}}>진행 중인 검토가 없습니다</div>
        </div>
      ) : (
        cases.map(c => <CaseCard key={c.id} c={c} onOpen={onOpen}/>)
      )}
    </div>
  );
}

// C-4.30: Primary CTA("안전밸브 사양 검토하기") 클릭 직후 보여주는 목적
// 중심 중간 화면. "설비를 선택하세요"로 시작하지 않는다 — 내부적으로는
// Equipment를 다루더라도 사용자에게는 "등록된 안전밸브"로 설명한다.
function ReviewEntryScreen({ onSelectExisting, onCreateNew, onBack }) {
  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
        <button onClick={onBack}
          style={{padding:"8px 12px",background:T.bg,border:`1px solid ${T.border}`,
            borderRadius:9,fontSize:13,fontWeight:700,color:T.sub,
            fontFamily:font.mono,cursor:"pointer"}}>←</button>
      </div>
      <div style={{fontSize:15,fontWeight:900,color:T.navy,fontFamily:font.sans,marginBottom:4}}>
        어떤 안전밸브를 검토할까요?
      </div>
      <div style={{fontSize:11,color:T.sub,fontFamily:font.sans,marginBottom:16}}>
        검토할 안전밸브를 선택하거나 새로 입력할 수 있습니다.
      </div>

      <EntryCard emphasis="secondary"
        title="① 등록된 안전밸브에서 선택"
        desc="이미 등록된 설비의 안전밸브 사양으로 검토합니다."
        onClick={onSelectExisting}/>
      <EntryCard emphasis="secondary"
        title="② 새 안전밸브 정보 입력"
        desc="아직 등록하지 않은 안전밸브의 사양을 입력합니다."
        onClick={onCreateNew}/>
    </div>
  );
}

function Dashboard({ cases, onOpenCase, onStartReview, onStartExample, onWipeAllData }) {
  // C-4.30: 첫 화면은 이제 "목적 선택 메뉴"가 기본이고, "기존 검토
  // 이어하기"를 눌렀을 때만 실제 목록 화면으로 전환한다(같은 컴포넌트
  // 내부 상태 — 별도 top-level screen을 늘리지 않음, §13 상태2).
  const [showExisting, setShowExisting] = useState(false);
  const hasCases = cases.length > 0;

  return (
    <div>
      {showExisting ? (
        <ExistingReviewList cases={cases} onOpen={onOpenCase}
          onBack={()=>setShowExisting(false)}/>
      ) : (
        <FirstRunMenu hasCases={hasCases}
          onStartReview={onStartReview}
          onShowExisting={()=>setShowExisting(true)}
          onStartExample={onStartExample}/>
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
