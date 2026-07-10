//  EVIDENCE LAYER — Engine stepData → 근거 텍스트
// ════════════════════════════════════════════════════════════════
function buildEvidence(sd) {
  if (!sd) return [];
  const { fluid, cCoeff, pressure, orifice, selection, backpress } = sd;
  return [
    {
      id:1, title:"유체 물성 확인",
      formula:"M, T, k 입력값 확인",
      result:`M = ${fluid.M} g/mol | T = ${fluid.T} K | k = ${fluid.k}`,
      detail:`비열비 k=${fluid.k} 기준 임계압력비 = (2/(k+1))^(k/(k-1)) = ${fluid.criticalPressRatio.toFixed(4)}`,
      ok:true,
    },
    {
      id:2, title:"Relieving Pressure(절대압) 산정",
      formula:"P1(abs) = Pset × (1 + OP/100) + P(atm)",
      result:`P1abs = ${pressure.P1abs.toFixed(4)} bara`,
      detail:`설정압 Pset=${pressure.Pset} barg, Overpressure OP=${pressure.OP}% (설비대장 값), 대기압=${pressure.atm} bar. Case 입력값이 아니라 Asset(Equipment) 소유 필드에서 산정.`,
      ok: pressure.P1abs > 0,
    },
    {
      id:3, title:"C 계수 계산 (API 520)",
      formula:`C = ${API_CONST.C_BASE} × √( k × (2/(k+1))^((k+1)/(k-1)) )`,
      result:`C = ${cCoeff.C.toFixed(2)}`,
      detail:`k=${cCoeff.k}일 때 API 520 기준 C계수 = ${cCoeff.C.toFixed(2)}. 이 값이 클수록 동일 면적에서 더 많은 유량 방출 가능.`,
      ok:true,
    },
    {
      id:4, title:"필요 오리피스 면적 (SI 단위)",
      formula:"A[mm²] = 13160 × W / (C × Kd_eff × P1abs[kPa] × Kb) × √(T×Z / M)",
      result:`A_required = ${orifice.areaCm2.toFixed(4)} cm²`,
      detail:`W=${orifice.W} kg/h, P1abs=${orifice.P1abs.toFixed(3)} bara, Kd_eff=${orifice.KdEff.toFixed(3)}, Kb=${orifice.Kb}${orifice.isRD ? ` (럽처디스크 보정계수 ×${API_CONST.RD_KD_FACTOR} 적용)` : ""}`,
      ok: orifice.areaCm2 > 0,
    },
    {
      id:5, title:"API 526 표준 오리피스 선정",
      formula:"A_selected ≥ A_required",
      result:`${selection.selected.letter} 오리피스 | ${selection.selected.area} cm² ≥ ${selection.areaCm2.toFixed(4)} cm²${selection.selected.nonStandard ? " ⚠ 비표준" : ""}`,
      detail:`여유율 = ${selection.margin.toFixed(3)}×${selection.selected.nonStandard ? " — 표준 규격 초과. 특수 제작 또는 병렬 설치 검토 필요." : ""}`,
      ok: !selection.selected.nonStandard && selection.selected.area >= selection.areaCm2,
    },
    {
      id:6, title:"Back Pressure 검증",
      formula:`P2/Pset < ${(API_CONST.BACKPRESSURE_SPRING*100).toFixed(0)}% (스프링식) / ${(API_CONST.BACKPRESSURE_PILOT*100).toFixed(0)}% (파일럿식)`,
      result:`P2/Pset = ${(backpress.ratio*100).toFixed(1)}% → ${backpress.ratio < backpress.limitSpring ? "스프링식 적합 ✓" : backpress.ratio < backpress.limitPilot ? "파일럿식 검토 필요 ⚠" : "초과 ✗"}`,
      detail:`Back Pressure가 설정압력의 ${(backpress.limitSpring*100).toFixed(0)}% 초과 시 스프링식 용량 보정 필요(Kb). ${(backpress.limitPilot*100).toFixed(0)}% 초과 시 파일럿식 전환 검토.`,
      ok: backpress.ratio < backpress.limitPilot,
    },
  ];
}

// ════════════════════════════════════════════════════════════════
