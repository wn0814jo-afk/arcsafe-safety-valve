//  NEW CASE FORM — 기본 정보 입력
// ════════════════════════════════════════════════════════════════
const FLUID_OPTIONS = ["CO₂ (고압)","N₂ (불활성)","수증기 (Steam)","공기","메탄 (CH₄)","기타"];
const REVIEW_OPTIONS = ["정기 PSM 검토","최초 설치 검토","변경 검토 (MOC)","사고 후 검토","기타"];

function NewCaseForm({ onConfirm, onCancel }) {
  const [tag,    setTag]    = useState("");
  const [loc,    setLoc]    = useState("");
  const [fluid,  setFluid]  = useState(FLUID_OPTIONS[0]);
  const [review, setReview] = useState(REVIEW_OPTIONS[0]);

  const valid = tag.trim().length > 0;

  const iStyle = {
    width:"100%", padding:"12px 13px", borderRadius:10,
    fontSize:15, fontFamily:font.mono, color:T.text,
    boxSizing:"border-box", background:T.white, outline:"none",
    WebkitAppearance:"none", appearance:"none",
  };

  return (
    <div style={{background:T.cardBg,borderRadius:16,padding:18,
      border:`1.5px solid ${T.border}`,boxShadow:"0 4px 16px #0002"}}>
      <div style={{fontSize:15,fontWeight:900,color:T.navy,fontFamily:font.mono,marginBottom:16}}>
        새 검토 등록
      </div>

      <div style={{marginBottom:14}}>
        <div style={{fontSize:11,fontWeight:700,color:T.sub,fontFamily:font.mono,marginBottom:5}}>
          Tag No. <span style={{color:T.red}}>*</span>
        </div>
        <input
          type="text"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder="예: PSV-R301"
          autoComplete="off" autoCorrect="off" spellCheck="false"
          style={{...iStyle, border:`1.5px solid ${valid ? T.navyLight : T.border}`}}
        />
        {/* 입력 확인용 즉시 표시 — 디버그 겸 사용자 피드백 */}
        <div style={{fontSize:11,color:tag?T.navyLight:T.gray,fontFamily:font.mono,marginTop:5,minHeight:16}}>
          {tag ? `입력됨: "${tag}"` : "아직 입력되지 않음"}
        </div>
      </div>

      <div style={{marginBottom:14}}>
        <div style={{fontSize:11,fontWeight:700,color:T.sub,fontFamily:font.mono,marginBottom:5}}>설치 위치</div>
        <input
          type="text"
          value={loc}
          onChange={(e) => setLoc(e.target.value)}
          placeholder="예: 반응기 R-301 상부"
          autoComplete="off"
          style={{...iStyle, border:`1.5px solid ${T.border}`}}
        />
      </div>

      <div style={{marginBottom:14}}>
        <div style={{fontSize:11,fontWeight:700,color:T.sub,fontFamily:font.mono,marginBottom:5}}>유체</div>
        <select value={fluid} onChange={(e) => setFluid(e.target.value)}
          style={{...iStyle, border:`1.5px solid ${T.border}`, cursor:"pointer"}}>
          {FLUID_OPTIONS.map(o=><option key={o} value={o}>{o}</option>)}
        </select>
      </div>

      <div style={{marginBottom:18}}>
        <div style={{fontSize:11,fontWeight:700,color:T.sub,fontFamily:font.mono,marginBottom:5}}>검토 유형</div>
        <select value={review} onChange={(e) => setReview(e.target.value)}
          style={{...iStyle, border:`1.5px solid ${T.border}`, cursor:"pointer"}}>
          {REVIEW_OPTIONS.map(o=><option key={o} value={o}>{o}</option>)}
        </select>
      </div>

      <div style={{display:"flex",gap:10}}>
        <button onClick={onCancel}
          style={{flex:1,padding:"13px",background:T.bg,color:T.sub,
            border:`1px solid ${T.border}`,borderRadius:11,fontSize:13,
            fontWeight:700,fontFamily:font.mono,cursor:"pointer"}}>
          취소
        </button>
        <button
          onClick={()=>{ if(valid) onConfirm({tag:tag.trim(),loc,fluid,review}); }}
          style={{flex:2,padding:"13px",
            background:valid?T.navyLight:"#CBD5E1",
            color:T.white,border:"none",borderRadius:11,fontSize:13,
            fontWeight:900,fontFamily:font.sans,
            cursor:valid?"pointer":"not-allowed",
            boxShadow:valid?`0 4px 0 ${T.navy}`:"none",
            transition:"all 0.15s"}}>
          {valid ? "검토 등록 →" : "Tag 입력 후 등록"}
        </button>
      </div>
    </div>
  );
}
