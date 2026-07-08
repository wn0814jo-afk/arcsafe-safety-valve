//  ROOT — ArcSafe App (v0.2.0-asset-master)
// ════════════════════════════════════════════════════════════════
function ArcSafe() {
  const [equipments, setEquipments] = useState(() =>
    SAMPLE_EQUIPMENT.map(e => createEquipment(e))
  );
  const [dischargeSystems, setDischargeSystems] = useState(() =>
    SAMPLE_DISCHARGE_SYSTEMS.map(d => createDischargeSystem(d))
  );
  const [cases,      setCases]      = useState([]);
  const [activeCase, setActiveCase] = useState(null);
  const [screen,     setScreen]     = useState("dashboard");

  const handleOpenCase = (c) => setActiveCase(c);
  const handleBack = () => setActiveCase(null);

  // Equipment 선택 → Case 생성 → CaseView 진입
  const handleEquipmentSelect = (equipment) => {
    const ds = dischargeSystems.find(
      d => d.connectedTags.includes(equipment.tag)
    ) || null;
    const newCase = {
      id:               `C-${new Date().getFullYear()}-${String(cases.length+1).padStart(3,"0")}`,
      valveTag:         equipment.tag,
      equipment:        equipment,
      dischargeSystemId:ds?.id || null,
      fluid:            "CO₂ (고압)",
      reviewType:       "정기 PSM 검토",
      workflow:         "DRAFT",
      latestSnap:       null,   // pointer only — 검증에 사용 금지
      snapshotHistory:  [],     // source of truth (append-only)
      approvals:        [],     // ApprovalRecord[] (append-only, service.js를 통해서만 갱신)
    };
    setCases(prev => [...prev, newCase]);
    setActiveCase(newCase);
    setScreen("dashboard");
  };

  const handleAddEquipment = (eq) =>
    setEquipments(prev => [...prev, eq]);

  // EQUIPMENT-MOC: DischargeSystem과 동일 계약 — id 유지, revision만 교체
  const handleReviseEquipment = (revisedEq) =>
    setEquipments(prev => prev.map(e => e.id === revisedEq.id ? revisedEq : e));

  const handleAddDischargeSystem = (ds) =>
    setDischargeSystems(prev => [...prev, ds]);

  // GEOMETRY-002: id는 그대로, revision만 올라간 새 객체로 교체.
  // Asset은 Snapshot이 아니라 "현재 상태" — 교체 자체는 허용(append-only 아님).
  // MOC 감지는 이 교체 이후 케이스 재진입 시 assetFingerprint 비교로 자동 발동.
  const handleReviseDischargeSystem = (revisedDs) =>
    setDischargeSystems(prev => prev.map(d => d.id === revisedDs.id ? revisedDs : d));

  // HISTORY-001과 동일 원칙: overwrite 금지, service.js가 만든 새 배열만 반영
  const handleApprovalUpdate = (caseId, approvals) => {
    setCases(prev => prev.map(c =>
      c.id !== caseId ? c : { ...c, approvals }
    ));
    setActiveCase(prev =>
      prev && prev.id === caseId ? { ...prev, approvals } : prev
    );
  };

  // HISTORY-001: overwrite 금지 — 항상 appendSnapshot()으로 history에 추가
  const handleSnapshotCreate = (caseId, snap) => {
    setCases(prev => prev.map(c =>
      c.id !== caseId ? c : appendSnapshot(c, snap)
    ));
    setActiveCase(prev =>
      prev && prev.id === caseId ? appendSnapshot(prev, snap) : prev
    );
  };

  const curScreen = activeCase ? "case"
    : screen === "assets" ? "assets"
    : "dashboard";

  return (
    <div style={{minHeight:"100vh",background:T.bg,fontFamily:font.sans}}>
      {/* 글로벌 헤더 */}
      <div style={{background:T.navy,padding:"11px 16px",display:"flex",
        alignItems:"center",justifyContent:"space-between",
        position:"sticky",top:0,zIndex:100}}>
        <div>
          <div style={{fontSize:16,fontWeight:900,color:T.white,
            fontFamily:font.mono,letterSpacing:1}}>ArcSafe</div>
          <div style={{fontSize:9,color:"#7B9EC0",fontFamily:font.mono}}>
            PSM 안전밸브 관리 시스템
          </div>
          <div style={{fontSize:8,color:"#4A6FA5",fontFamily:font.mono,marginTop:1}}>
            v0.2.0 · {typeof __BUILD_HASH__ !== "undefined" ? __BUILD_HASH__ : "dev"}
          </div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {activeCase && (
            <div style={{fontSize:11,color:"#7B9EC0",fontFamily:font.mono}}>
              {activeCase.valveTag}
            </div>
          )}
          {!activeCase && (
            <button
              onClick={()=>setScreen(screen==="assets"?"dashboard":"assets")}
              style={{padding:"6px 11px",
                background:screen==="assets"?T.blue:"none",
                border:`1px solid ${screen==="assets"?T.blue:"#4A6FA5"}`,
                borderRadius:8,fontSize:10,
                color:screen==="assets"?T.white:"#7B9EC0",
                fontFamily:font.mono,cursor:"pointer"}}>
              🔧 설비대장
            </button>
          )}
        </div>
      </div>

      {/* 컨텐츠 */}
      <div style={{padding:"14px 14px 40px",maxWidth:640,margin:"0 auto"}}>
        {curScreen === "case" && activeCase && (
          <CaseView
            caseData={activeCase}
            dischargeSystems={dischargeSystems}
            onBack={handleBack}
            onSnapshotCreate={handleSnapshotCreate}
            onApprovalUpdate={handleApprovalUpdate}
          />
        )}
        {curScreen === "assets" && (
          <AssetMaster
            equipments={equipments}
            dischargeSystems={dischargeSystems}
            onSelectEquipment={handleEquipmentSelect}
            onAddEquipment={handleAddEquipment}
            onReviseEquipment={handleReviseEquipment}
            onAddDischargeSystem={handleAddDischargeSystem}
            onReviseDischargeSystem={handleReviseDischargeSystem}
            onBack={()=>setScreen("dashboard")}
          />
        )}
        {curScreen === "dashboard" && (
          <Dashboard
            cases={cases}
            onOpenCase={handleOpenCase}
            onNewCase={()=>setScreen("assets")}
            onOpenAssetMaster={()=>setScreen("assets")}
          />
        )}
      </div>
    </div>
  );
}
