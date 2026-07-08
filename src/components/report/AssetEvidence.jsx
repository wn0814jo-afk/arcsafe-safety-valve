//  ASSET EVIDENCE
//  AUDIT-001: snapshot.assetRefs만 읽는다. "지금 이 순간의" Asset 상태 참조 금지
//  — 감사자는 "검토 당시 무엇이었는지"를 봐야 하며 최신 Asset 값과 섞이면
//  증거가 아니라 현재값이 되어버린다.
// ════════════════════════════════════════════════════════════════
function AssetEvidence({ snapshot }) {
  const refs = snapshot.assetRefs || {};
  const ds = snapshot.dischargeSystem; // 당시 박제된 값 — 현재 Asset 아님 (AUDIT-001)
  return (
    <div>
      <div style={{fontSize:9,fontWeight:700,color:T.sub,fontFamily:font.mono,
        letterSpacing:1,marginBottom:6}}>ASSET</div>
      <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12}}>
        <span style={{color:T.sub,fontFamily:font.mono}}>Equipment</span>
        <span style={{color:T.text,fontWeight:700,fontFamily:font.mono}}>
          {refs.equipmentTag || "—"} · Rev.{refs.equipmentRevision ?? "—"}
        </span>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12}}>
        <span style={{color:T.sub,fontFamily:font.mono}}>Discharge</span>
        <span style={{color:T.text,fontWeight:700,fontFamily:font.mono}}>
          {refs.dischargeSystemName || "—"} · Rev.{refs.dischargeRevision ?? "—"}
        </span>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:11}}>
        <span style={{color:T.gray,fontFamily:font.mono}}>Fingerprint</span>
        <span style={{color:T.gray,fontFamily:font.mono}}>
          {(refs.assetFingerprint || "").slice(0,16)}
        </span>
      </div>
      <div style={{fontSize:9,fontWeight:700,color:T.sub,fontFamily:font.mono,
        letterSpacing:1,margin:"10px 0 4px"}}>BACKPRESSURE BASIS</div>
      <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12}}>
        <span style={{color:T.sub,fontFamily:font.mono}}>Header Pressure</span>
        <span style={{color:T.text,fontWeight:700,fontFamily:font.mono}}>
          {ds?.headerPressure ?? "—"} barg
        </span>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12}}>
        <span style={{color:T.sub,fontFamily:font.mono}}>Pipe / Diameter</span>
        <span style={{color:T.text,fontWeight:700,fontFamily:font.mono}}>
          {ds?.L ?? "—"}m / Ø{ds?.D != null ? Math.round(ds.D*1000) : "—"}mm
        </span>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12}}>
        <span style={{color:T.sub,fontFamily:font.mono}}>Fittings K</span>
        <span style={{color:T.text,fontWeight:700,fontFamily:font.mono}}>{ds?.fittingsK ?? "—"}</span>
      </div>
    </div>
  );
}
