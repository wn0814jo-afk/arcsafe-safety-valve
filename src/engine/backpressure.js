//  BACKPRESSURE ENGINE (API 521 minimal model, pure, stateless)
//  Kb는 입력값이 아니라 배출 시스템 설계의 결과값이다.
// ════════════════════════════════════════════════════════════════
const BP_CONST = {
  G:              9.80665,   // m/s²
  EXIT_K:         0.5,       // exit loss coefficient
  CHOKED_RATIO:   0.528,     // 임계압력비 근사 (k≈1.3 평균) — 실제는 fluid k로 재계산
  DARCY_F_DEFAULT:0.02,      // 기본 마찰계수 (turbulent, commercial steel 근사)
};

// 배관 형상 입력 — InputView에서 사용자가 결정하는 "물리적 사실"
// (계산값이 아니라 실제 배관 도면 기준 입력)
// FRICTION-LOSS-001: L/D/fittingsK 3개는 배출측(DischargeSystem)과
// 인입측(Equipment.inletPiping) 모두가 공유하는 순수 배관형상 계약 —
// validatePipeGeometry()가 단일 출처. headerPressure는 배출측 전용
// (정적 배압, superimposed backpressure)이라 별도로 검증한다.
function validatePipeGeometry(geo) {
  const fields = ["L", "D", "fittingsK"];
  for (const f of fields) {
    const v = Number(geo?.[f]);
    if (isNaN(v) || !isFinite(v)) return { ok:false, field:f, reason:"not_a_number" };
  }
  if (geo.D <= 0) return { ok:false, field:"D", reason:"must_be_positive" };
  if (geo.L <  0) return { ok:false, field:"L", reason:"must_be_non_negative" };
  if (geo.fittingsK < 0) return { ok:false, field:"fittingsK", reason:"must_be_non_negative" };
  return { ok:true };
}

function validateGeometry(geo) {
  const pipeValid = validatePipeGeometry(geo);
  if (!pipeValid.ok) return pipeValid;
  const hp = Number(geo?.headerPressure);
  if (isNaN(hp) || !isFinite(hp)) return { ok:false, field:"headerPressure", reason:"not_a_number" };
  if (hp < 0) return { ok:false, field:"headerPressure", reason:"must_be_non_negative" };
  return { ok:true };
}

// 유체 밀도 근사 (ideal gas, P[bar]→Pa, T[K], M[g/mol])
// rho = P*M / (R*T) — R = 8314 J/(kmol·K)
function gasDensity(P_bar, T_K, M_gmol) {
  const P_Pa = P_bar * 1e5;
  const R = 8314; // J/(kmol·K), M은 g/mol = kg/kmol 이므로 그대로 사용
  return (P_Pa * M_gmol) / (R * T_K); // kg/m³
}

// ── computeFrictionLoss ─────────────────────────────────────────
// FRICTION-LOSS-001: 배관 "마찰+fittings" 압력손실의 유일한 물리 계산
// 코어 — Darcy-Weisbach(동압×f×L/D) + fittings(동압×ΣK). 배출측 전용
// 개념(exit loss, 정적 헤더압, Kb, choked flow)은 이 함수에 넣지 않는다
// — computeBackpressure()가 이 함수의 결과 위에 자신만의 정책을 얹는다.
// 인입측(inlet loss)도 동일하게 이 함수만 호출하고 자신만의 정책
// (KOSHA 3% 기준)을 별도로 얹는다 — 물리 계산 코드가 두 곳에 복제되지
// 않는다.
//
// 입력: W(kg/h), T(K), M(g/mol), P_ref(barg — 밀도 산정 기준압력,
//       배출측은 Pset, 인입측도 Pset 재사용), L(m), D(m), fittingsK(ΣK)
// 출력: rho(kg/m³), velocity(m/s), 동압/마찰/fittings 손실 — Pa(원값)와
//       bar(반올림 표시값) 둘 다 반환. Pa 원값은 상위 계산(exit loss 합산
//       등)에서 반올림 오차 누적 없이 그대로 이어 쓸 수 있게 하기 위함.
function computeFrictionLoss({ W, T, M, P_ref, L, D, fittingsK }) {
  const geoValid = validatePipeGeometry({ L, D, fittingsK });
  if (!geoValid.ok) {
    return { valid:false, error: geoValid };
  }
  const Wn = Number(W), Tn = Number(T), Mn = Number(M), Pn = Number(P_ref);
  if ([Wn,Tn,Mn,Pn].some(v => isNaN(v) || !isFinite(v))) {
    return { valid:false, error:{ field:"W|T|M|P_ref", reason:"not_a_number" } };
  }
  if (Pn <= 0) return { valid:false, error:{ field:"P_ref", reason:"must_be_positive" } };

  // UNIT-PRESSURE-002: 대기압 상수는 api520.js API_CONST.ATM_PRESSURE_BAR
  // 단일 출처. 여기서는 OP를 더하지 않는다 — sizing용 relieving pressure
  // (P1abs)와 별개의, 배관 유속/밀도 계산 전용 근사(의도적).
  const P_ref_abs = Pn + API_CONST.ATM_PRESSURE_BAR;
  const rho = gasDensity(P_ref_abs, Tn, Mn); // kg/m³

  const W_kgs = Wn / 3600;
  const A = Math.PI * (D * D) / 4;
  const v = A > 0 ? W_kgs / (rho * A) : 0;

  const dynHead_Pa = rho * v * v / 2;
  const dP_pipe_Pa = D > 0 ? BP_CONST.DARCY_F_DEFAULT * (L / D) * dynHead_Pa : 0;
  const dP_fit_Pa  = fittingsK * dynHead_Pa;
  const totalFrictionLoss_Pa = dP_pipe_Pa + dP_fit_Pa;

  return {
    valid: true,
    rho_kgm3:   rho,
    velocity_ms: v,
    frictionFactor: BP_CONST.DARCY_F_DEFAULT,
    L_over_D: D > 0 ? L / D : 0,
    // Pa 원값 — 상위 함수가 다른 손실항과 합산 후 한 번에 반올림할 때 사용
    dynamicHead_Pa: dynHead_Pa,
    dP_pipe_Pa,
    dP_fit_Pa,
    totalFrictionLoss_Pa,
    // bar 반올림 표시값 — 그대로 evidence/PDF에 노출해도 되는 값
    rho_kgm3_r:    Math.round(rho * 100) / 100,
    velocity_ms_r: Math.round(v * 100) / 100,
    dP_pipe_bar:   Math.round(dP_pipe_Pa / 1e5 * 10000) / 10000,
    dP_fit_bar:    Math.round(dP_fit_Pa  / 1e5 * 10000) / 10000,
    totalFrictionLoss_bar: Math.round(totalFrictionLoss_Pa / 1e5 * 10000) / 10000,
  };
}

// ── computeBackpressure ───────────────────────────────────────
// 입력:
//   W           방출량 kg/h
//   P1          설정압 barg (set pressure)
//   T           방출 온도 K
//   M           분자량 g/mol
//   k           비열비
//   geometry: { L, D, fittingsK, headerPressure }
//     L              배관 길이 m
//     D              배관 내경 m
//     fittingsK      fittings K-factor 합산 (elbow, tee, reducer 등)
//     headerPressure flare/header 정상 압력 barg (superimposed backpressure)
//
// 출력: { p_static, p_dynamic, p_total, kb, velocity, choked, status, basis }
function computeBackpressure(inp, geometry) {
  const geoValid = validateGeometry(geometry);
  if (!geoValid.ok) {
    return { valid:false, error: geoValid };
  }

  const W  = Number(inp.W);   // kg/h
  const P1 = Number(inp.P1);  // barg (set pressure)
  const T  = Number(inp.T);   // K
  const M  = Number(inp.M);   // g/mol
  const k  = Number(inp.k);

  if (!P1 || P1 <= 0) {
    return { valid:false, error:{ field:"P1", reason:"must_be_positive" } };
  }

  const { L, D, fittingsK, headerPressure } = geometry;

  // ── FRICTION-LOSS-001: 마찰+fittings 손실은 공용 계산부로 위임 ──
  // (P1_abs/rho 계산은 computeFrictionLoss 내부에서 동일하게 수행됨)
  const fric = computeFrictionLoss({ W, T, M, P_ref: P1, L, D, fittingsK });
  if (!fric.valid) {
    return { valid:false, error: fric.error };
  }
  const P1_abs = P1 + API_CONST.ATM_PRESSURE_BAR;
  const rho = fric.rho_kgm3;
  const v = fric.velocity_ms;

  // ── Choked flow 판정 (배출측 전용 정책 — 공용 계산부에 없음) ──
  // 임계압력비 = (2/(k+1))^(k/(k-1))
  const criticalRatio = Math.pow(2/(k+1), k/(k-1));
  const pressureRatio = headerPressure > 0 ? (headerPressure + API_CONST.ATM_PRESSURE_BAR) / P1_abs : 0;
  const choked = pressureRatio <= criticalRatio;

  // ── 동적 배압 = 공용 마찰손실(Pa 원값) + exit loss(배출측 전용) ──
  const dP_exit_Pa   = BP_CONST.EXIT_K * fric.dynamicHead_Pa;
  const p_dynamic_Pa = fric.dP_pipe_Pa + fric.dP_fit_Pa + dP_exit_Pa;
  const p_dynamic_bar = p_dynamic_Pa / 1e5;

  // ── 정적 배압 (header/flare 압력, 배출측 전용) ──
  const p_static = headerPressure;

  // ── 합산 + Kb ──
  const p_total = p_static + p_dynamic_bar;
  const kb = P1 > 0 ? Math.max(0, 1 - (p_total / P1) * 0.5) : 1.0;
  // 참고: 정밀 Kb 곡선은 API 520 Fig.31 실측 데이터 기반이며
  // 위 식은 P_total/P_set 비율에 대한 1차 근사. 정밀 설계는 제조사 곡선 사용 권장.

  const ratio = p_total / P1;
  let status, basis;
  if (ratio < 0.10) {
    status = "calculated";
    basis = `P_total/P1 = ${(ratio*100).toFixed(1)}% — 배압 영향 미미. 표준 스프링식 적용 가능.`;
  } else if (ratio < 0.30) {
    status = "calculated";
    basis = `P_total/P1 = ${(ratio*100).toFixed(1)}% — 동적+정적 배압 합산 결과. Kb 보정 적용됨 (Pipe ΔP=${(fric.dP_pipe_Pa/1e5).toFixed(3)}bar, Fittings ΔP=${(fric.dP_fit_Pa/1e5).toFixed(3)}bar, Exit ΔP=${(dP_exit_Pa/1e5).toFixed(3)}bar).`;
  } else {
    status = "out_of_range";
    basis = `P_total/P1 = ${(ratio*100).toFixed(1)}% — 스프링식 적용 범위(30%) 초과. 파일럿식 전환 또는 배관 재설계 검토 필요.`;
  }
  if (choked) {
    basis += ` [Choked flow 감지: 임계압력비 ${(criticalRatio*100).toFixed(1)}% 이하 — 음속 유동 구간]`;
  }

  return {
    valid: true,
    p_static:  Math.round(p_static  * 1000) / 1000,
    p_dynamic: Math.round(p_dynamic_bar * 1000) / 1000,
    p_total:   Math.round(p_total   * 1000) / 1000,
    kb:        Math.round(kb * 1000) / 1000,
    velocity:  Math.round(v * 100) / 100,
    choked,
    criticalRatio: Math.round(criticalRatio * 1000) / 1000,
    breakdown: {
      dP_pipe_bar:  Math.round(fric.dP_pipe_Pa/1e5 * 1000) / 1000,
      dP_fit_bar:   Math.round(fric.dP_fit_Pa /1e5 * 1000) / 1000,
      dP_exit_bar:  Math.round(dP_exit_Pa/1e5 * 1000) / 1000,
      rho_kgm3:     Math.round(rho * 100) / 100,
    },
    status,
    basis,
  };
}
