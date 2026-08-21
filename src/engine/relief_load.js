// ════════════════════════════════════════════════════════════════
//  RELIEF LOAD ENGINE (pure, stateless) — C-4.0: 계약/데이터모델
//  KOSHA GUIDE D-18-2020 §5(소요분출량) / §6(안전밸브 선정) 대응.
// ════════════════════════════════════════════════════════════════
// RELIEF_LOAD_CONTRACT_VERSION 1.0.0 — SCENARIO-TAXONOMY-001
//   §5 원문 14개 절 전체를 대조한 결과, 정형화된 계산식이 있는 7개
//   절만 COMPUTABLE로 분류했다. 나머지는 원문 자체가 "인정된 방법
//   없음"/"압력방출장치 보호대상 아님"/"정성적 분석 영역" 등으로
//   계산 대상에서 제외한 것 — 이 앱이 임의로 축소한 것이 아니라
//   원문이 그은 경계를 그대로 데이터 모델에 반영한다.
//   이 파일은 taxonomy와 §6(governing load 선택) 순수 함수만
//   담는다. 개별 시나리오 계산식(calculateReliefLoadScenario)은
//   C-4.1~C-4.7에서 시나리오별로 하나씩 추가되며, api520Engine과의
//   실제 연결(sizing이 governing W를 사용하는 것)은 C-4.8에서
//   이루어진다 — 이 시점에는 아직 어디에서도 호출되지 않는다.
const RELIEF_LOAD_CONTRACT_VERSION = "1.0.0";

// 시나리오 상태 — "원문에 계산식이 없는 시나리오를 억지로 계산하지
// 않는다"는 원칙에 따라 NEEDS_ENGINEERING_DECISION과 OUT_OF_SCOPE를
// 데이터 모델 레벨에서 명확히 구분한다.
const RELIEF_LOAD_STATUS = Object.freeze({
  COMPUTABLE: "COMPUTABLE",                                   // 원문에 정형화된 계산식 있음 — Engine이 계산
  NEEDS_ENGINEERING_DECISION: "NEEDS_ENGINEERING_DECISION",   // 원문에 부분적 지침만 있음 — 계산식 확정 전
  OUT_OF_SCOPE: "OUT_OF_SCOPE",                                // 원문 자체가 계산 대상에서 제외
  DEPENDENT: "DEPENDENT",                                      // 다른 절에 종속 — 독립 시나리오 아님
});

// §5 시나리오 taxonomy — KOSHA GUIDE D-18-2020 §5, <표2> 전체 대조 결과.
// status가 COMPUTABLE인 7개 항목만 C-4.1~C-4.7에서 계산 함수를 갖는다.
const RELIEF_LOAD_SCENARIO_TAXONOMY = Object.freeze([
  { id:"OUTLET_BLOCKED",      section:"§5.1",  title:"출구 차단",
    status: RELIEF_LOAD_STATUS.COMPUTABLE,
    note:"액체=최대유입량, 증기=최대유입량+생성량" },
  { id:"COOLING_LOSS",        section:"§5.2",  title:"냉각/환류 중단",
    status: RELIEF_LOAD_STATUS.NEEDS_ENGINEERING_DECISION,
    note:"물질·에너지 수지 기반 — 정형식 없음, 케이스별 판단 필요" },
  { id:"ABSORBENT_LOSS",      section:"§5.3",  title:"흡수제 공급 중단",
    status: RELIEF_LOAD_STATUS.OUT_OF_SCOPE,
    note:"원문: 통상 불필요, 특수 case만 후단설비 특성에 의존" },
  { id:"NONCONDENSABLE_GAS",  section:"§5.4",  title:"비응축성 가스 축적",
    status: RELIEF_LOAD_STATUS.DEPENDENT, dependsOn:["COOLING_LOSS","OUTLET_BLOCKED"],
    note:"원문: §5.1 또는 §5.2 준용 — 독립 시나리오 아님" },
  { id:"VOLATILE_INGRESS",    section:"§5.5",  title:"휘발성 물질 유입",
    status: RELIEF_LOAD_STATUS.OUT_OF_SCOPE,
    note:"원문: 인정된 계산방법 없음 — 관리대책이 원문 결론" },
  { id:"OVERFILLING",         section:"§5.6",  title:"과충전",
    status: RELIEF_LOAD_STATUS.COMPUTABLE,
    note:"최대 유입량 — §5.1과 사실상 동형 계산" },
  { id:"CONTROL_VALVE_FAIL",  section:"§5.7",  title:"자동제어밸브 고장",
    status: RELIEF_LOAD_STATUS.COMPUTABLE,
    note:"인입/출구/Fail-stationary 3분기, 최대유입-정상유출" },
  { id:"ABNORMAL_HEAT_VAPOR", section:"§5.8",  title:"비정상 열/증기 유입",
    status: RELIEF_LOAD_STATUS.COMPUTABLE,
    note:"증기발생량-정상유출량, 열입력 125% 등" },
  { id:"INTERNAL_EXPLOSION",  section:"§5.9",  title:"내부폭발/과도압력",
    status: RELIEF_LOAD_STATUS.OUT_OF_SCOPE,
    note:"원문: 압력방출장치로 보호 불가 — 계산 대상 아님" },
  { id:"RUNAWAY_REACTION",    section:"§5.10", title:"화학반응(폭주반응)",
    status: RELIEF_LOAD_STATUS.NEEDS_ENGINEERING_DECISION,
    note:"벤치시험 데이터 필요 — 원문 자체가 정형식 미제시" },
  { id:"LIQUID_EXPANSION",    section:"§5.11", title:"액체부피팽창",
    status: RELIEF_LOAD_STATUS.COMPUTABLE,
    note:"식(1): V=αQ/(500·SG·Cp) 형태 — D-13 열팽창밸브 지침과 중복여부 C-4.5에서 확인" },
  { id:"EXTERNAL_FIRE",       section:"§5.12", title:"외부화재",
    status: RELIEF_LOAD_STATUS.COMPUTABLE,
    note:"식(2)~(7), 환경인자 F(표3), Aw 계산 포함 — 가장 복잡, C-4.7에서 마지막 구현" },
  { id:"EXCHANGER_FAIL",      section:"§5.13", title:"열교환기(튜브) 고장",
    status: RELIEF_LOAD_STATUS.COMPUTABLE,
    note:"튜브 2배 단면적 등 정형화된 오리피스 근사" },
  { id:"UTILITY_FAIL",        section:"§5.14", title:"유틸리티 고장",
    status: RELIEF_LOAD_STATUS.OUT_OF_SCOPE,
    note:"원문: 피해범위·고장수준 분석 필요 — 정성적 판단 영역" },
  { id:"FIRE_WETTED_AREA",    section:"§5.15", title:"화재시 영향범위(Aw)",
    status: RELIEF_LOAD_STATUS.DEPENDENT, dependsOn:["EXTERNAL_FIRE"],
    note:"원문: Aw 계산규칙(7.5m, 구형용기 예외) — §5.12의 계산요소" },
]);

const RELIEF_LOAD_TAXONOMY_SOURCE = "KOSHA GUIDE D-18-2020 §5(소요분출량), <표2>";

// COMPUTABLE 시나리오 id만 추림 — §6 governing load 후보 목록.
function getComputableScenarioIds() {
  return RELIEF_LOAD_SCENARIO_TAXONOMY
    .filter(s => s.status === RELIEF_LOAD_STATUS.COMPUTABLE)
    .map(s => s.id);
}

// ── §6: 여러 시나리오의 소요분출량 W 중 최댓값을 배출용량으로 선정 ──
// 원문: 배출용량은 §5에서 산출한 시나리오별 소요분출량 중 가장 큰
// 값으로 한다. 이 함수는 순수 함수이며 시나리오 계산 로직과 섞이지
// 않는다(calculateReliefLoadScenario는 C-4.1~C-4.7에서 개별 구현).
//
// scenarioResults 배열의 각 원소는 다음 계약(shape)을 따른다:
//   {
//     scenarioId: string,                              // taxonomy id
//     status: "OK" | "NOT_APPLICABLE" | "INSUFFICIENT_INPUT",
//     W: number|null,                                   // kg/h, status "OK"일 때만 유효
//     unit: "kg/h",
//     inputs: object,                                   // 계산에 쓰인 입력값 원본(재현성)
//     formula: string,                                  // 계산식 설명(감사 근거)
//     source: string,                                   // KOSHA 조항 출처
//   }
// 반환값은 governing 시나리오만 남기지 않고 전체 시나리오 결과를
// allScenarios로 그대로 보존한다 — 개별 W가 사라지면 안 된다는
// 원칙(Snapshot이 이 배열 전체를 그대로 저장할 것을 전제로 한다).
function selectGoverningReliefLoad(scenarioResults) {
  const results = Array.isArray(scenarioResults) ? scenarioResults : [];
  const valid = results.filter(r =>
    r && r.status === "OK" && typeof r.W === "number" && isFinite(r.W) && r.W > 0);

  if (valid.length === 0) {
    return {
      verdict: "INSUFFICIENT_INPUT",
      governingScenarioId: null,
      governingW: null,
      unit: "kg/h",
      allScenarios: results,
    };
  }

  // 동점(tie)일 경우 taxonomy 선언 순서상 먼저 나오는 시나리오를
  // governing으로 고정한다 — 입력 배열의 순서에 결과가 의존하지
  // 않도록 하는 결정론 보장.
  const taxonomyOrder = RELIEF_LOAD_SCENARIO_TAXONOMY.map(s => s.id);
  const governing = valid.reduce((best, cur) => {
    if (cur.W > best.W) return cur;
    if (cur.W === best.W) {
      const bi = taxonomyOrder.indexOf(best.scenarioId);
      const ci = taxonomyOrder.indexOf(cur.scenarioId);
      return (ci !== -1 && ci < bi) ? cur : best;
    }
    return best;
  }, valid[0]);

  return {
    verdict: "OK",
    governingScenarioId: governing.scenarioId,
    governingW: governing.W,
    unit: "kg/h",
    allScenarios: results,
  };
}

// ════════════════════════════════════════════════════════════════
//  C-4.1 — §5.1 출구 차단(Closed outlets)
//  원문(KOSHA GUIDE D-18-2020 §5.1(1)): "소요분출량은 액체의 경우
//  최대 유입량, 스팀 또는 증기의 경우 최대 유입량과 분출 조건에서의
//  생성량을 합한 양이다." 원문이 제시하는 항은 이 두 개뿐이다 —
//  액체는 유입량만, 증기는 유입량+생성량만. 별도의 물성/열역학
//  변환식을 원문이 요구하지 않으므로 여기서 임의로 만들지 않는다.
//  입력 단위는 두 항 모두 원문이 명시하는 대로 kg/h — 이후 §5.6/
//  §5.7/§5.8도 "유입량"/"유출량"/"생성량" 항을 공유하므로 필드명
//  (inflow_kgh, generationRate_kgh)을 여기서 고정해 향후 시나리오와
//  충돌하지 않도록 한다. 순수 함수 — Date.now(), 전역 mutable state,
//  UI/Snapshot 접근 없음. selectGoverningReliefLoad()와는 독립적으로
//  동작하며, api520Engine()에는 아직 연결하지 않는다(별도 단계).
function calculateOutletBlockedScenario(input) {
  const SCENARIO_ID = "OUTLET_BLOCKED";
  const SECTION = "§5.1";
  const SOURCE = "KOSHA GUIDE D-18-2020 §5.1";
  const inputs = (input && typeof input === "object") ? { ...input } : {};
  const phase = inputs.phase;

  function insufficient(reason) {
    return {
      scenarioId: SCENARIO_ID, section: SECTION, phase: (phase === "LIQUID" || phase === "VAPOR") ? phase : null,
      status: "INSUFFICIENT_INPUT", W: null, unit: "kg/h",
      inputs, components: null, formula: null, reason, source: SOURCE,
    };
  }

  // 원문이 액체/증기 두 경우만 다루므로 phase는 이 둘로 한정한다 —
  // 미지정/오탈자 값을 임의로 어느 한쪽으로 추정하지 않는다(fail-fast).
  if (phase !== "LIQUID" && phase !== "VAPOR") {
    return insufficient("invalid_or_missing_phase");
  }

  const inflow = Number(inputs.inflow_kgh);
  if (typeof inputs.inflow_kgh !== "number" || !isFinite(inflow) || inflow < 0) {
    return insufficient("invalid_inflow_kgh");
  }

  if (phase === "LIQUID") {
    // 원문(1): 액체 = 최대 유입량. 생성량 항 없음 — generationRate_kgh는
    // 계산에 관여하지 않는다(액체 분기 자체가 이 항을 갖지 않음).
    return {
      scenarioId: SCENARIO_ID, section: SECTION, phase, status: "OK",
      W: inflow, unit: "kg/h", inputs,
      components: { inflow_kgh: inflow },
      formula: "W = 최대 유입량 (액체) — KOSHA D-18-2020 §5.1(1)",
      source: SOURCE,
    };
  }

  // VAPOR: 원문(1) — 최대 유입량 + 분출 조건에서의 생성량.
  const generation = Number(inputs.generationRate_kgh);
  if (typeof inputs.generationRate_kgh !== "number" || !isFinite(generation) || generation < 0) {
    return insufficient("invalid_generationRate_kgh");
  }
  return {
    scenarioId: SCENARIO_ID, section: SECTION, phase, status: "OK",
    W: inflow + generation, unit: "kg/h", inputs,
    components: { inflow_kgh: inflow, generationRate_kgh: generation },
    formula: "W = 최대 유입량 + 생성량 (증기) — KOSHA D-18-2020 §5.1(1)",
    source: SOURCE,
  };
}

// ════════════════════════════════════════════════════════════════
//  C-4.2 — §5.6 과충전(Overfilling)
//  원문(KOSHA GUIDE D-18-2020 §5.6(1)): "유입 유체 측 압력이 용기의
//  설계 압력을 초과할 수 있을 경우 최대 유입량을 소요분출량으로
//  삼는다." <표 2>에서도 §5.6은 "최대 유입량" 단일 항목뿐이며 §5.1과
//  달리 액체/증기 열이 나뉘어 있지 않다 — 즉 §5.6은 phase 구분이
//  원문에 없는 별개의 정책이다(§5.1의 LIQUID 분기를 재사용하는 것이
//  아니다). §5.1과 우연히 결과 형태가 같아 보이더라도(둘 다 단순
//  유입량 pass-through인 액체 케이스), scenarioId/section/provenance는
//  독립적으로 보존한다 — 이후 Trace/Evidence가 실제 governing 원인이
//  출구차단인지 과충전인지 구분해야 하기 때문이다. 순수 함수 — §5.1
//  구현은 수정하지 않았고, 검증 패턴(finite/non-negative)만 동일한
//  형태를 따랐다(공통 헬퍼로 추출해 §5.1을 건드리는 리팩터는 하지
//  않음 — C-4.1 결과에 불필요한 변경을 만들지 않기 위함).
function calculateOverfillingScenario(input) {
  const SCENARIO_ID = "OVERFILLING";
  const SECTION = "§5.6";
  const SOURCE = "KOSHA GUIDE D-18-2020 §5.6";
  const inputs = (input && typeof input === "object") ? { ...input } : {};

  const inflow = Number(inputs.inflow_kgh);
  if (typeof inputs.inflow_kgh !== "number" || !isFinite(inflow) || inflow < 0) {
    return {
      scenarioId: SCENARIO_ID, section: SECTION, phase: null,
      status: "INSUFFICIENT_INPUT", W: null, unit: "kg/h",
      inputs, components: null, formula: null,
      reason: "invalid_inflow_kgh", source: SOURCE,
    };
  }

  return {
    scenarioId: SCENARIO_ID, section: SECTION, phase: null, status: "OK",
    W: inflow, unit: "kg/h", inputs,
    components: { inflow_kgh: inflow },
    // 원문에 phase 구분이 없으므로 "액체"/"증기"를 명시하지 않는다 —
    // §5.1과 달리 이 시나리오는 phase에 무관하게 단일 공식이다.
    formula: "W = 최대 유입량 (과충전, phase 무관) — KOSHA D-18-2020 §5.6(1)",
    source: SOURCE,
  };
}

// ════════════════════════════════════════════════════════════════
//  C-4.3 — §5.7 자동제어밸브의 고장
//  원문(KOSHA GUIDE D-18-2020 §5.7, <표 2> 7번 항목)이 실제로 계산식을
//  제시하는 분기는 정확히 3개다:
//    1) 인입 제어밸브(§5.7(2)) — W = 최대 예상 유입량 − 정상 유출량
//    2) 출구 제어밸브(§5.7(3)) — W = 최대 유입량 − 정상 유출량
//       (전체 폐쇄 시 정상유출량=0이 되어 §5.1과 같은 형태로 수렴하는
//       특수 케이스일 뿐, 별도 공식이 아니다 — §5.7(3)(가))
//    3) Fail-stationary 밸브(§5.7(4)) — 원문은 별도 계산식을 주지 않고
//       "완전 개방 또는 완전 폐쇄를 가정하여 보수적으로(=더 큰 값)"라고만
//       규정한다. 이 함수는 그 절차를 위 1)/2)와 동일한 유입량−유출량
//       관계로 개방/폐쇄 두 가정에 각각 적용해 max를 취하는 것으로
//       구현했다 — 이는 원문에 없는 물성식을 추가한 것이 아니라 원문의
//       의사결정 절차(두 가정 중 보수적인 쪽 채택)를 그대로 코드화한
//       것이며, governingAssumption 필드로 감사 근거를 남긴다.
//  유입량−유출량이 음수가 되는 경우(유출량>유입량, 즉 이 메커니즘으로는
//  과압이 발생하지 않는 물리적으로 정상인 상황)는 W=0으로 클램프하되
//  clampedToZero 플래그로 남긴다 — 값을 숨기지 않는다.
//  순수 함수. §5.1/§5.6 코드는 수정하지 않았다.
function calculateControlValveFailureScenario(input) {
  const SCENARIO_ID = "CONTROL_VALVE_FAIL";
  const SECTION = "§5.7";
  const SOURCE = "KOSHA GUIDE D-18-2020 §5.7";
  const inputs = (input && typeof input === "object") ? { ...input } : {};
  const failureMode = inputs.failureMode;

  const VALID_MODES = ["INLET_VALVE", "OUTLET_VALVE", "FAIL_STATIONARY"];

  function insufficient(reason) {
    return {
      scenarioId: SCENARIO_ID, section: SECTION, phase: null,
      failureMode: VALID_MODES.includes(failureMode) ? failureMode : null,
      status: "INSUFFICIENT_INPUT", W: null, unit: "kg/h",
      inputs, components: null, formula: null, reason, source: SOURCE,
    };
  }

  function isValidNonNegativeNumber(v) {
    return typeof v === "number" && isFinite(v) && v >= 0;
  }

  if (!VALID_MODES.includes(failureMode)) {
    return insufficient("invalid_or_missing_failureMode");
  }

  if (failureMode === "INLET_VALVE" || failureMode === "OUTLET_VALVE") {
    if (!isValidNonNegativeNumber(inputs.inflow_kgh)) return insufficient("invalid_inflow_kgh");
    if (!isValidNonNegativeNumber(inputs.outflow_kgh)) return insufficient("invalid_outflow_kgh");

    const inflow = inputs.inflow_kgh;
    const outflow = inputs.outflow_kgh;
    const rawDifference = inflow - outflow;
    const W = Math.max(0, rawDifference);
    const sourceClause = failureMode === "INLET_VALVE" ? "§5.7(2)" : "§5.7(3)";

    return {
      scenarioId: SCENARIO_ID, section: SECTION, phase: null, failureMode, status: "OK",
      W, unit: "kg/h", inputs,
      components: { inflow_kgh: inflow, outflow_kgh: outflow, rawDifference, clampedToZero: rawDifference < 0 },
      formula: `W = 최대 유입량 − 정상 유출량 (${failureMode === "INLET_VALVE" ? "인입" : "출구"} 제어밸브) — KOSHA D-18-2020 ${sourceClause}`,
      source: SOURCE,
    };
  }

  // FAIL_STATIONARY — 개방/폐쇄 두 가정 중 보수적인(더 큰 W) 쪽을 채택.
  if (!isValidNonNegativeNumber(inputs.inflow_kgh)) return insufficient("invalid_inflow_kgh");
  if (!isValidNonNegativeNumber(inputs.openOutflow_kgh)) return insufficient("invalid_openOutflow_kgh");
  if (!isValidNonNegativeNumber(inputs.closedOutflow_kgh)) return insufficient("invalid_closedOutflow_kgh");

  const inflow = inputs.inflow_kgh;
  const openOutflow = inputs.openOutflow_kgh;
  const closedOutflow = inputs.closedOutflow_kgh;
  const openW = Math.max(0, inflow - openOutflow);
  const closedW = Math.max(0, inflow - closedOutflow);
  const W = Math.max(openW, closedW);
  const governingAssumption = openW >= closedW ? "OPEN" : "CLOSED";

  return {
    scenarioId: SCENARIO_ID, section: SECTION, phase: null, failureMode, status: "OK",
    W, unit: "kg/h", inputs,
    components: { inflow_kgh: inflow, openOutflow_kgh: openOutflow, closedOutflow_kgh: closedOutflow, openW, closedW },
    governingAssumption,
    formula: "W = max(최대유입량−개방가정유출량, 최대유입량−폐쇄가정유출량) (Fail-stationary, 보수적 가정 채택) — KOSHA D-18-2020 §5.7(4)",
    source: SOURCE,
  };
}

// ════════════════════════════════════════════════════════════════
//  C-4.4 — §5.8 비정상적인 열 또는 증기 유입
//  원문(KOSHA GUIDE D-18-2020 §5.8, <표 2> 8번 항목) 3분기 중 실제로
//  계산식이 있는 것은 2개뿐이다:
//    1) 비정상적 열 입력(§5.8(1)(가)) — W = 증기 발생량 − 정상 유출량
//    2) 부주의한 밸브 개방(§5.8(2)(가)(나)) — W = 유입량 − 유출량
//       (유출측 밸브가 열려있으면 그 유출량을 "차감할 수 있다"=선택적,
//       0도 유효한 입력)
//    3) 체크밸브 고장(§5.8(3)) — 원문이 "역류 상황 및 역류량 추정 기법
//       선정은 사용자가 결정해야 한다"고 명시, 계산식 자체가 없다.
//       이 함수는 이 분기를 status "NEEDS_ENGINEERING_DECISION"으로
//       명시적으로 반환하며 W를 산출하지 않는다 — 억지로 계산하지
//       않는다는 원칙(C-4 전체의 원칙)을 시나리오 함수 레벨에서도
//       그대로 지킨다.
//  주의: §5.8(1)(나)③의 "버너 등은 설계용량 대비 125%로 적용"이라는
//  문구는 W 산정식이 아니라 "증기 발생량"(vaporGeneration_kgh) 자체를
//  산정할 때 쓰는 상류(upstream) 가정이다 — 이 함수의 W 공식에 125%를
//  임의로 곱하지 않는다. vaporGeneration_kgh는 이미 그 가정이 반영되어
//  산정된 입력값으로 받는다(계산 책임을 이 함수로 가져오지 않음).
//  순수 함수. §5.1/§5.6/§5.7 코드는 수정하지 않았다.
function calculateAbnormalHeatVaporScenario(input) {
  const SCENARIO_ID = "ABNORMAL_HEAT_VAPOR";
  const SECTION = "§5.8";
  const SOURCE = "KOSHA GUIDE D-18-2020 §5.8";
  const inputs = (input && typeof input === "object") ? { ...input } : {};
  const failureMode = inputs.failureMode;

  const VALID_MODES = ["ABNORMAL_HEAT_INPUT", "INADVERTENT_VALVE_OPENING", "CHECK_VALVE_FAILURE"];

  function insufficient(reason) {
    return {
      scenarioId: SCENARIO_ID, section: SECTION, phase: null,
      failureMode: VALID_MODES.includes(failureMode) ? failureMode : null,
      status: "INSUFFICIENT_INPUT", W: null, unit: "kg/h",
      inputs, components: null, formula: null, reason, source: SOURCE,
    };
  }

  function isValidNonNegativeNumber(v) {
    return typeof v === "number" && isFinite(v) && v >= 0;
  }

  if (!VALID_MODES.includes(failureMode)) {
    return insufficient("invalid_or_missing_failureMode");
  }

  if (failureMode === "CHECK_VALVE_FAILURE") {
    // 원문 §5.8(3): 계산식 없음 — 역류 상황/기법 선정은 사용자 결정 사항.
    return {
      scenarioId: SCENARIO_ID, section: SECTION, phase: null, failureMode,
      status: "NEEDS_ENGINEERING_DECISION", W: null, unit: "kg/h",
      inputs, components: null, formula: null,
      reason: "KOSHA D-18-2020 §5.8(3): 역류 상황(완전고장/심한누설/정상누설) 및 역류량 추정 기법 선정은 사용자가 결정해야 함 — 원문에 계산식 없음",
      source: SOURCE,
    };
  }

  if (failureMode === "ABNORMAL_HEAT_INPUT") {
    if (!isValidNonNegativeNumber(inputs.vaporGeneration_kgh)) return insufficient("invalid_vaporGeneration_kgh");
    if (!isValidNonNegativeNumber(inputs.outflow_kgh)) return insufficient("invalid_outflow_kgh");

    const vaporGeneration = inputs.vaporGeneration_kgh;
    const outflow = inputs.outflow_kgh;
    const rawDifference = vaporGeneration - outflow;
    const W = Math.max(0, rawDifference);

    return {
      scenarioId: SCENARIO_ID, section: SECTION, phase: null, failureMode, status: "OK",
      W, unit: "kg/h", inputs,
      components: { vaporGeneration_kgh: vaporGeneration, outflow_kgh: outflow, rawDifference, clampedToZero: rawDifference < 0 },
      formula: "W = 증기 발생량 − 정상 유출량 (비정상 열 입력) — KOSHA D-18-2020 §5.8(1)(가)",
      source: SOURCE,
    };
  }

  // INADVERTENT_VALVE_OPENING — §5.8(2)(가)(나)
  if (!isValidNonNegativeNumber(inputs.inflow_kgh)) return insufficient("invalid_inflow_kgh");
  if (!isValidNonNegativeNumber(inputs.outflow_kgh)) return insufficient("invalid_outflow_kgh");

  const inflow = inputs.inflow_kgh;
  const outflow = inputs.outflow_kgh;
  const rawDifference = inflow - outflow;
  const W = Math.max(0, rawDifference);

  return {
    scenarioId: SCENARIO_ID, section: SECTION, phase: null, failureMode, status: "OK",
    W, unit: "kg/h", inputs,
    components: { inflow_kgh: inflow, outflow_kgh: outflow, rawDifference, clampedToZero: rawDifference < 0 },
    formula: "W = 유입량 − 유출량 (부주의한 밸브 개방, 출구 유출량 차감은 선택적) — KOSHA D-18-2020 §5.8(2)(가)(나)",
    source: SOURCE,
  };
}

// ════════════════════════════════════════════════════════════════
//  C-4.5 — §5.11 액체부피 팽창(Hydraulic expansion)
//  원문(KOSHA GUIDE D-18-2020 §5.11(2)): 식(1) V = αQ/(500·SG·Cp).
//  이 시나리오는 §5.1~§5.8과 근본적으로 다른 점이 있다 — 결과가
//  질량유량 W(kg/hr)가 아니라 **부피유량 V(㎥/hr)**다. 밀도를 곱해
//  kg/hr로 변환하는 것은 원문에 없는 계산을 추가하는 것이므로 하지
//  않는다. 그래서 이 함수의 결과 객체는 다른 시나리오들과 달리 W
//  필드를 갖지 않고 대신 value/unit:"m3/h"를 쓴다 — 이는 실수로
//  selectGoverningReliefLoad()에 흘러들어가도(r.W가 undefined이므로)
//  자동으로 무효 처리되게 하는 의도된 설계이기도 하다. kg/h와 m³/h를
//  어떻게 통합할지는 §6 연결 시점(C-4.8)의 별도 아키텍처 결정 사항
//  으로 남겨둔다 — 지금 결정하지 않는다.
//
//  status: "COMPUTABLE"은 "이 함수가 V를 계산할 수 있다"는 뜻으로만
//  쓴다 — "전체 relief-load 체인에 편입 가능하다"는 뜻이 아니다.
//  실패 시에는 다른 시나리오와 동일하게 "INSUFFICIENT_INPUT"을 쓴다.
//
//  원문은 "유입열량(Q) 산정 등 세부내용은 열팽창 안전밸브의
//  기술지침(D-13)을 참조한다"고 명시한다 — 단, KOSHA 현행 목록
//  대조 결과 현재 "열팽창용 안전밸브의 기술지침"은 D-31-2012이고
//  D-13-2012는 "염소저장 설비에 관한 기술지침"이다(D-18-2020 원문에
//  남아있는 교차참조 번호가 갱신되지 않은 것으로 보임 — 이 불일치는
//  문서/provenance 기록용일 뿐 계산 로직과는 무관하다). 어느 번호든
//  그 외부지침은 Q(입력값) 산정에만 관여하고 V 산정식(식 1) 자체는
//  이 함수에 완결되어 있으므로 D-13/D-31의 내용을 이 함수의 계산에
//  끌어오지 않는다 — Q는 이미 산정되어 들어오는 입력으로만 받는다
//  (§5.8의 vaporGeneration_kgh와 동일한 패턴).
//
//  분모(500·SG·Cp)가 0이 되는 경우(SG=0 또는 Cp=0)는 계산하지 않고
//  fail-fast — SG/Cp는 물리적으로도 0일 수 없는 값이라 이 자체가
//  유효하지 않은 입력이다. 상수 500은 원문 그대로 유지, 재유도하지
//  않는다. 순수 함수. §5.1/§5.6/§5.7/§5.8 코드는 수정하지 않았다.
function calculateLiquidThermalExpansionScenario(input) {
  const SCENARIO_ID = "LIQUID_EXPANSION";
  const SECTION = "§5.11";
  const SOURCE = "KOSHA GUIDE D-18-2020 §5.11(2), 식(1)";
  const UPSTREAM_REFERENCE_NOTE = "유입열량(Q) 산정 세부내용은 원문상 \"열팽창 안전밸브의 기술지침(D-13)\" 참조 — " +
    "KOSHA 현행 목록상 열팽창용 안전밸브 지침은 D-31-2012(D-13-2012는 별개로 염소저장 설비 지침); " +
    "원문의 교차참조 번호 불일치이며 Q는 이미 산정된 입력으로만 사용, V 산정식 자체와는 무관";
  const inputs = (input && typeof input === "object") ? { ...input } : {};

  function isValidNonNegativeFiniteNumber(v) {
    return typeof v === "number" && isFinite(v) && v >= 0;
  }
  function isValidPositiveFiniteNumber(v) {
    return typeof v === "number" && isFinite(v) && v > 0;
  }

  function insufficient(reason) {
    return {
      scenarioId: SCENARIO_ID, section: SECTION, phase: null,
      status: "INSUFFICIENT_INPUT", value: null, unit: "m3/h",
      inputs, components: null, formula: null, reason,
      source: SOURCE, upstreamReference: UPSTREAM_REFERENCE_NOTE,
    };
  }

  // α(부피팽창계수)와 Q(총 열전달 속도)는 0이 물리적으로 유효하다
  // (팽창이 없거나 열유입이 없는 경우) — 0을 거부하지 않는다.
  if (!isValidNonNegativeFiniteNumber(inputs.alpha_per_degC)) return insufficient("invalid_alpha_per_degC");
  if (!isValidNonNegativeFiniteNumber(inputs.Q_kcal_per_hr)) return insufficient("invalid_Q_kcal_per_hr");
  // SG(비중)와 Cp(비열)는 분모이며 물리적으로도 0이나 음수가 될 수
  // 없는 값이다 — 0을 포함해 명시적으로 거부한다(fail-fast, 나눗셈
  // 전에 차단).
  if (!isValidPositiveFiniteNumber(inputs.SG)) return insufficient("invalid_SG_must_be_positive");
  if (!isValidPositiveFiniteNumber(inputs.Cp_kcal_per_kgC)) return insufficient("invalid_Cp_must_be_positive");

  const alpha = inputs.alpha_per_degC;
  const Q = inputs.Q_kcal_per_hr;
  const SG = inputs.SG;
  const Cp = inputs.Cp_kcal_per_kgC;
  const value = (alpha * Q) / (500 * SG * Cp);

  return {
    scenarioId: SCENARIO_ID, section: SECTION, phase: null, status: "COMPUTABLE",
    value, unit: "m3/h", inputs,
    components: { alpha_per_degC: alpha, Q_kcal_per_hr: Q, SG, Cp_kcal_per_kgC: Cp, denominatorConstant: 500 },
    formula: "V = α·Q / (500·SG·Cp) — KOSHA D-18-2020 §5.11(2) 식(1)",
    source: SOURCE, upstreamReference: UPSTREAM_REFERENCE_NOTE,
  };
}

// ════════════════════════════════════════════════════════════════
//  C-4.6 — §5.13 열교환기 고장
//  원문(KOSHA GUIDE D-18-2020 §5.13, <표 2> 13번 항목)은 §5.1~§5.11과
//  근본적으로 다르다 — **완결된 유량 산정식을 주지 않는다.** 원문이
//  실제로 정의하는 건 "오리피스 면적"뿐이다:
//    - 다관형(Shell-and-tube): 튜브 단면적의 2배 크기의 구멍
//    - 판형(Plate-and-frame): 다관형 튜브 단면적에 해당하는 구멍
//    - 이중관(Double-pipe): Schedule pipe면 보통 불필요(NOT_APPLICABLE),
//      Gauge tube면 사례별 공학적 판단 필요(NEEDS_ENGINEERING_DECISION)
//  그 면적을 실제 유량(kg/h)으로 바꾸는 흐름식은 원문 §5.13(1)(마)가
//  "액체는 비압축성 흐름식, 증기/가스는 압축성 흐름식, 플래싱 발생
//  시 균일평형모델(HEM) 2상 흐름식을 사용하라"고만 지시할 뿐 그 식
//  자체를 제시하지 않는다 — 즉 면적→유량 변환은 이 조항의 범위 밖
//  이다. 여기서 압축성/비압축성/2상 흐름식을 임의로 만들어 넣는 것은
//  §5.13에 없는 유체역학 모델을 추가하는 것이므로 하지 않는다.
//
//  그래서 이 함수는 **오리피스 면적 산정까지만** 구현한다. 결과는
//  W(kg/h)도 V(㎥/hr)도 아닌 면적(㎡)이므로 requiredOrificeArea_m2
//  필드를 쓴다 — 범용 필드에 다른 단위를 넣지 않는다는 원칙(C-4.5와
//  동일). status "COMPUTABLE"은 "오리피스 면적 산정이 가능하다"는
//  뜻으로만 쓴다 — "소요분출량(유량)까지 산정 가능하다"는 뜻이 아님을
//  명시한다. "튜브 단면적"은 원문 문구 그대로 입력값
//  (tubeCrossSectionArea_m2)으로 직접 받는다 — 지름으로부터 πD²/4로
//  역산하는 변환은 원문에 없으므로 추가하지 않는다.
//  순수 함수. §5.1/§5.6/§5.7/§5.8/§5.11 코드는 수정하지 않았다.
function calculateExchangerFailureScenario(input) {
  const SCENARIO_ID = "EXCHANGER_FAIL";
  const SECTION = "§5.13";
  const SOURCE = "KOSHA GUIDE D-18-2020 §5.13, <표 2> 13번";
  const FLOW_EQUATION_NOTE = "면적→유량 변환은 원문 §5.13(1)(마)가 \"액체=비압축성 흐름식, 증기/가스=압축성 흐름식, " +
    "플래싱 시 HEM 2상 흐름식\"이라고만 지시하고 식 자체를 제시하지 않음 — 이 함수는 오리피스 면적 산정까지만 " +
    "수행하며 면적→유량 변환은 별도 NEEDS_ENGINEERING_DECISION 사항";
  const inputs = (input && typeof input === "object") ? { ...input } : {};
  const exchangerType = inputs.exchangerType;

  const VALID_TYPES = ["SHELL_AND_TUBE", "PLATE_AND_FRAME", "DOUBLE_PIPE"];

  function insufficient(reason) {
    return {
      scenarioId: SCENARIO_ID, section: SECTION, phase: null,
      exchangerType: VALID_TYPES.includes(exchangerType) ? exchangerType : null,
      status: "INSUFFICIENT_INPUT", requiredOrificeArea_m2: null, unit: "m2",
      inputs, components: null, formula: null, reason,
      source: SOURCE, flowEquationNote: FLOW_EQUATION_NOTE,
    };
  }

  function isValidPositiveFiniteNumber(v) {
    return typeof v === "number" && isFinite(v) && v > 0;
  }

  if (!VALID_TYPES.includes(exchangerType)) {
    return insufficient("invalid_or_missing_exchangerType");
  }

  if (exchangerType === "DOUBLE_PIPE") {
    const innerTubeType = inputs.innerTubeType;
    if (innerTubeType !== "SCHEDULE_PIPE" && innerTubeType !== "GAUGE_TUBE") {
      return insufficient("invalid_or_missing_innerTubeType");
    }
    if (innerTubeType === "SCHEDULE_PIPE") {
      // 원문 §5.13(2)(가): 다른 배관 이상의 파열 가능성 없음 — 압력방출장치 불요.
      return {
        scenarioId: SCENARIO_ID, section: SECTION, phase: null, exchangerType, innerTubeType,
        status: "NOT_APPLICABLE", requiredOrificeArea_m2: null, unit: "m2",
        inputs, components: null,
        formula: null,
        reason: "KOSHA D-18-2020 §5.13(2)(가): Schedule pipe는 다른 배관 이상의 파열 가능성이 없어 압력방출장치 설치 불요",
        source: SOURCE, flowEquationNote: FLOW_EQUATION_NOTE,
      };
    }
    // GAUGE_TUBE — 원문 §5.13(2)(나): 사례별 공학적 판단 필요, 계산식 없음.
    return {
      scenarioId: SCENARIO_ID, section: SECTION, phase: null, exchangerType, innerTubeType,
      status: "NEEDS_ENGINEERING_DECISION", requiredOrificeArea_m2: null, unit: "m2",
      inputs, components: null, formula: null,
      reason: "KOSHA D-18-2020 §5.13(2)(나): Gauge tube는 용접 고장 등 사례별 공학적 판단이 필요 — 원문에 계산식 없음",
      source: SOURCE, flowEquationNote: FLOW_EQUATION_NOTE,
    };
  }

  // SHELL_AND_TUBE / PLATE_AND_FRAME — 튜브 단면적 기반 오리피스 면적 산정.
  if (!isValidPositiveFiniteNumber(inputs.tubeCrossSectionArea_m2)) {
    return insufficient("invalid_tubeCrossSectionArea_m2");
  }
  const tubeArea = inputs.tubeCrossSectionArea_m2;
  const multiplier = exchangerType === "SHELL_AND_TUBE" ? 2 : 1;
  const requiredOrificeArea_m2 = multiplier * tubeArea;

  return {
    scenarioId: SCENARIO_ID, section: SECTION, phase: null, exchangerType, status: "COMPUTABLE",
    requiredOrificeArea_m2, unit: "m2", inputs,
    components: { tubeCrossSectionArea_m2: tubeArea, multiplier },
    formula: exchangerType === "SHELL_AND_TUBE"
      ? "요구 오리피스 면적 = 튜브 단면적 × 2 (다관형) — KOSHA D-18-2020 §5.13, <표 2> 13-1)"
      : "요구 오리피스 면적 = 튜브 단면적 × 1 (판형, 다관형 튜브단면적에 해당) — KOSHA D-18-2020 §5.13, <표 2> 13-3)",
    source: SOURCE, flowEquationNote: FLOW_EQUATION_NOTE,
  };
}

// ════════════════════════════════════════════════════════════════
//  C-4.7 — §5.12 외부 화재(External fire)
//  원문(KOSHA GUIDE D-18-2020 §5.12) 식(2)~(7)을 1차 출처(사용자 제공
//  원본 PDF, 페이지 이미지 직접 대조)로 확인해 그대로 구현했다.
//  계수는 전부 원문 그대로: 37,100 / 61,000 / 0.82 / 57,000 / 904 /
//  8.766 / 1.25 / 1.1506 — 재유도하거나 일반화하지 않는다.
//
//  원문은 개방 액면화재(Open pool fire)/제한공간화재(Confined pool
//  fire)/제트화재(Jet fire) 3가지 화재유형을 구분하는데, 실제로
//  계산식이 있는 건 개방 액면화재(액체/가스·증기 두 갈래)뿐이다:
//    - 액체 취급 용기: 식(2)(3)(4) — W=Q/λ, Q=계수·F·Aws^0.82
//    - 가스/증기/초임계유체 용기: 식(7) — W=8.766√(MP1)·[A(Tw-T1)^1.25/T1^1.1506]
//  제한공간화재는 원문 §5.12(3)(나)가 "소규모 연료지배형 화재는
//  식(2)~(4)에서 Aws 대신 Awi를 사용"이라고 명시 — 즉 새 공식이
//  아니라 액체 개방화재 공식을 면적 변수만 바꿔 재사용하는 것이므로
//  동일 계산 경로를 쓰되 provenance에 Awi임을 남긴다. 환기지배형과
//  대규모 연료지배형은 원문이 "더 엄밀한 방법 필요"라며 계산식을
//  주지 않아 NEEDS_ENGINEERING_DECISION. 제트화재는 원문이 "통상적인
//  압력방출장치는 효과적인 보호 수단이 될 수 없다"고 명시적으로
//  배제하므로 NEEDS_ENGINEERING_DECISION(계산 대상 자체가 아님).
//
//  F(환경인자)는 <표 3>에서 직접 읽은 값(0~1)을 그대로 받거나,
//  단열재 물성(k, δins, Tf)으로부터 식(5)/(6)을 통해 산정한다 —
//  식(5)는 식(6)에서 층 수 n=1인 특수case와 대수적으로 동일하므로
//  하나의 합산식으로 구현했다(원문을 일반화한 것이 아니라 n=1일 때
//  정확히 같은 식이 되는 것을 재사용한 것).
//
//  가스/증기 케이스의 T1은 원문이 "T1=(P1/Pn)×Tn"라는 식을 직접
//  제공하므로 Pn/Tn으로부터 여기서 산출한다(원문에 있는 식이라 별도
//  가정 아님) — 다만 이미 산정된 T1을 직접 입력해도 된다.
//
//  W(kg/hr) 계열(액체/가스·증기 화재)은 §5.1~§5.8과 동일한 W/unit
//  계약을 쓴다(다른 §5.12 하위계산과 달리 이번엔 결과가 실제로
//  kg/hr이므로 §5.11/§5.13처럼 별도 단위 필드를 만들 필요 없음).
//  순수 함수. §5.1/§5.6/§5.7/§5.8/§5.11/§5.13 코드는 수정하지 않았다.
//  아직 selectGoverningReliefLoad()/api520Engine()에 연결하지 않는다.
function calculateExternalFireScenario(input) {
  const SCENARIO_ID = "EXTERNAL_FIRE";
  const SECTION = "§5.12";
  const SOURCE = "KOSHA GUIDE D-18-2020 §5.12, 식(2)~(7)";
  const inputs = (input && typeof input === "object") ? { ...input } : {};
  const fireCase = inputs.fireCase;

  const VALID_CASES = [
    "OPEN_POOL_LIQUID", "OPEN_POOL_GAS_VAPOR",
    "CONFINED_POOL_FUEL_SMALL_MEDIUM",
    "CONFINED_POOL_VENTILATION_CONTROLLED", "CONFINED_POOL_LARGE_SCALE",
    "JET_FIRE",
  ];

  function insufficient(reason) {
    return {
      scenarioId: SCENARIO_ID, section: SECTION, phase: null,
      fireCase: VALID_CASES.includes(fireCase) ? fireCase : null,
      status: "INSUFFICIENT_INPUT", W: null, unit: "kg/h",
      inputs, components: null, formula: null, reason, source: SOURCE,
    };
  }

  function isFiniteNumber(v) { return typeof v === "number" && isFinite(v); }
  function isPositiveFiniteNumber(v) { return isFiniteNumber(v) && v > 0; }

  if (!VALID_CASES.includes(fireCase)) {
    return insufficient("invalid_or_missing_fireCase");
  }

  // ── 계산식이 없는 하위케이스: 원문이 명시적으로 배제하거나 더 엄밀한 방법을 요구 ──
  if (fireCase === "JET_FIRE") {
    return {
      scenarioId: SCENARIO_ID, section: SECTION, phase: null, fireCase,
      status: "NEEDS_ENGINEERING_DECISION", W: null, unit: "kg/h",
      inputs, components: null, formula: null,
      reason: "KOSHA D-18-2020 §5.12(4): 제트화재는 통상적인 압력방출장치가 효과적인 보호수단이 될 수 없다고 명시 — 화재 누출원 격리/감압시스템/외부단열 등 관리적 대책 필요, 계산식 없음",
      source: SOURCE,
    };
  }
  if (fireCase === "CONFINED_POOL_VENTILATION_CONTROLLED") {
    return {
      scenarioId: SCENARIO_ID, section: SECTION, phase: null, fireCase,
      status: "NEEDS_ENGINEERING_DECISION", W: null, unit: "kg/h",
      inputs, components: null, formula: null,
      reason: "KOSHA D-18-2020 §5.12(3)(가)①: 환기지배형 제한공간화재는 화재 규모가 제한적이나 원문이 별도 계산식을 제시하지 않음",
      source: SOURCE,
    };
  }
  if (fireCase === "CONFINED_POOL_LARGE_SCALE") {
    return {
      scenarioId: SCENARIO_ID, section: SECTION, phase: null, fireCase,
      status: "NEEDS_ENGINEERING_DECISION", W: null, unit: "kg/h",
      inputs, components: null, formula: null,
      reason: "KOSHA D-18-2020 §5.12(3)(가)②㉯: 대규모 화재는 식(3)(4)가 열입력량을 과소평가하게 되어 더 엄밀한 방법이 필요하다고 명시 — 계산식 없음",
      source: SOURCE,
    };
  }

  // ── 개방 액면화재(액체) / 제한공간화재(소규모 연료지배형, 동일 공식 재사용) ──
  if (fireCase === "OPEN_POOL_LIQUID" || fireCase === "CONFINED_POOL_FUEL_SMALL_MEDIUM") {
    if (typeof inputs.adequateDrainage !== "boolean") return insufficient("invalid_or_missing_adequateDrainage");
    if (!isPositiveFiniteNumber(inputs.wettedArea_m2)) return insufficient("invalid_wettedArea_m2");
    if (!isPositiveFiniteNumber(inputs.latentHeat_kcal_per_kg)) return insufficient("invalid_latentHeat_kcal_per_kg");

    // F 산정: 표3 직접값(0~1) 또는 단열재 층 목록(k,δins)+Tf로 식(5)/(6) 산출.
    let F, fProvenance;
    if (isFiniteNumber(inputs.F) && inputs.F >= 0 && inputs.F <= 1 && inputs.insulationLayers === undefined) {
      F = inputs.F;
      fProvenance = "표3 직접값(또는 사용자 산정값)";
    } else if (Array.isArray(inputs.insulationLayers) && inputs.insulationLayers.length >= 1 && isFiniteNumber(inputs.Tf_degC)) {
      const layers = inputs.insulationLayers;
      let sum = 0;
      for (const layer of layers) {
        if (!layer || typeof layer !== "object") return insufficient("invalid_insulationLayers_entry");
        if (!isPositiveFiniteNumber(layer.k_kcal_mm_per_hr_m2_degC)) return insufficient("invalid_insulationLayer_k");
        if (!isPositiveFiniteNumber(layer.thickness_mm)) return insufficient("invalid_insulationLayer_thickness");
        sum += layer.thickness_mm / layer.k_kcal_mm_per_hr_m2_degC;
      }
      F = (904 - inputs.Tf_degC) / (57000 * sum);
      fProvenance = layers.length === 1
        ? "식(5) 단일 단열재로 산정 — KOSHA D-18-2020 §5.12(2)(가)②㉯"
        : "식(6) 복층 단열재로 산정 — KOSHA D-18-2020 §5.12(2)(가)②㉰";
    } else {
      return insufficient("invalid_or_missing_F_or_insulationLayers");
    }
    if (!isFiniteNumber(F) || F < 0) return insufficient("computed_F_out_of_range");

    const coefficient = inputs.adequateDrainage ? 37100 : 61000;
    const Q = coefficient * F * Math.pow(inputs.wettedArea_m2, 0.82);
    const W = Q / inputs.latentHeat_kcal_per_kg;
    const areaLabel = fireCase === "OPEN_POOL_LIQUID" ? "Aws(개방 액면화재)" : "Awi(제한공간화재 대체 면적, §5.12(3)(나))";

    return {
      scenarioId: SCENARIO_ID, section: SECTION, phase: null, fireCase, status: "OK",
      W, unit: "kg/h", inputs,
      components: {
        adequateDrainage: inputs.adequateDrainage, coefficient, F, fProvenance,
        wettedArea_m2: inputs.wettedArea_m2, areaLabel, Q_kcal_per_hr: Q,
        latentHeat_kcal_per_kg: inputs.latentHeat_kcal_per_kg,
      },
      formula: `W=Q/λ, Q=${coefficient}·F·${fireCase === "OPEN_POOL_LIQUID" ? "Aws" : "Awi"}^0.82 — KOSHA D-18-2020 식(2)(${inputs.adequateDrainage ? "3" : "4"})`,
      source: SOURCE,
    };
  }

  // ── OPEN_POOL_GAS_VAPOR — 식(7) ──
  if (!isPositiveFiniteNumber(inputs.M)) return insufficient("invalid_M");
  if (!isPositiveFiniteNumber(inputs.P1_MPa)) return insufficient("invalid_P1_MPa");
  if (!isPositiveFiniteNumber(inputs.A_m2)) return insufficient("invalid_A_m2");
  if (!isPositiveFiniteNumber(inputs.Tw_K)) return insufficient("invalid_Tw_K");

  let T1, t1Provenance;
  if (isPositiveFiniteNumber(inputs.T1_K) && inputs.Pn_MPa === undefined && inputs.Tn_K === undefined) {
    T1 = inputs.T1_K;
    t1Provenance = "직접 입력값";
  } else if (isPositiveFiniteNumber(inputs.Pn_MPa) && isPositiveFiniteNumber(inputs.Tn_K)) {
    T1 = (inputs.P1_MPa / inputs.Pn_MPa) * inputs.Tn_K;
    t1Provenance = "T1=(P1/Pn)×Tn 로 산정 — KOSHA D-18-2020 §5.12(2)(나), 식(7) 정의부";
  } else {
    return insufficient("invalid_or_missing_T1_or_Pn_Tn");
  }
  if (!isPositiveFiniteNumber(T1)) return insufficient("computed_T1_invalid");
  if (inputs.Tw_K <= T1) return insufficient("Tw_must_exceed_T1");

  const W = 8.766 * Math.sqrt(inputs.M * inputs.P1_MPa) *
    (inputs.A_m2 * Math.pow(inputs.Tw_K - T1, 1.25) / Math.pow(T1, 1.1506));

  return {
    scenarioId: SCENARIO_ID, section: SECTION, phase: null, fireCase, status: "OK",
    W, unit: "kg/h", inputs,
    components: { M: inputs.M, P1_MPa: inputs.P1_MPa, A_m2: inputs.A_m2, Tw_K: inputs.Tw_K, T1_K: T1, t1Provenance },
    formula: "W = 8.766·√(M·P1)·[A(Tw−T1)^1.25 / T1^1.1506] — KOSHA D-18-2020 식(7)",
    source: SOURCE,
  };
}
