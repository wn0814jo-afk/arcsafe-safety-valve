//  CASE VIEW
// ════════════════════════════════════════════════════════════════

// ── RELIEF LOAD — 대상 시나리오 메타(라벨 + 계산 함수 매핑) ──
// C-4.9 범위: §5.1/§5.6/§5.7/§5.8. C-4.10에서 §5.12(외부화재)를 추가한다.
// §5.11/§5.13은 governing 후보가 아니므로(단위가 kg/h가 아님) 이 메타에는
// 절대 포함하지 않는다 — relief_load.js의 계산 함수 자체는 이미 구현되어
// 있으나, 이 메타는 "governing 배타 선택 라디오 그룹"만을 위한 것이다.
// §5.11(액체부피팽창)은 C-4.12 REV2부터 이 메타·라디오 그룹과 완전히
// 분리된 독립 state(liquidExpansionInput/liquidExpansionResult, 아래
// 참고)로 직접 호출한다.
const RELIEF_LOAD_SCENARIO_META = {
  OUTLET_BLOCKED:     { label: "출구 차단",           section: "§5.1",  calc: calculateOutletBlockedScenario },
  OVERFILLING:         { label: "과충전",               section: "§5.6",  calc: calculateOverfillingScenario },
  CONTROL_VALVE_FAIL:  { label: "자동제어밸브 고장",    section: "§5.7",  calc: calculateControlValveFailureScenario },
  ABNORMAL_HEAT_VAPOR: { label: "비정상 열/증기 유입",  section: "§5.8",  calc: calculateAbnormalHeatVaporScenario },
  EXTERNAL_FIRE:       { label: "외부화재",             section: "§5.12", calc: calculateExternalFireScenario },
};

// ── C-4.10 — §5.12 EXTERNAL_FIRE 전용 입력 조립기 ──
// fMethod/t1Method/scenarioMSource는 계산 함수(calculateExternalFireScenario)의
// 파라미터가 아니라 UI 전용 판별자다(설계 확정본 9장). 이 함수는 relief_load.js를
// 전혀 수정하지 않고, 계산 호출 직전에 "선택된 경로의 필드만" 남긴 입력 객체를
// UI 레이어에서 조립한다 — relief_load.js는 입력을 { ...input }으로 그대로
// 되돌려 주므로(결과의 inputs 필드), scenarioMSource를 조립된 입력에 실어
// 보내면 계산 로직 변경 없이 Snapshot.reliefLoad까지 그대로 전달된다.
function buildExternalFireScenarioInput(raw) {
  if (!raw || typeof raw !== "object") return {};
  const { fMethod, t1Method, ...rest } = raw;
  const assembled = { ...rest };

  if (raw.fireCase === "OPEN_POOL_LIQUID" || raw.fireCase === "CONFINED_POOL_FUEL_SMALL_MEDIUM") {
    delete assembled.F;
    delete assembled.Tf_degC;
    delete assembled.insulationLayers;
    if (fMethod === "DIRECT") {
      assembled.F = raw.F;
    } else if (fMethod === "INSULATION") {
      assembled.Tf_degC = raw.Tf_degC;
      assembled.insulationLayers = raw.insulationLayers;
    }
  }

  if (raw.fireCase === "OPEN_POOL_GAS_VAPOR") {
    delete assembled.T1_K;
    delete assembled.Pn_MPa;
    delete assembled.Tn_K;
    if (t1Method === "DIRECT") {
      assembled.T1_K = raw.T1_K;
    } else if (t1Method === "PN_TN") {
      assembled.Pn_MPa = raw.Pn_MPa;
      assembled.Tn_K = raw.Tn_K;
    }
  }

  return assembled;
}

function CaseView({ caseData, dischargeSystems, onBack, onSnapshotCreate, onApprovalUpdate }) {
  const equipment = caseData.equipment || null;

  // 매칭 DischargeSystem — connectedTags 또는 명시적 지정
  const dischargeSystem = caseData.dischargeSystemId
    ? (dischargeSystems || []).find(ds => ds.id === caseData.dischargeSystemId) || null
    : equipment
    ? (dischargeSystems || []).find(ds => ds.connectedTags?.includes(equipment.tag)) || null
    : null;

  // Equipment 값으로 inputs 초기화
  const initialInputs = {
    ...R201_DEFAULTS,
    ...(equipment ? {
      P1:   equipment.setPressure,
      mawp: equipment.mawp,
      // PRESSURE-001: overpressure는 Case 입력값이 아니라 Asset(Equipment)
      // 데이터. Equipment에 없으면 계산을 막아야 하므로 여기서 임의
      // 기본값을 몰래 대입하지 않는다 (누락 시 validateInputs에서 거부).
      OP:   equipment.overpressure,
      P2:   dischargeSystem?.headerPressure ?? R201_DEFAULTS.P2,
    } : {}),
  };

  const startScreen = caseData.latestSnap ? "report" : "input";
  const [screen,     setScreen]     = useState(startScreen);
  const [inputs,     setInputs]     = useState(initialInputs);
  const [deviceType, setDeviceType] = useState(
    equipment?.deviceType ?? "safetyValve"
  );
  const [snapshot, setSnapshot] = useState(caseData.latestSnap || null);
  const [approvals, setApprovals] = useState(caseData.approvals || []);

  // ── RELIEF-LOAD-UI-001: §5 시나리오 입력 상태 ──
  // reliefLoadScenarioType === null 이면 "미사용"(기존 Manual W 그대로).
  // reliefLoadScenarioInput은 "현재 선택된 시나리오 하나"만을 위한 원시
  // 입력 객체 — 시나리오를 바꾸면 반드시 빈 객체로 리셋한다(원칙: 이전
  // 시나리오의 입력이 새 시나리오 계산에 암묵적으로 섞이면 안 됨. state
  // collision 방지, RELIEF-LOAD-UI-001의 STATE_COLLISION 계약으로 고정).
  const [reliefLoadScenarioType,  setReliefLoadScenarioType]  = useState(null);
  const [reliefLoadScenarioInput, setReliefLoadScenarioInput] = useState({});

  // ── C-4.12 REV2 — §5.11 액체부피팽창 독립 state ──
  // 위 reliefLoadScenarioType/reliefLoadScenarioInput(배타 선택 governing
  // 시나리오)과 완전히 분리된 별도 state다. §5.11은 governing 후보가 될
  // 수 없으므로(VOLUME_FLOW) 애초에 같은 라디오 그룹에 둘 이유가 없고,
  // Manual W나 다른 §5 시나리오 선택 상태와 무관하게 항상 독립적으로
  // 입력·계산할 수 있어야 한다(요구사항: "§5.11 선택 때문에 Manual W가
  // 사라지는 것/다른 relief scenario state가 깨지는 것 금지").
  const [liquidExpansionInput, setLiquidExpansionInput] = useState({});
  const handleLiquidExpansionFieldChange = (key, val) =>
    setLiquidExpansionInput(p => ({ ...p, [key]: val }));

  // ── C-4.13 — §5.13 열교환기 고장 독립 state (§5.11과 형제) ──
  // 마찬가지로 reliefLoadScenarioType과 완전히 분리되어 있다. §5.11과도
  // 서로 독립이다 — 두 supplementary 블록을 동시에 열고 계산해도 서로의
  // state를 전혀 건드리지 않는다.
  const [exchangerFailureInput, setExchangerFailureInput] = useState({});
  const handleExchangerFailureFieldChange = (key, val) =>
    setExchangerFailureInput(p => ({ ...p, [key]: val }));

  const handleInputChange = (key, val) => setInputs(p => ({ ...p, [key]: val }));

  // 시나리오 전환 — 반드시 입력을 리셋한다(동일 타입 재클릭은 리셋하지
  // 않음: 입력 도중 실수로 같은 버튼을 다시 눌러도 작성 중이던 값이
  // 사라지지 않도록).
  const handleReliefLoadScenarioTypeChange = (type) => {
    if (type === reliefLoadScenarioType) return;
    setReliefLoadScenarioType(type);
    setReliefLoadScenarioInput({});
  };
  const handleReliefLoadScenarioInputChange = (key, val) =>
    setReliefLoadScenarioInput(p => ({ ...p, [key]: val }));

  // ── C-4.10 — §5.12 EXTERNAL_FIRE 전용 state 핸들러 ──
  // 기존 4개 시나리오(§5.1/5.6/5.7/5.8)의 handleReliefLoadScenarioTypeChange/
  // handleReliefLoadScenarioInputChange는 위에서 전혀 수정하지 않았다.
  // 아래는 §5.12의 fireCase 전환/F·T1 방법 전환/단열재 배열에서만 쓰이는
  // 추가 핸들러다.

  // fireCase 전환 — 이전 fireCase 전용 입력을 완전히 제거(state collision 방지,
  // 기존 시나리오 전환 리셋 원칙과 동일). Case M 기본값 프리필(권고안 C안):
  // OPEN_POOL_GAS_VAPOR로 "최초" 진입할 때만 Case의 M을 기본값으로 제시하고
  // scenarioMSource="CASE_DEFAULT"를 남긴다 — 자동 동기화가 아니므로 이후
  // Case M이 바뀌어도 이미 채워진 시나리오 M을 조용히 따라 바꾸지 않는다.
  const handleExternalFireCaseChange = (newFireCase) => {
    setReliefLoadScenarioInput(prev => {
      if (prev.fireCase === newFireCase) return prev;
      const next = { fireCase: newFireCase };
      if (newFireCase === "OPEN_POOL_GAS_VAPOR") {
        next.M = inputs.M;
        next.scenarioMSource = "CASE_DEFAULT";
      }
      return next;
    });
  };

  // 시나리오 M을 사용자가 직접 수정 — 그 즉시 provenance를 SCENARIO_OVERRIDE로 전환.
  const handleExternalFireMChange = (val) =>
    setReliefLoadScenarioInput(prev => ({ ...prev, M: val, scenarioMSource: "SCENARIO_OVERRIDE" }));

  // F 입력 방법(직접값 ↔ 단열재) 전환 — 반대 경로의 입력값을 완전히 제거하고,
  // INSULATION으로 전환 시 최소 1개 층을 기본 제공한다(빈 배열은 READY 불가 원칙).
  const handleExternalFireFMethodChange = (newMethod) => {
    setReliefLoadScenarioInput(prev => {
      if (prev.fMethod === newMethod) return prev;
      const { F, Tf_degC, insulationLayers, ...rest } = prev;
      return {
        ...rest, fMethod: newMethod,
        ...(newMethod === "INSULATION"
          ? { insulationLayers: [{ k_kcal_mm_per_hr_m2_degC: undefined, thickness_mm: undefined }] }
          : {}),
      };
    });
  };

  // T1 입력 방법(직접값 ↔ Pn/Tn) 전환 — 반대 경로의 입력값을 완전히 제거.
  const handleExternalFireT1MethodChange = (newMethod) => {
    setReliefLoadScenarioInput(prev => {
      if (prev.t1Method === newMethod) return prev;
      const { T1_K, Pn_MPa, Tn_K, ...rest } = prev;
      return { ...rest, t1Method: newMethod };
    });
  };

  // 단열재 층 Add/Remove/필드수정 — 마지막 1개 층은 삭제할 수 없다(임의 상한 없음).
  const handleExternalFireInsulationLayerAdd = () =>
    setReliefLoadScenarioInput(prev => ({
      ...prev,
      insulationLayers: [...(prev.insulationLayers || []), { k_kcal_mm_per_hr_m2_degC: undefined, thickness_mm: undefined }],
    }));
  const handleExternalFireInsulationLayerRemove = (idx) =>
    setReliefLoadScenarioInput(prev => {
      const layers = prev.insulationLayers || [];
      if (layers.length <= 1) return prev;
      return { ...prev, insulationLayers: layers.filter((_, i) => i !== idx) };
    });
  const handleExternalFireInsulationLayerFieldChange = (idx, key, val) =>
    setReliefLoadScenarioInput(prev => {
      const layers = [...(prev.insulationLayers || [])];
      layers[idx] = { ...layers[idx], [key]: val };
      return { ...prev, insulationLayers: layers };
    });

  // C-4.10: EXTERNAL_FIRE는 계산 호출 직전에 UI 전용 판별자(fMethod/t1Method)를
  // 제거하고 선택된 경로의 필드만 남긴 입력을 조립한다(relief_load.js 무수정).
  // 기존 4개 시나리오는 reliefLoadScenarioInput을 그대로 사용해 동작이 동일하다.
  const reliefLoadCalcInput = reliefLoadScenarioType === "EXTERNAL_FIRE"
    ? buildExternalFireScenarioInput(reliefLoadScenarioInput)
    : reliefLoadScenarioInput;

  // ── §5 scenario → selector → adapter 체인 (파생값, 매 렌더 재계산) ──
  // 이 세 함수(calculate*Scenario/selectGoverningReliefLoad/
  // buildReliefSizingInput)는 relief_load.js의 순수 함수다. api520Engine
  // (실제 sizing 계산)은 여기서 절대 호출하지 않는다 — Engine은
  // handleCalculate()에서 딱 한 번만 실행된다(Engine 이중 실행 금지).
  // 이미 CaseView가 매 렌더 computeWorkflowState()(engine 함수)를
  // 호출하는 기존 패턴과 동일한 층위의 파생 계산이다.
  const reliefLoadScenarioResult = reliefLoadScenarioType
    ? RELIEF_LOAD_SCENARIO_META[reliefLoadScenarioType].calc(reliefLoadCalcInput)
    : null;
  const reliefLoadSelectorResult = reliefLoadScenarioResult
    ? selectGoverningReliefLoad([reliefLoadScenarioResult])
    : null;
  const reliefLoadAdapter = reliefLoadSelectorResult
    ? buildReliefSizingInput(reliefLoadSelectorResult)
    : null;

  // 실제 sizing에 쓰일 값이 무엇인지 — Engine의 wSource 결정 로직과
  // 정확히 동일한 조건(reliefLoadAdapter.valid)을 그대로 반영한 표시용
  // 파생값. 새로운 판단을 추가하는 게 아니라 Engine이 내릴 판단을
  // 미리 보여주는 것뿐이다(계산/판정 아님).
  const reliefLoadActive = reliefLoadScenarioType !== null;
  const effectiveWSource = (reliefLoadActive && reliefLoadAdapter?.valid) ? "GOVERNING_RELIEF_LOAD" : "MANUAL_INPUT";
  const effectiveW = effectiveWSource === "GOVERNING_RELIEF_LOAD" ? reliefLoadAdapter.W : inputs.W;

  // ── C-4.12 REV2 — §5.11 계산 (governing 체인과 완전히 분리) ──
  // reliefLoadScenarioType/reliefLoadSelectorResult/reliefLoadAdapter
  // 어디에도 §5.11이 관여하지 않는다. Engine 함수를 UI에서 직접,
  // 무조건(입력이 비어 있어도 INSUFFICIENT_INPUT을 그대로 받기 위해)
  // 호출한다 — UI에서 계산식을 재구현하지 않는다는 원칙 그대로.
  const liquidExpansionResult = calculateLiquidThermalExpansionScenario(liquidExpansionInput);

  // ── C-4.13 — §5.13 계산 (§5.11과 마찬가지로 governing 체인과 완전히
  // 분리, Engine 직접 호출) ──
  const exchangerFailureResult = calculateExchangerFailureScenario(exchangerFailureInput);

  // ── C-4.12 REV2 — MASS_FLOW 계열 판별 ──
  // classifyReliefLoadQuantity/RELIEF_LOAD_QUANTITY는 relief_load.js
  // (Engine)의 기존 순수 함수/상수를 그대로 참조만 한다. RELIEF_LOAD_
  // SCENARIO_META에는 이제 MASS_FLOW 계열(§5.1/5.6/5.7/5.8/5.12)만
  // 존재하므로 이 분기는 사실상 항상 참이지만, 향후 실수로 non-MASS_FLOW
  // 시나리오가 이 메타에 다시 섞여 들어가더라도 "계산 실패"와 "애초에
  // governing 후보가 아님"을 혼동하지 않도록 판별 로직 자체는 그대로
  // 유지한다(불필요한 재설계 금지 원칙).
  const reliefLoadQuantity = reliefLoadScenarioResult
    ? classifyReliefLoadQuantity(reliefLoadScenarioResult.unit) : null;
  const reliefLoadIsMassFlowCandidate = reliefLoadQuantity === RELIEF_LOAD_QUANTITY.MASS_FLOW;
  const reliefLoadScenarioComputed = !!reliefLoadScenarioResult &&
    (reliefLoadScenarioResult.status === "OK" || reliefLoadScenarioResult.status === "COMPUTABLE");
  const reliefLoadBlocking = reliefLoadActive && (
    reliefLoadIsMassFlowCandidate ? !reliefLoadAdapter?.valid : !reliefLoadScenarioComputed
  );

  const handleCalculate = () => {
    // 시나리오가 활성화됐는데 차단 상태면 즉시 중단 — manual W로 조용히
    // 대체하지 않는다(자동 fallback 금지 원칙). 이 가드는 InputView의
    // blockReason과 동일한 조건이라 정상 흐름에서는 버튼 자체가
    // 비활성화되어 여기 도달하지 않지만, 방어적으로 다시 확인.
    // reliefLoadIsMassFlowCandidate가 false인 경우(§5.11 등)는 계산이
    // 성공한 상태이므로 여기서 막히지 않고 그대로 진행한다 — Manual W가
    // 계속 실제 sizing에 쓰이는 정상 흐름이다(governing 후보가 아닐 뿐
    // 계산 실패가 아님).
    if (reliefLoadBlocking) {
      const friendlyReason = !reliefLoadIsMassFlowCandidate
        ? "필요한 입력값을 모두 채워주세요."
        : (reliefLoadAdapter?.reason === "NO_GOVERNING_SCENARIO" ? "필요한 입력값을 모두 채워주세요." : (reliefLoadAdapter?.reason || "INSUFFICIENT_INPUT"));
      alert(`Relief Load 시나리오 입력이 완료되지 않았습니다 — ${friendlyReason}`);
      return;
    }
    const adapterForEngine = (reliefLoadActive && reliefLoadIsMassFlowCandidate) ? reliefLoadAdapter : undefined;
    const engineResult = api520Engine(inputs, deviceType, equipment?.inletPiping || null, adapterForEngine);
    if (!engineResult.valid) {
      alert(`입력 오류: ${engineResult.error.field} — ${engineResult.error.reason}`);
      return;
    }
    // RELIEF-LOAD-UI-001 확장: governing scenario가 활성화되어 있으면
    // Snapshot에 reliefLoad.governing을 싣는다. 미사용 Case는 이 키
    // 자체를 아예 넘기지 않아(undefined) 기존 hash/스키마와 100% 동일하게
    // 유지한다(createSnapshot의 하위호환 계약, RELIEF-SIZING-ADAPTER-001
    // 참고). 이 분기는 §5.11 도입 이전과 단 한 글자도 다르지 않다.
    const reliefLoadForSnapshot = !reliefLoadActive ? undefined
      : reliefLoadIsMassFlowCandidate
        ? (reliefLoadAdapter.valid ? {
            scenarios: reliefLoadSelectorResult.allScenarios,
            governing: reliefLoadSelectorResult.governingScenarioId,
            quantity: "MASS_FLOW",
            unit: "kg/h",
            provenance: reliefLoadAdapter.provenance,
          } : undefined)
        // RELIEF_LOAD_SCENARIO_META에는 이제 MASS_FLOW 계열만 존재하므로
        // 이 분기는 도달 불가능하다 — 향후 실수로 non-MASS_FLOW 시나리오가
        // 다시 섞여도 조용히 통과시키지 않도록 방어적으로 undefined 유지.
        : undefined;

    // ── C-4.12 REV2 / C-4.13 — supplementary 결과들 ──
    // liquidExpansionInput/Result, exchangerFailureInput/Result 모두
    // reliefLoadScenarioType과 완전히 독립이므로, governing 시나리오
    // 선택 여부와 무관하게 계산이 성공했으면(COMPUTABLE) 항상 Snapshot에
    // 보존한다. 이 값들은 절대 governing에 들어가지 않는다 — 아래
    // 병합에서도 governing 필드는 reliefLoadForSnapshot 쪽에서만
    // 채워진다. 각 항목은 자기 identity(scenario/section)를 명확히
    // 갖는다.
    const liquidExpansionSupplementary = (liquidExpansionResult.status === "COMPUTABLE") ? {
      scenario: "LIQUID_THERMAL_EXPANSION",
      section: "§5.11",
      status: liquidExpansionResult.status,
      value: liquidExpansionResult.value,
      unit: liquidExpansionResult.unit,
      formula: liquidExpansionResult.formula,
      inputs: liquidExpansionResult.inputs,
      upstreamReference: liquidExpansionResult.upstreamReference,
    } : null;

    // C-4.13 — §5.13 결과 필드는 requiredOrificeArea_m2다(§5.11의
    // value와 다른 이름) — Engine이 실제로 부여한 필드명을 그대로
    // 옮겨 담을 뿐, "value"라는 의미가 다른 이름으로 억지로 바꾸지
    // 않는다. COMPUTABLE일 때만 보존한다(NOT_APPLICABLE/NEEDS_
    // ENGINEERING_DECISION/INSUFFICIENT_INPUT은 산정된 면적값 자체가
    // 없으므로 supplementary에 넣지 않는다 — 화면에는 별도로 표시되지만
    // Snapshot 감사 기록은 "실제로 산정된 값"만 남긴다).
    const exchangerFailureSupplementary = (exchangerFailureResult.status === "COMPUTABLE") ? {
      scenario: "EXCHANGER_FAILURE",
      section: "§5.13",
      status: exchangerFailureResult.status,
      requiredOrificeArea_m2: exchangerFailureResult.requiredOrificeArea_m2,
      unit: exchangerFailureResult.unit,
      formula: exchangerFailureResult.formula,
      inputs: exchangerFailureResult.inputs,
      source: exchangerFailureResult.source,
    } : null;

    // 여러 supplementary 결과를 배열로 합친다 — null/undefined는
    // 안전하게 걸러내고, 예상 못한 객체가 배열에 섞여 들어가지 않도록
    // 위에서 만든 두 값만 명시적으로 나열한다(향후 §5.x가 추가되면
    // 이 배열에 한 줄만 추가하면 된다).
    const supplementaryList = [liquidExpansionSupplementary, exchangerFailureSupplementary].filter(Boolean);

    // governing(위)과 supplementary(§5.11/§5.13)를 하나의 reliefLoad
    // 객체로 병합한다. 둘 다 전혀 쓰지 않는 기존 Case는 이 병합을
    // 거쳐도 reliefLoadForSnapshot과 완전히 동일한 결과가 나온다
    // (하위호환 — supplementary 키 자체가 생기지 않음). supplementary만
    // 쓰고 governing 시나리오는 비활성인 Case는 governing:null과
    // supplementary만 남는다.
    const reliefLoadMerged = (!reliefLoadForSnapshot && supplementaryList.length === 0) ? undefined : {
      ...(reliefLoadForSnapshot || { governing: null }),
      ...(supplementaryList.length > 0 ? { supplementary: supplementaryList } : {}),
    };
    // Engine이 workflow 결정 — timestamp는 UI에서 주입 (Engine 순수성 유지)
    const wfDec = computeWorkflowState(null, equipment, dischargeSystem);
    const snap = createSnapshot({
      caseId:           caseData.id,
      valveTag:         caseData.valveTag,
      deviceType,
      inputs,
      engineResult,
      equipment,
      dischargeSystem,
      workflowDecision: { ...wfDec, state: "INSPECTION" },
      reliefLoad:       reliefLoadMerged,
    });
    setSnapshot(snap);
    onSnapshotCreate(caseData.id, snap);
    setScreen("report");
  };

  // workflow 변경 = 새 Snapshot 생성 (patch 금지)
  // snapshotHash가 workflow를 포함해 계산되므로, workflow가 바뀌면
  // 반드시 새로운 identity(새 hash)를 가진 Snapshot이어야 한다.
  // inputs/engineResult는 재사용 — Engine을 다시 돌리는 게 아니라
  // "동일 계산 결과 + 새 workflow 결정"을 새 버전으로 기록하는 것.
  //
  // build/commit을 분리한 이유(중요): Approval은 "지금 보고 있는(REVIEW) 버전"이
  // 아니라 "승인 결과로 확정될 다음 버전(APPROVED/ACTION_REQUIRED)"의 hash에
  // 서명해야 한다. 순서를 반대로 하면(서명 먼저 → 전이 나중) 서명 직후
  // Snapshot이 교체되면서 approval.snapshotHash가 가리키는 버전이 case에서
  // 사라져 "승인은 됐는데 최종 상태에는 승인 기록이 없는" 상태가 된다.
  const _buildAdvancedSnapshot = (nextState, comment) => {
    const wfDec = computeWorkflowState(snapshot, equipment, dischargeSystem);
    // RELIEF-LOAD-UI-001 hash 정규화: snapshot.reliefLoad는 createSnapshot이
    // 항상 null(미사용) 또는 실제 객체로 반환한다(원본 undefined 여부는
    // 이 시점엔 이미 사라짐). 여기서 그대로 null을 다시 넘기면
    // _hashResult가 "reliefLoad:null"을 해시에 새로 포함시켜, 애초에
    // reliefLoad를 전혀 쓴 적 없는 Case인데도 workflow 전이 시점부터
    // hash가 달라지는 회귀가 생긴다 — null은 undefined로 되돌려
    // "reliefLoad를 실제로 쓴 적 있는 Case만" 해시에 포함되게 한다.
    const reliefLoadForAdvance = snapshot.reliefLoad === null ? undefined : snapshot.reliefLoad;
    const newSnap = createSnapshot({
      caseId:           caseData.id,
      valveTag:         caseData.valveTag,
      deviceType,
      inputs:           snapshot.inputs,
      engineResult:     snapshot.result,
      equipment,
      dischargeSystem,
      workflowDecision: { ...wfDec, state: nextState },
      reliefLoad:       reliefLoadForAdvance,
    });
    // lastComment는 hash 계산 대상 아님 (승인/반려 사유 메모, 결정 내용 아님)
    return comment ? Object.freeze({ ...newSnap, lastComment: comment }) : newSnap;
  };

  const _commitSnapshot = (snap) => {
    setSnapshot(snap);
    onSnapshotCreate(caseData.id, snap);
  };

  const handleWorkflowAdvance = (nextState, comment) => {
    _commitSnapshot(_buildAdvancedSnapshot(nextState, comment));
  };

  // ApprovalForm → 여기 하나만 거쳐서 처리한다.
  // 1) "승인 후 확정될 다음 버전(Snapshot)"을 먼저 만든다 (아직 커밋 안 함)
  // 2) 그 Snapshot의 hash에 서명한다 (submitApproval)
  // 3) 서명 성공한 경우에만 그 Snapshot을 실제로 커밋한다
  //    → case의 "현재/최종" Snapshot이 항상 서명 대상과 정확히 일치한다.
  const handleApprovalSubmit = async ({ decision, comment, signer, role }) => {
    if (!snapshot || snapshot.workflow !== "REVIEW") {
      alert("승인 대기(REVIEW) 상태에서만 서명할 수 있습니다.");
      return { ok: false, reason: "not in REVIEW state" };
    }
    const nextState = decision === "approve" ? "APPROVED" : "ACTION_REQUIRED";
    const nextSnap  = _buildAdvancedSnapshot(nextState, comment);

    const result = await submitApproval(
      { snapshot: nextSnap, decision, comment, signer, role },
      approvals
    );
    if (!result.ok) {
      alert(`승인 처리 실패 [${result.contract}]: ${result.reason}`);
      return result;
    }
    setApprovals(result.history);
    onApprovalUpdate(caseData.id, result.history);
    _commitSnapshot(nextSnap);
    return result;
  };

  const wfColor = WF_COLOR[snapshot?.workflow ?? caseData.workflow];
  const wfLabel = WF_LABEL[snapshot?.workflow ?? caseData.workflow];

  // Engine이 결정한 workflow 상태 — UI는 읽기만 함
  const wfDecision = computeWorkflowState(snapshot, equipment, dischargeSystem);

  // MOC 결과는 wfDecision.reasons에서 추출 (Engine 결과 projection)
  const mocResult = {
    changed: wfDecision.reasons.length > 0,
    diffs:   wfDecision.reasons,  // { field, from, to, unit, type }
  };

  // Snapshot workflow와 Engine 결정값이 다르면 Snapshot 갱신
  // (Engine이 상태를 결정하면 Snapshot이 그것을 반영 — UI는 트리거만)
  useEffect(() => {
    if (!snapshot) return;
    if (wfDecision.state === snapshot.workflow) return;
    const locked = ["APPROVED","CLOSED"];
    if (locked.includes(snapshot.workflow)) return;
    handleWorkflowAdvance(
      wfDecision.state,
      wfDecision.reasons.map(r=>`${r.type}: ${r.field} ${r.from}→${r.to}`).join(", ")
    );
  }, [wfDecision.state]);

  const tabs = [
    { id:"info",   label:"정보" },
    { id:"input",  label:"사양 결정" },
    ...(snapshot ? [{ id:"report", label:"검토 결과" }] : []),
  ];

  return (
    <div>
      {/* 헤더 */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
        <button onClick={onBack}
          style={{padding:"8px 12px",background:T.bg,border:`1px solid ${T.border}`,
            borderRadius:9,fontSize:13,fontWeight:700,color:T.sub,
            fontFamily:font.mono,cursor:"pointer",flexShrink:0}}>←</button>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:17,fontWeight:900,color:T.navy,
            fontFamily:font.mono,overflow:"hidden",
            textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
            {caseData.valveTag}
          </div>
          <div style={{fontSize:10,color:T.sub,fontFamily:font.mono}}>
            {equipment?.location || caseData.location || ""}
            {dischargeSystem ? ` → ${dischargeSystem.name}` : ""}
          </div>
        </div>
        <div style={{padding:"5px 11px",borderRadius:20,
          background:wfColor+"18",border:`1.5px solid ${wfColor}`,
          fontSize:10,fontWeight:700,color:wfColor,fontFamily:font.mono,flexShrink:0}}>
          {wfLabel}
        </div>
      </div>

      {/* 탭 */}
      <div style={{display:"flex",gap:6,marginBottom:14,
        borderBottom:`1px solid ${T.border}`,paddingBottom:10}}>
        {tabs.map(({id,label})=>(
          <button key={id} onClick={()=>setScreen(id)}
            style={{padding:"8px 16px",border:"none",borderRadius:9,cursor:"pointer",
              fontSize:12,fontWeight:700,fontFamily:font.mono,
              background:screen===id?T.navyLight:T.bg,
              color:screen===id?T.white:T.sub,
              boxShadow:screen===id?`0 3px 0 ${T.navy}`:"0 2px 0 #ccc"}}>
            {label}
            {id==="report" && snapshot && (
              <span style={{marginLeft:4,fontSize:9,
                color:screen===id?"#AED6F1":
                  Object.values(snapshot.result?.checklist||{}).every(Boolean)
                  ?T.green:T.red}}>●</span>
            )}
          </button>
        ))}
      </div>

      {/* MOC 감지 배너 */}
      {mocResult.changed && (
        <div style={{background:"#FFF8E1",border:`2px solid ${T.orange}`,
          borderRadius:12,padding:"12px 14px",marginBottom:12}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
            <span style={{fontSize:18}}>⚠</span>
            <div>
              <div style={{fontSize:12,fontWeight:900,color:"#7A4F00",fontFamily:font.sans}}>
                설비가 변경되었습니다 — 재검토 필요
              </div>
              <div style={{fontSize:10,color:"#7A4F00",fontFamily:font.sans,marginTop:1}}>
                이 검토는 아래 조건으로 수행됐습니다. 현재 설비 조건과 다릅니다.
              </div>
            </div>
          </div>

          {/* Revision 비교 */}
          <div style={{display:"flex",gap:8,marginBottom:8}}>
            {[
              ["Equipment",
               snapshot?.assetRefs?.equipmentRevision,
               equipment?.revision,
               equipment?.mocId],
              ["Discharge Sys.",
               snapshot?.assetRefs?.dischargeRevision,
               dischargeSystem?.revision,
               dischargeSystem?.mocId],
            ].filter(([,sv]) => sv != null).map(([label, snapRev, curRev, mocId]) => (
              <div key={label} style={{flex:1,background:"#FFFDE7",borderRadius:9,
                padding:"8px 10px",border:`1px solid #FFD54F`}}>
                <div style={{fontSize:9,color:T.sub,fontFamily:font.mono,marginBottom:3}}>{label}</div>
                <div style={{fontSize:12,fontFamily:font.mono,color:"#7A4F00"}}>
                  Rev.{snapRev}
                  {snapRev !== curRev && (
                    <span style={{color:T.green,fontWeight:700}}> → Rev.{curRev}</span>
                  )}
                </div>
                {mocId && (
                  <div style={{fontSize:9,color:T.blue,fontFamily:font.mono,marginTop:2}}>
                    {mocId}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* 변경 필드 목록 */}
          {mocResult.diffs.map((d,i) => (
            <div key={i} style={{display:"flex",alignItems:"center",gap:8,
              padding:"4px 0",borderTop:`1px solid #FFD54F`,
              fontSize:11,fontFamily:font.mono}}>
              <span style={{color:T.sub,minWidth:110}}>{d.field}</span>
              <span style={{color:T.red,textDecoration:"line-through"}}>
                {d.from}{d.unit}
              </span>
              <span style={{color:T.sub}}>→</span>
              <span style={{color:T.green,fontWeight:700}}>
                {d.to}{d.unit}
              </span>
            </div>
          ))}

          <button onClick={()=>setScreen("input")}
            style={{marginTop:10,width:"100%",padding:"10px",
              background:T.orange,color:T.white,border:"none",borderRadius:9,
              fontSize:12,fontWeight:700,fontFamily:font.sans,cursor:"pointer",
              boxShadow:`0 3px 0 #CC7000`}}>
            변경된 조건으로 재검토 →
          </button>
        </div>
      )}

      {/* 정보 탭 */}
      {screen === "info" && (
        <div>
          {/* Equipment */}
          {equipment && (
            <div style={{background:T.cardBg,borderRadius:14,padding:14,
              marginBottom:10,border:`1px solid ${T.border}`}}>
              <div style={{fontSize:10,fontWeight:700,color:T.sub,
                fontFamily:font.mono,marginBottom:8,letterSpacing:1}}>EQUIPMENT</div>
              {[
                ["Tag", equipment.tag],
                ["위치", equipment.location],
                ["제조사/모델", `${equipment.manufacturer} ${equipment.model}`.trim()||"-"],
                ["MAWP / SET", `${equipment.mawp} / ${equipment.setPressure} barg`],
                ["오리피스", equipment.orifice||"-"],
                ["IN / OUT", `${equipment.inletSize} / ${equipment.outletSize}`],
              ].map(([k,v])=>(
                <div key={k} style={{display:"flex",justifyContent:"space-between",
                  padding:"6px 0",borderBottom:`1px solid ${T.border}`,fontSize:12}}>
                  <span style={{color:T.sub,fontFamily:font.mono}}>{k}</span>
                  <span style={{color:T.text,fontWeight:700,fontFamily:font.mono}}>{v}</span>
                </div>
              ))}
            </div>
          )}
          {/* DischargeSystem */}
          {dischargeSystem && (
            <div style={{background:T.cardBg,borderRadius:14,padding:14,
              marginBottom:10,border:`1px solid ${T.border}`}}>
              <div style={{fontSize:10,fontWeight:700,color:T.sub,
                fontFamily:font.mono,marginBottom:8,letterSpacing:1}}>DISCHARGE SYSTEM</div>
              {[
                ["계통명", dischargeSystem.name],
                ["배출 목적지", DESTINATION_LABEL[dischargeSystem.destination]],
                ["L / D", `${dischargeSystem.L}m / Ø${Math.round(dischargeSystem.D*1000)}mm`],
                ["Fittings ΣK", dischargeSystem.fittingsK],
                ["Header 압력", `${dischargeSystem.headerPressure} barg`],
              ].map(([k,v])=>(
                <div key={k} style={{display:"flex",justifyContent:"space-between",
                  padding:"6px 0",borderBottom:`1px solid ${T.border}`,fontSize:12}}>
                  <span style={{color:T.sub,fontFamily:font.mono}}>{k}</span>
                  <span style={{color:T.text,fontWeight:700,fontFamily:font.mono}}>{v}</span>
                </div>
              ))}
            </div>
          )}
          <button onClick={()=>setScreen("input")}
            style={{width:"100%",padding:"14px",background:T.navyLight,color:T.white,
              border:"none",borderRadius:14,fontSize:14,fontWeight:900,
              fontFamily:font.sans,cursor:"pointer",boxShadow:`0 5px 0 ${T.navy}`}}>
            {snapshot?"사양 재결정 →":"사양 결정 시작 →"}
          </button>
        </div>
      )}

      {screen === "input" && (
        <InputView inputs={inputs} deviceType={deviceType}
          dischargeSystem={dischargeSystem} equipment={equipment}
          onChange={handleInputChange} onDeviceChange={setDeviceType}
          onSubmit={handleCalculate}
          reliefLoadScenarioType={reliefLoadScenarioType}
          reliefLoadScenarioInput={reliefLoadScenarioInput}
          reliefLoadScenarioResult={reliefLoadScenarioResult}
          reliefLoadAdapter={reliefLoadAdapter}
          reliefLoadBlocking={reliefLoadBlocking}
          effectiveW={effectiveW}
          effectiveWSource={effectiveWSource}
          onReliefLoadScenarioTypeChange={handleReliefLoadScenarioTypeChange}
          onReliefLoadScenarioInputChange={handleReliefLoadScenarioInputChange}
          onExternalFireCaseChange={handleExternalFireCaseChange}
          onExternalFireMChange={handleExternalFireMChange}
          onExternalFireFMethodChange={handleExternalFireFMethodChange}
          onExternalFireT1MethodChange={handleExternalFireT1MethodChange}
          onExternalFireInsulationLayerAdd={handleExternalFireInsulationLayerAdd}
          onExternalFireInsulationLayerRemove={handleExternalFireInsulationLayerRemove}
          onExternalFireInsulationLayerFieldChange={handleExternalFireInsulationLayerFieldChange}
          liquidExpansionInput={liquidExpansionInput}
          liquidExpansionResult={liquidExpansionResult}
          onLiquidExpansionFieldChange={handleLiquidExpansionFieldChange}
          exchangerFailureInput={exchangerFailureInput}
          exchangerFailureResult={exchangerFailureResult}
          onExchangerFailureFieldChange={handleExchangerFailureFieldChange}
        />
      )}

      {screen === "report" && snapshot && (
        <ReportView snap={snapshot} approvals={approvals}
                    caseSnapshotHistory={caseData.snapshotHistory}
                    onWorkflowAdvance={handleWorkflowAdvance}
                    onApprovalSubmit={handleApprovalSubmit}/>
      )}

      {screen === "report" && !snapshot && (
        <div style={{textAlign:"center",padding:"40px 20px",color:T.sub}}>
          <div style={{fontSize:32,marginBottom:12}}>📋</div>
          <div style={{fontSize:14,fontWeight:700,color:T.navy,marginBottom:8}}>
            아직 계산 결과가 없습니다
          </div>
          <button onClick={()=>setScreen("input")}
            style={{padding:"12px 24px",background:T.navyLight,color:T.white,
              border:"none",borderRadius:11,fontSize:13,fontWeight:700,
              fontFamily:font.sans,cursor:"pointer"}}>
            사양 결정 시작 →
          </button>
        </div>
      )}
    </div>
  );
}
