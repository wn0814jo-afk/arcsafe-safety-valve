//  ENGINE (pure, stateless — UI 접근 금지)
// ════════════════════════════════════════════════════════════════
// ENGINE_VERSION 1.2.0 — API520-SI-001 / API520-PRESSURE-001 수정
//   [BUG FIX] SI 단위 변환 상수(13160) 누락 — US 상수(520) 기반 C를
//   SI 입력(kg/h, bar, K)에 그대로 곱해 areaCm2가 실제값의 약 7600배로
//   산출되던 결함. API 520 공식 예제(fluids lib 검증, W=24270kg/h,
//   T=348K, MW=51, k=1.11, P1=670kPa → 3699.046mm²)로 역산 검증,
//   13160 상수(W kg/h, P1 kPa 기준) 적용 시 오차 0.09% 이내로 확인.
//   [BUG FIX] P1을 설정압력(barg)에서 relieving pressure(절대압)로
//   변환하는 과정이 누락 — Pset*(1+OP/100)+대기압 미적용.
// ENGINE_VERSION 1.3.0 — COMPRESSIBILITY-001
//   Z(압축계수)를 하드코딩(1.0)에서 Calculation Input으로 승격.
//   Asset이 아니라 Case 소유 — 유체·운전조건에 따라 케이스마다 달라짐.
//   기본값 1.00은 UI가 명시적으로 대입하며 Engine은 몰래 채우지 않는다.
//   validateInputs가 Z 누락을 거부하므로 이 필드는 계약 변경이다.
// ENGINE_VERSION 1.5.0 — ACCUMULATION-001
//   축적압력 허용한계(overpressure guardrail)를 밸브 개수(valveCount)+
//   화재 보호 목적 여부(fireScenario)의 정책 테이블로 신설.
//   Case 입력: valveCount, fireScenario (신규) + 기존 OP(Asset 소유,
//   Case inputs로 복사되어 옴 — 신규 필드 아님, 재사용).
//   근거: KOSHA GUIDE D-18-2020 §4.4, <표 1> — 비화재/단일 110%,
//   비화재/2개이상 116%, 화재(수량무관) 121%.
//   sizing(RELIEVING_PRESSURE의 P1abs 산정)과 이 가드레일은 같은 OP
//   값을 쓰지만 서로 다른 질문에 답하는 별개 계산 — Trace에서 분리.
//   허용치 초과 시 자동으로 OP를 낮추는 보정은 하지 않는다 — checklist에
//   accumulationOK:false로 명시적 NO-GO만 표시(fail-fast, 결정론 원칙).
// ENGINE_VERSION 1.4.0 — VALVE-TYPE-001
//   배압 허용비율(10%)을 스프링식 전용 상수로 하드코딩했던 것을 밸브
//   형식(valveType)별 정책 테이블(BACKPRESSURE_POLICY)로 승격.
//   valveType은 Case 입력(Calculation Input) — InputView → inputs →
//   Engine → Snapshot → ReportPackage → Evidence/PDF까지 동일 값 전파.
//   근거: KOSHA GUIDE D-18-2020 §7.2(4) — 스프링식 10%, 벨로우즈형
//   (밸런스형) 50%. 파일럿식은 원문에 수치 기준이 없어 이번 버전에서
//   지원하지 않음 — 미지정/미지원 valveType은 SPRING(더 엄격한 기준,
//   안전측)으로 처리한다. Pilot 기준은 별도 확인 후 후속 버전에서 추가.
const ENGINE_VERSION = "1.5.0";

// ── TRACE-SCHEMA-001: Calculation Trace 스키마 고정 ────────────
// Trace는 단순 로그가 아니라 감사 증거(Report Evidence)다. 각 항목은
// 반드시 이 4개 필드를 갖는다: step(단계 식별자), value(산출값),
// unit(단위, 무차원이면 ""), formula(계산식 설명). inputs는 선택
// (그 단계가 어떤 값들로부터 나왔는지 — 없는 단계도 있을 수 있음).
// 이 스키마를 바꾸면 TRACE-SCHEMA-001 계약 테스트가 실패해야 한다.
const TRACE_REQUIRED_KEYS = ["step", "value", "unit", "formula"];
function validateTraceSchema(trace) {
  if (!Array.isArray(trace)) return { ok:false, reason:"trace_not_array" };
  for (let i = 0; i < trace.length; i++) {
    const entry = trace[i];
    if (!entry || typeof entry !== "object") {
      return { ok:false, reason:"entry_not_object", index:i };
    }
    for (const k of TRACE_REQUIRED_KEYS) {
      if (!(k in entry)) return { ok:false, reason:"missing_key", key:k, index:i, step:entry.step };
    }
    if (typeof entry.step !== "string" || entry.step.length === 0) {
      return { ok:false, reason:"invalid_step_id", index:i };
    }
  }
  return { ok:true };
}

const API_CONST = {
  C_BASE:              520,
  SI_AREA_CONST:        13160,   // API 520 SI eq.: A[mm²]=13160·W[kg/h]/(C·Kd·P1[kPa]·Kb)·√(TZ/M)
  ATM_PRESSURE_BAR:     1.01325, // 표준 대기압 (relieving pressure 절대압 환산용)
  // VALVE-TYPE-001: 배압 허용비율은 밸브 형식의 정책값 — 엔진이 정책
  // 테이블을 소유한다. UI는 valveType만 넘기고 허용비율 숫자를 직접
  // 넘기지 않는다. 출처: KOSHA GUIDE D-18-2020 §7.2(4).
  //   SPRING  — 스프링식(일반형): 배압 ≤ 설정압력의 10%
  //   BELLOWS — 벨로우즈형(밸런스형): 배압 ≤ 설정압력의 50%
  //             (단, 제작자가 별도 허용한도를 명시한 경우 그에 따름 — 이 앱은
  //             가이드 표준값만 적용, 제작자 개별 데이터시트는 반영하지 않음)
  //   PILOT   — 가이드 원문에 수치 기준 없음. 별도 확인 전까지 미지원.
  BACKPRESSURE_POLICY: {
    SPRING:  0.10,
    BELLOWS: 0.50,
  },
  BACKPRESSURE_POLICY_SOURCE: "KOSHA GUIDE D-18-2020 §7.2(4)",
  // ACCUMULATION-001: 축적압력 허용한계는 밸브 개수(valveCount) + 화재
  // 보호 목적 여부(fireScenario)의 정책값 — 엔진이 정책 테이블을 소유한다.
  // 출처: KOSHA GUIDE D-18-2020 §4.4 및 <표 1>.
  //   화재 보호 목적이 아닌 경우: 밸브 1개 설치 → 110% / 2개 이상 설치 → 116%
  //   화재 보호 목적인 경우: 밸브 수량과 무관하게 → 121%
  // (모든 수치는 설계압력 또는 최고허용압력(MAWP)에 대한 %)
  ACCUMULATION_POLICY: {
    NON_FIRE_SINGLE: 1.10,
    NON_FIRE_MULTI:  1.16,
    FIRE:            1.21,
  },
  ACCUMULATION_POLICY_SOURCE: "KOSHA GUIDE D-18-2020 §4.4, <표 1>",
  RD_KD_FACTOR:        0.9,
  KD_MIN:              0.9,
  MARGIN_MIN:          1.0,
  SIM_MAWP_FACTOR:     1.12,
  SIM_SPEED_NORMAL:    0.04,
  SIM_SPEED_RELIEF:    0.08,
  HISTORY_SIZE:        90,
};

// VALVE-TYPE-001: 밸브 형식 → 허용 배압비율. 미지정/미지원 값은 SPRING
// (더 엄격한 기준)으로 처리한다 — 안전측 기본값, 과거 Snapshot(valveType
// 필드 없음)과의 하위호환도 겸한다.
function getAllowableBackpressureRatio(valveType) {
  const vt = String(valveType || "SPRING").toUpperCase();
  return API_CONST.BACKPRESSURE_POLICY[vt] ?? API_CONST.BACKPRESSURE_POLICY.SPRING;
}

// ACCUMULATION-001: (화재여부, 밸브개수) → 허용 축적압력비.
// 미지정 fireScenario는 false(비화재, 더 엄격한 쪽)로, 미지정/미인식
// valveCount는 1(단일 밸브, 가장 엄격한 110%)로 처리한다 — 안전측 기본값,
// 과거 Snapshot과의 하위호환도 겸한다.
function getAllowableAccumulationRatio(fireScenario, valveCount) {
  if (fireScenario === true) return API_CONST.ACCUMULATION_POLICY.FIRE;
  const vc = Number(valveCount);
  return (Number.isFinite(vc) && vc >= 2)
    ? API_CONST.ACCUMULATION_POLICY.NON_FIRE_MULTI
    : API_CONST.ACCUMULATION_POLICY.NON_FIRE_SINGLE;
}

const API526_ORIFICES = [
  { letter:"D", area:0.71 },{ letter:"E", area:1.27 },
  { letter:"F", area:1.98 },{ letter:"G", area:3.24 },
  { letter:"H", area:5.07 },{ letter:"J", area:8.30 },
  { letter:"K", area:11.05},{ letter:"L", area:15.32},
  { letter:"M", area:20.27},{ letter:"N", area:26.0 },
  { letter:"P", area:42.48},
];

function validateInputs(inp) {
  // OP(overpressure %)는 Equipment(Asset) 소유 필드 — Case가 임의 기본값을
  // 대입하지 않는다. 없으면 계산 자체를 막는다 (PRESSURE-001 계약).
  // Z(압축계수)는 반대로 Calculation Input(Case 소유) — 기본값 1.00은
  // UI가 명시적으로 대입하며, Engine은 몰래 채우지 않는다 (COMPRESSIBILITY-001).
  const fields = ["W","P1","P2","T","M","k","Kd","Kb","mawp","OP","Z"];
  for (const f of fields) {
    const v = Number(inp[f]);
    if (isNaN(v) || !isFinite(v)) return { ok: false, field: f, reason: "not_a_number" };
  }
  if (inp.P1 <= 0) return { ok: false, field:"P1", reason:"must_be_positive" };
  if (inp.T  <= 0) return { ok: false, field:"T",  reason:"must_be_positive" };
  if (inp.M  <= 0) return { ok: false, field:"M",  reason:"must_be_positive" };
  if (inp.k  <= 1) return { ok: false, field:"k",  reason:"must_be_gt_1" };
  if (inp.Kd <= 0) return { ok: false, field:"Kd", reason:"must_be_positive" };
  if (inp.Kb <= 0) return { ok: false, field:"Kb", reason:"must_be_positive" };
  if (inp.OP <  0) return { ok: false, field:"OP", reason:"must_be_non_negative" };
  if (inp.Z  <= 0) return { ok: false, field:"Z",  reason:"must_be_positive" };
  // VALVE-TYPE-001: valveType은 선택적 필드 — 없으면 SPRING(안전측)으로
  // 처리하되(하위호환), 값이 있는데 정책 테이블에 없는 값이면 오타/오입력
  // 가능성이 크므로 거부한다.
  if (inp.valveType !== undefined && inp.valveType !== null && inp.valveType !== "") {
    const vt = String(inp.valveType).toUpperCase();
    if (!(vt in API_CONST.BACKPRESSURE_POLICY)) {
      return { ok: false, field:"valveType", reason:"unsupported_valve_type" };
    }
  }
  // ACCUMULATION-001: valveCount/fireScenario도 선택적 — 없으면 안전측
  // 기본값(단일 밸브·비화재)으로 처리하되, 값이 있는데 형식이 틀리면 거부.
  if (inp.valveCount !== undefined && inp.valveCount !== null && inp.valveCount !== "") {
    const vc = Number(inp.valveCount);
    if (!Number.isFinite(vc) || !Number.isInteger(vc) || vc < 1) {
      return { ok: false, field:"valveCount", reason:"must_be_positive_integer" };
    }
  }
  if (inp.fireScenario !== undefined && inp.fireScenario !== null && typeof inp.fireScenario !== "boolean") {
    return { ok: false, field:"fireScenario", reason:"must_be_boolean" };
  }
  return { ok: true };
}

// Engine — 입력만 받고 출력만 반환. 외부 state 접근 금지.
function api520Engine(inp, deviceType) {
  const valid = validateInputs(inp);
  if (!valid.ok) return { valid: false, error: valid };

  const { W, P1, P2, T, M, k, Kd, Kb, mawp, OP, Z } = Object.fromEntries(
    Object.entries(inp).map(([key, v]) => [key, Number(v)])
  );
  // VALVE-TYPE-001: valveType은 문자열 Case 입력 — 위 숫자 변환 대상에서 제외.
  const valveType = String(inp.valveType || "SPRING").toUpperCase();
  const allowableBackpressureRatio = getAllowableBackpressureRatio(valveType);

  // ACCUMULATION-001: valveCount/fireScenario도 숫자 일괄변환 대상에서 제외
  // (fireScenario는 boolean, valveCount는 정수 개수 — 물리량이 아님).
  const valveCount   = (inp.valveCount !== undefined && inp.valveCount !== null && inp.valveCount !== "")
    ? Number(inp.valveCount) : 1;
  const fireScenario = inp.fireScenario === true;
  const allowableAccumulationRatio = getAllowableAccumulationRatio(fireScenario, valveCount);

  // ── COMPRESSIBILITY-001: Z는 Asset이 아니라 Calculation Input ──
  // 설비 속성이 아니라 유체·운전조건에 따라 케이스마다 달라지는 계산
  // 조건이므로 Equipment/DischargeSystem이 아닌 Case 입력값으로 취급한다.
  // 기본값 1.0(이상기체 가정)은 UI에서 명시적으로 노출하며, Engine은
  // 몰래 대입하지 않는다 — validateInputs에서 누락 시 계산을 막는다.

  // ── PRESSURE-001: relieving pressure(절대압) 산정 ──────────────
  // P1(입력) = 설정압력(barg, Equipment.setPressure). 이것 자체는
  // relieving pressure가 아니다. API 520 정의대로 overpressure(%)와
  // 대기압을 더해 절대압으로 환산한 뒤에만 sizing 식에 사용한다.
  const Pset  = P1;
  const P1abs = Pset * (1 + OP / 100) + API_CONST.ATM_PRESSURE_BAR; // bara
  const P1_kPa = P1abs * 100;

  const C     = API_CONST.C_BASE * Math.sqrt(k * Math.pow(2/(k+1), (k+1)/(k-1)));
  const KdEff = deviceType === "ruptureDisk" ? Kd * API_CONST.RD_KD_FACTOR : Kd;

  // ── API520-SI-001: SI 단위 필수 변환상수(13160) 적용 ───────────
  // A[mm²] = 13160·W[kg/h] / (C·Kd·P1[kPa]·Kb) · √(T·Z/M)
  const A_mm2   = (API_CONST.SI_AREA_CONST * W / (C * KdEff * P1_kPa * Kb)) * Math.sqrt((T * Z) / M);
  const areaCm2 = A_mm2 / 100;

  const selected = API526_ORIFICES.find(o => o.area >= areaCm2)
    ?? { letter:"P+", area: areaCm2, nonStandard: true };

  const margin            = selected.area / areaCm2;
  // 배압비(Kb 산정 기준)는 API 520 Fig.30/31 관례대로 게이지압 기준 유지 —
  // 절대압 환산과는 별개 개념 (relieving pressure 산정과 혼동 금지).
  const backPressureRatio = P2 / Pset;
  const criticalPressRatio= Math.pow(2/(k+1), k/(k-1));

  // ── ACCUMULATION-001: 축적압력 허용성 검증 (sizing과는 별개 관심사) ──
  // 위 RELIEVING_PRESSURE 단계의 OP는 P1abs(분출압력) 산정에 쓰인다 —
  // "이 압력에서 오리피스를 얼마나 크게 잡을지"의 입력값이다.
  // 여기서는 같은 OP 값을 다른 질문에 쓴다 — "이 축적압력(100+OP%)이
  // 이 시나리오(밸브개수·화재여부)에서 허용되는 상한을 넘는가?"라는
  // 별도의 정책 검증이며, sizing 결과(areaCm2/orifice)에는 영향을 주지
  // 않는다. 초과해도 자동으로 OP를 낮추지 않는다 — NO-GO만 표시한다.
  const actualAccumulationRatio = 1 + OP / 100;
  const accumulationOK = actualAccumulationRatio <= allowableAccumulationRatio;

  const checklist = {
    capacityOK:     selected.area >= areaCm2,
    backPressureOK: backPressureRatio < allowableBackpressureRatio,
    mawpOK:         Pset <= mawp,
    kdOK:           Kd >= API_CONST.KD_MIN,
    marginOK:       margin >= API_CONST.MARGIN_MIN,
    accumulationOK,
  };

  // ── Calculation Trace — 감사/Report Evidence 전용, UI 표시용 아님 ──
  const trace = [
    { step: "COMPRESSIBILITY_Z", value: Z, unit: "",
      formula: Z === 1.0 ? "User Input (default 1.00)" : "User Input", inputs: { Z } },
    { step: "SET_PRESSURE",     value: Pset,   unit: "barg", formula: "Equipment.setPressure" },
    { step: "RELIEVING_PRESSURE", value: P1abs, unit: "bara",
      formula: "P1abs = Pset×(1+OP/100) + Patm", inputs: { Pset, OP, Patm: API_CONST.ATM_PRESSURE_BAR } },
    { step: "C_COEFFICIENT",    value: C,      unit: "",     formula: "C = 520·√(k·(2/(k+1))^((k+1)/(k-1)))", inputs: { k } },
    { step: "MASS_FLUX_AREA",   value: A_mm2,  unit: "mm²",
      formula: "A = 13160·W/(C·Kd·P1[kPa]·Kb)·√(TZ/M)", inputs: { W, KdEff, P1_kPa, Kb, T, Z, M } },
    { step: "REQUIRED_AREA",    value: areaCm2, unit: "cm²", formula: "areaCm2 = A_mm2 / 100" },
    { step: "ORIFICE_SELECTION",value: selected.letter, unit: "", formula: "next API526 orifice ≥ areaCm2", inputs: { areaCm2, selectedArea: selected.area } },
    { step: "BACKPRESSURE_POLICY", value: allowableBackpressureRatio, unit: "",
      formula: "valveType → KOSHA GUIDE D-18-2020 §7.2(4) 허용비율",
      inputs: { valveType, allowableRatio: allowableBackpressureRatio, source: API_CONST.BACKPRESSURE_POLICY_SOURCE } },
    { step: "ACCUMULATION_POLICY", value: allowableAccumulationRatio, unit: "",
      formula: "fireScenario+valveCount → KOSHA D-18-2020 §4.4 <표1> 허용 축적압력",
      inputs: { fireScenario, valveCount, allowableRatio: allowableAccumulationRatio, source: API_CONST.ACCUMULATION_POLICY_SOURCE } },
    { step: "ACCUMULATION_GUARDRAIL", value: actualAccumulationRatio, unit: "",
      formula: "실제 축적압력비 = 1 + OP/100 (RELIEVING_PRESSURE의 OP와 동일 값, 다른 검증 목적)",
      inputs: { OP, actualRatio: actualAccumulationRatio, allowableRatio: allowableAccumulationRatio, ok: accumulationOK } },
  ];

  const stepData = {
    fluid:     { M, T, k, Z, criticalPressRatio },
    cCoeff:    { C, k },
    pressure:  { Pset, OP, P1abs, atm: API_CONST.ATM_PRESSURE_BAR },
    orifice:   { areaCm2, W, P1abs, KdEff, Kb, isRD: deviceType === "ruptureDisk" },
    selection: { selected, areaCm2, margin },
    backpress: { ratio: backPressureRatio, valveType, allowableRatio: allowableBackpressureRatio, source: API_CONST.BACKPRESSURE_POLICY_SOURCE },
    accumulation: { fireScenario, valveCount, allowableRatio: allowableAccumulationRatio,
      actualRatio: actualAccumulationRatio, ok: accumulationOK, OP, source: API_CONST.ACCUMULATION_POLICY_SOURCE },
  };

  return { valid: true, areaCm2, selected, margin, C, P1abs, backPressureRatio, checklist, stepData, trace };
}

// ════════════════════════════════════════════════════════════════
