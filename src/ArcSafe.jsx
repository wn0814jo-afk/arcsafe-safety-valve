//  ROOT — ArcSafe App (v0.2.0-asset-master)
// ════════════════════════════════════════════════════════════════
function ArcSafe() {
  // ASSET-HISTORY-001~004: Asset Repository는 append-only history만 저장하고,
  // "현재 상태" 목록(equipments/dischargeSystems)은 항상 파생값이다.
  // 저장하는 것: equipmentHistory / dischargeHistory
  // 계산하는 것: equipments / dischargeSystems (아래 useMemo)
  const [equipmentHistory, setEquipmentHistory] = useState(() =>
    Object.freeze(SAMPLE_EQUIPMENT.map(e => createEquipment(e)))
  );
  const [dischargeHistory, setDischargeHistory] = useState(() =>
    Object.freeze(SAMPLE_DISCHARGE_SYSTEMS.map(d => createDischargeSystem(d)))
  );
  const equipments = useMemo(
    () => getAllLatestRevisions(equipmentHistory), [equipmentHistory]
  );
  const dischargeSystems = useMemo(
    () => getAllLatestRevisions(dischargeHistory), [dischargeHistory]
  );
  const [cases,      setCases]      = useState([]);
  const [activeCase, setActiveCase] = useState(null);
  const [screen,     setScreen]     = useState("dashboard");

  // AUTH — auth.archsafe.co.kr SDK 연동 (AUTH_INTEGRATION_STANDARD.md 표준)
  // 절대 규칙: /auth/me 등을 직접 fetch하지 않고 AuthClient SDK만 통해 접근.
  // JWT 직접 decode 금지, 세션은 auth-worker의 HttpOnly 쿠키만 사용.
  // Engine 입력에는 identity를 절대 넘기지 않음 — 아래 authUser는 헤더 UI 표시 전용.
  const [authUser,  setAuthUser]  = useState(null);
  const [authState, setAuthState] = useState("loading"); // loading | authenticated | unauthenticated | unavailable
  useEffect(() => {
    if (typeof AuthClient === "undefined") { setAuthState("unavailable"); return; }
    const auth = new AuthClient({ baseUrl: "https://auth.archsafe.co.kr" });
    auth.onChange((state, user) => {
      setAuthState(state);
      setAuthUser(state === "authenticated" ? user : null);
    });
    auth.init();
    window.__archsafeAuth = auth; // logout 버튼에서 참조
  }, []);
  const handleLogin = () => {
    window.location.href = "https://auth.archsafe.co.kr/auth/login?return_to=" +
      encodeURIComponent(window.location.href);
  };
  const handleLogout = () => { if (window.__archsafeAuth) window.__archsafeAuth.logout(); };

  // B3 Impact Analysis용: 모든 Case의 snapshotHistory를 이어붙인 평탄화 배열.
  // 각 case.snapshotHistory는 append-only(순서 보존)이므로, 이를 그대로 이어붙이면
  // caseId별 마지막 등장 원소 = 그 Case의 최신 Snapshot이 된다 (analyzeRevisionImpact 전제).
  const allSnapshots = useMemo(
    () => cases.flatMap(c => c.snapshotHistory || []), [cases]
  );

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

  // ASSET-HISTORY-001: append만 허용, 기존 revision을 교체·삭제하지 않는다.
  const handleAddEquipment = (eq) =>
    setEquipmentHistory(prev => appendRevision(prev, eq));

  // EQUIPMENT-MOC + ASSET-HISTORY-001: id는 유지, revision은 append.
  // 이전 revision은 overwrite되지 않고 history에 그대로 남는다 —
  // 한 번도 Case에서 참조되지 않은 revision도 소실되지 않음.
  const handleReviseEquipment = (revisedEq) =>
    setEquipmentHistory(prev => appendRevision(prev, revisedEq));

  const handleAddDischargeSystem = (ds) =>
    setDischargeHistory(prev => appendRevision(prev, ds));

  // GEOMETRY-002 + ASSET-HISTORY-001: id는 그대로, revision은 append.
  // Asset도 Snapshot과 동일하게 append-only history로 관리하고,
  // "현재 상태"는 저장하지 않고 history로부터 파생시킨다(equipments/dischargeSystems useMemo).
  // MOC 감지는 이 append 이후 케이스 재진입 시 assetFingerprint 비교로 자동 발동.
  const handleReviseDischargeSystem = (revisedDs) =>
    setDischargeHistory(prev => appendRevision(prev, revisedDs));

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
          {authState === "authenticated" && authUser && (
            <div
              onClick={handleLogout}
              title="클릭하여 로그아웃"
              style={{fontSize:10,color:"#7B9EC0",fontFamily:font.mono,
                cursor:"pointer",maxWidth:120,overflow:"hidden",
                textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {authUser.email}
            </div>
          )}
          {authState === "unauthenticated" && (
            <button
              onClick={handleLogin}
              style={{padding:"6px 11px",background:"none",
                border:"1px solid #4A6FA5",borderRadius:8,fontSize:10,
                color:"#7B9EC0",fontFamily:font.mono,cursor:"pointer"}}>
              로그인
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
            equipmentHistory={equipmentHistory}
            dischargeHistory={dischargeHistory}
            allSnapshots={allSnapshots}
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
