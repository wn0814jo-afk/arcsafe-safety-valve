//  ROOT — ArcSafe App (v0.2.0-asset-master)
// ════════════════════════════════════════════════════════════════
function ArcSafe() {
  // ASSET-HISTORY-001~004: Asset Repository는 append-only history만 저장하고,
  // "현재 상태" 목록(equipments/dischargeSystems)은 항상 파생값이다.
  // 저장하는 것: equipmentHistory / dischargeHistory
  // 계산하는 것: equipments / dischargeSystems (아래 useMemo)
  //
  // C-4.22-B(PERSISTENCE-001): 초기값을 더 이상 SAMPLE_*로 즉시 채우지
  // 않는다 — 아래 hydrate useEffect가 IndexedDB에 저장된 데이터가
  // 있으면 그걸로, 완전히 비어있을 때만(최초 실행) 샘플로 채운다.
  // "복귀 사용자에게 샘플 데이터가 잠깐 보였다가 실제 데이터로 바뀌는"
  // 깜빡임을 피하기 위해 초기 useState는 빈 배열로 시작한다.
  const [equipmentHistory, setEquipmentHistory] = useState(() => Object.freeze([]));
  const [dischargeHistory, setDischargeHistory] = useState(() => Object.freeze([]));
  const equipments = useMemo(
    () => getAllLatestRevisions(equipmentHistory), [equipmentHistory]
  );
  const dischargeSystems = useMemo(
    () => getAllLatestRevisions(dischargeHistory), [dischargeHistory]
  );
  const [cases,      setCases]      = useState([]);
  const [activeCase, setActiveCase] = useState(null);
  const [screen,     setScreen]     = useState("dashboard");
  // C-4.30: "review-entry"(어떤 안전밸브를 검토할까요?) 중간 화면과,
  // 거기서 "② 새 안전밸브 정보 입력"을 골랐을 때 AssetMaster가 신규
  // 등록 폼을 자동으로 열게 하는 1회성 의도 플래그.
  const [entryIntent, setEntryIntent] = useState(null); // null | "new"

  // ── C-4.22-B — Device-local persistence hydrate (최초 1회) ──
  // PERSISTENCE-002: 이 로드가 실패해도(IndexedDB 미지원/차단 등) 앱은
  // 그냥 빈 상태(기존 구조 그대로, 메모리 전용)로 정상 동작한다 —
  // 계산/화면 렌더링을 절대 막지 않는다.
  const [persistenceStatus, setPersistenceStatus] = useState(
    CaseRepository.isAvailable() ? "loading" : "unavailable"
  );
  useEffect(() => {
    if (!CaseRepository.isAvailable()) return;
    let cancelled = false;
    CaseRepository.load().then(res => {
      if (cancelled) return;
      if (!res.ok) { setPersistenceStatus("error"); return; }
      const hasAnyStoredData =
        res.equipmentHistory.length > 0 || res.dischargeHistory.length > 0 || res.cases.length > 0;
      if (hasAnyStoredData) {
        if (res.equipmentHistory.length > 0) setEquipmentHistory(Object.freeze(res.equipmentHistory));
        if (res.dischargeHistory.length > 0) setDischargeHistory(Object.freeze(res.dischargeHistory));
        setCases(res.cases);
      } else {
        // 완전히 빈 DB = 최초 실행. 지금 쓰는 샘플로 채우고, 그 샘플을
        // 그대로 저장해둔다 — 다음 방문부터는 이 분기를 다시 안 탄다.
        const seedEquip = Object.freeze(SAMPLE_EQUIPMENT.map(e => createEquipment(e)));
        const seedDischarge = Object.freeze(SAMPLE_DISCHARGE_SYSTEMS.map(d => createDischargeSystem(d)));
        setEquipmentHistory(seedEquip);
        setDischargeHistory(seedDischarge);
        seedEquip.forEach(e => CaseRepository.saveEquipmentRevision(e));
        seedDischarge.forEach(d => CaseRepository.saveDischargeRevision(d));
      }
      setPersistenceStatus("ok");
    });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // PLAN BADGE (Phase 1, 2026-09) — 계정 상태 표시 전용. 포트폴리오 공용 plan-badge.js와
  // 동일 계약(policy/me 직접 조회, 노출 상태 anonymous/free/pro 3개, 실패 시 Free로
  // 추정하지 않고 미확정 유지)을 이 앱의 단일 번들 구조 안에서 그대로 재현한 것 — AuthClient
  // (authState/authUser)의 로그인 판정 로직에는 관여하지 않는, 완전히 별도의 policy/me 조회다.
  const [planBadgeState, setPlanBadgeState] = useState(null);
  useEffect(() => {
    let cancelled = false;
    function resolvePlan(attempt) {
      fetch("https://policy.archsafe.co.kr/policy/me", { credentials: "include" })
        .then(res => {
          if (res.status === 401) return { state: "anonymous" };
          if (!res.ok) throw new Error("policy/me HTTP " + res.status);
          return res.json().then(data => {
            const plan = data && data.billing && data.billing.plan;
            if (plan === "PRO_MONTHLY" || plan === "pro") return { state: "pro" };
            if (plan === "free") return { state: "free" };
            if (!plan) return { state: "anonymous" };
            throw new Error("unrecognized plan: " + plan);
          });
        })
        .then(r => { if (!cancelled) setPlanBadgeState(r.state); })
        .catch(() => {
          if (!cancelled) {
            if (attempt < 2) setTimeout(() => resolvePlan(attempt + 1), 900);
            // 재시도 후에도 실패하면 planBadgeState는 null로 유지한다 — Free로
            // 추정 표시하지 않는다(fail-closed).
          }
        });
    }
    resolvePlan(1);
    return () => { cancelled = true; };
  }, []);

  // B3 Impact Analysis용: 모든 Case의 snapshotHistory를 이어붙인 평탄화 배열.
  // 각 case.snapshotHistory는 append-only(순서 보존)이므로, 이를 그대로 이어붙이면
  // caseId별 마지막 등장 원소 = 그 Case의 최신 Snapshot이 된다 (analyzeRevisionImpact 전제).
  const allSnapshots = useMemo(
    () => cases.flatMap(c => c.snapshotHistory || []), [cases]
  );

  const handleOpenCase = (c) => setActiveCase(c);
  const handleBack = () => setActiveCase(null);

  // C-4.30: "예시로 검토해보기" — 실제 Case를 하나도 만들지 않는다.
  // cases 배열에 절대 추가하지 않음(Dashboard 목록/CaseRepository.saveCase
  // 양쪽에서 자연히 격리됨 — Snapshot/승인 갱신 핸들러가 cases.map으로 대상을 찾을 때 이 id가 배열에 없으므로 매치 자체가
  // 안 되고, activeCase 쪽만 직접 갱신되어 화면은 정상 동작하면서도
  // 저장은 전혀 안 되는 기존 구조를 그대로 활용). SAMPLE_EQUIPMENT의
  // PSV-R201을 그대로 사용 — 새 fixture를 만들지 않는다.
  const handleStartExample = () => {
    const eq = equipments.find(e => e.tag === "PSV-R201") || equipments[0];
    if (!eq) return;
    const ds = dischargeSystems.find(d => d.connectedTags.includes(eq.tag)) || null;
    const exampleCase = {
      id:               "EXAMPLE-CASE",
      valveTag:         eq.tag,
      equipment:        eq,
      dischargeSystemId:ds?.id || null,
      reviewType:       "예시 검토",
      workflow:         "DRAFT",
      latestSnap:       null,
      snapshotHistory:  [],
      approvals:        [],
      isExample:        true, // 표시 전용 — Case schema 필드 아님
    };
    setActiveCase(exampleCase);
  };

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
      // C-4.25 FLUID-001: fluid 필드를 여기서 복제하지 않는다 — 실제 계산에
      // 쓰인 유체의 authoritative source는 Snapshot(snapshot.inputs.M/k)
      // 뿐이다. Dashboard가 latestSnap에서 직접 조회해 표시한다.
      reviewType:       "정기 PSM 검토",
      workflow:         "DRAFT",
      latestSnap:       null,   // pointer only — 검증에 사용 금지
      snapshotHistory:  [],     // source of truth (append-only)
      approvals:        [],     // ApprovalRecord[] (append-only, service.js를 통해서만 갱신)
    };
    setCases(prev => [...prev, newCase]);
    setActiveCase(newCase);
    setScreen("dashboard");
    // C-4.22-B: Case 생성 즉시 저장 — 이 레코드가 있어야 새로고침 후
    // CaseView가 같은 caseId로 재진입해서 caseDrafts를 찾을 수 있다.
    CaseRepository.saveCase(newCase);
  };

  // ASSET-HISTORY-001: append만 허용, 기존 revision을 교체·삭제하지 않는다.
  const handleAddEquipment = (eq) => {
    setEquipmentHistory(prev => appendRevision(prev, eq));
    CaseRepository.saveEquipmentRevision(eq);
  };

  // EQUIPMENT-MOC + ASSET-HISTORY-001: id는 유지, revision은 append.
  // 이전 revision은 overwrite되지 않고 history에 그대로 남는다 —
  // 한 번도 Case에서 참조되지 않은 revision도 소실되지 않음.
  const handleReviseEquipment = (revisedEq) => {
    setEquipmentHistory(prev => appendRevision(prev, revisedEq));
    CaseRepository.saveEquipmentRevision(revisedEq);
  };

  const handleAddDischargeSystem = (ds) => {
    setDischargeHistory(prev => appendRevision(prev, ds));
    CaseRepository.saveDischargeRevision(ds);
  };

  // GEOMETRY-002 + ASSET-HISTORY-001: id는 그대로, revision은 append.
  // Asset도 Snapshot과 동일하게 append-only history로 관리하고,
  // "현재 상태"는 저장하지 않고 history로부터 파생시킨다(equipments/dischargeSystems useMemo).
  // MOC 감지는 이 append 이후 케이스 재진입 시 assetFingerprint 비교로 자동 발동.
  const handleReviseDischargeSystem = (revisedDs) => {
    setDischargeHistory(prev => appendRevision(prev, revisedDs));
    CaseRepository.saveDischargeRevision(revisedDs);
  };

  // HISTORY-001과 동일 원칙: overwrite 금지, service.js가 만든 새 배열만 반영
  const handleApprovalUpdate = (caseId, approvals) => {
    let updatedCase = null;
    setCases(prev => prev.map(c => {
      if (c.id !== caseId) return c;
      updatedCase = { ...c, approvals };
      return updatedCase;
    }));
    setActiveCase(prev =>
      prev && prev.id === caseId ? { ...prev, approvals } : prev
    );
    // C-4.22-B: PERSISTENCE-002 — 저장 실패가 승인 처리 자체를 막지
    // 않는다(이미 setCases/setActiveCase로 UI는 갱신 완료). fire-and-forget.
    if (updatedCase) CaseRepository.saveApproval(updatedCase);
  };

  // HISTORY-001: overwrite 금지 — 항상 appendSnapshot()으로 history에 추가
  const handleSnapshotCreate = (caseId, snap) => {
    let updatedCase = null;
    setCases(prev => prev.map(c => {
      if (c.id !== caseId) return c;
      updatedCase = appendSnapshot(c, snap);
      return updatedCase;
    }));
    setActiveCase(prev =>
      prev && prev.id === caseId ? appendSnapshot(prev, snap) : prev
    );
    // C-4.22-B: Engine 계산 → Snapshot 생성 → 화면 표시는 이미 위에서
    // 완료됐다. persistence는 그 뒤에 별도로 시도한다 — 여기서 실패해도
    // 이미 만들어진 Snapshot/화면 표시는 그대로 유지된다(PERSISTENCE-002).
    if (updatedCase) CaseRepository.saveCase(updatedCase);
  };

  // C-4.22-B — "이 기기의 저장 데이터 초기화". 서버 백업이 없으므로
  // 되돌릴 수 없다는 걸 명확히 경고한 뒤에만 실행한다. 초기화 후에는
  // React state 전체를 IndexedDB 결과와 다시 맞추는 것보다 페이지를
  // 새로고침하는 편이 훨씬 안전하다(state 잔여물이 남을 위험이 없음).
  const handleWipeAllData = async () => {
    const confirmed = window.confirm(
      "이 기기의 모든 archsafe 저장 자료(설비대장, 검토 중인 Case, Snapshot)가 " +
      "삭제되며, 서버 백업이 없어 복구할 수 없습니다.\n정말 초기화하시겠습니까?"
    );
    if (!confirmed) return;
    const res = await CaseRepository.wipeAll();
    if (!res.ok) {
      alert(`초기화에 실패했습니다: ${res.error}`);
      return;
    }
    window.location.reload();
  };

  const curScreen = activeCase ? "case"
    : screen === "assets" ? "assets"
    : screen === "review-entry" ? "review-entry"
    : "dashboard";

  return (
    <div style={{minHeight:"100vh",background:T.bg,fontFamily:font.sans}}>
      {/* 글로벌 헤더 */}
      <div style={{background:T.navy,padding:"11px 16px",display:"flex",
        alignItems:"center",justifyContent:"space-between",
        position:"sticky",top:0,zIndex:100}}>
        <div>
          <div style={{fontSize:16,fontWeight:900,color:T.white,
            fontFamily:font.mono,letterSpacing:1}}>ArchSafe</div>
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
          {authState === "authenticated" && authUser && (planBadgeState === "free" || planBadgeState === "pro") && (
            <a
              href="/pro/"
              style={{padding:"2px 9px",borderRadius:10,fontFamily:font.mono,fontSize:10,
                fontWeight:700,letterSpacing:.3,whiteSpace:"nowrap",textDecoration:"none",cursor:"pointer",
                color: planBadgeState === "pro" ? "#8a5c0a" : "#0d7a4e",
                background: planBadgeState === "pro" ? "#fef3df" : "#e6f4ee"}}>
              {planBadgeState === "pro" ? "PRO" : "FREE"}
            </a>
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
            autoOpenNewEquipmentForm={entryIntent === "new"}
            onBack={()=>{ setScreen("dashboard"); setEntryIntent(null); }}
          />
        )}
        {curScreen === "review-entry" && (
          <ReviewEntryScreen
            onSelectExisting={()=>{ setEntryIntent(null); setScreen("assets"); }}
            onCreateNew={()=>{ setEntryIntent("new"); setScreen("assets"); }}
            onBack={()=>setScreen("dashboard")}
          />
        )}
        {curScreen === "dashboard" && (
          <Dashboard
            cases={cases}
            onOpenCase={handleOpenCase}
            onStartReview={()=>setScreen("review-entry")}
            onStartExample={handleStartExample}
            onWipeAllData={CaseRepository.isAvailable() ? handleWipeAllData : null}
          />
        )}
      </div>
    </div>
  );
}
