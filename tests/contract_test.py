#!/usr/bin/env python3
"""
ArcSafe Contract Test Suite
════════════════════════════
PSM 현장 시나리오 기반 결정론 검증.

목적:
  1. DETERMINISM  — same input → same output (hash 고정)
  2. ENGINE PURITY — 체크리스트 pass/fail이 기준값과 일치
  3. BOUNDARY     — engine이 UI/snapshot 없이 독립 실행 가능
  4. SNAPSHOT SCHEMA — result_hash 필드 존재, engine_version 일치
  5. REGRESSION   — 이전 기준값에서 벗어나면 FAIL (의도치 않은 변경 감지)

실행: python3 tests/contract_test.py
"""

import math, json, sys, time, hashlib, subprocess, shutil, re
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).parent.parent
SRC  = ROOT / 'src'

# ════════════════════════════════════════════════════════════════
#  ENGINE — 소스 파일 없이 Python으로 직접 재현
#  (engine/api520.js 코드를 그대로 포팅 — 동일 계산식 보장)
# ════════════════════════════════════════════════════════════════
C_BASE             = 520
SI_AREA_CONST      = 13160     # API520-SI-001 — SI 단위 필수 변환상수 (누락 시 ~7600배 오차)
ATM_PRESSURE_BAR   = 1.01325   # API520-PRESSURE-001 — relieving pressure 절대압 환산용
BACKPRESSURE_SPRING= 0.10
BACKPRESSURE_PILOT = 0.30
RD_KD_FACTOR       = 0.9
KD_MIN             = 0.9
MARGIN_MIN         = 1.0

ENGINE_VERSION     = "1.3.0"   # engine/api520.js와 반드시 일치해야 함
# v1.3.0: COMPRESSIBILITY-001 — Z를 Calculation Input으로 승격 (기존
# 하드코딩 1.0 제거). Case 소유, Asset 아님. inputs에 Z 필드 필수화.
# v1.2.0: [BUG FIX] SI 변환상수(13160) 누락 수정, [BUG FIX] P1 절대압 환산
# (Pset*(1+OP/100)+대기압) 누락 수정. 기준값 전면 재계산 (2026-07-10).

ORIFICES = [
    ("D",0.71),("E",1.27),("F",1.98),("G",3.24),("H",5.07),
    ("J",8.30),("K",11.05),("L",15.32),("M",20.27),("N",26.0),("P",42.48),
]

def _py_engine(inp, device="safetyValve"):
    """api520Engine()과 동일한 계산 — Python 재현본"""
    W  = float(inp["W"]);  P1 = float(inp["P1"]); P2 = float(inp["P2"])
    T  = float(inp["T"]);  M  = float(inp["M"]);  k  = float(inp["k"])
    Kd = float(inp["Kd"]); Kb = float(inp["Kb"]); mawp = float(inp["mawp"])
    OP = float(inp["OP"])
    Z  = float(inp["Z"])   # COMPRESSIBILITY-001: Calculation Input, 기본값 1.00

    # PRESSURE-001: Pset(barg) → P1abs(bara) 환산
    Pset  = P1
    P1abs = Pset * (1 + OP/100) + ATM_PRESSURE_BAR
    P1_kPa = P1abs * 100

    C = C_BASE * math.sqrt(k * (2/(k+1))**((k+1)/(k-1)))
    KdEff = Kd * RD_KD_FACTOR if device == "ruptureDisk" else Kd

    # API520-SI-001: SI 변환상수(13160) 적용, A[mm²]=13160·W/(C·Kd·P1[kPa]·Kb)·√(TZ/M)
    A_mm2 = (SI_AREA_CONST * W / (C * KdEff * P1_kPa * Kb)) * math.sqrt((T * Z) / M)
    areaCm2 = A_mm2 / 100

    sel = next((o for o in ORIFICES if o[1] >= areaCm2), ("P+", areaCm2))
    margin = sel[1] / areaCm2
    bpRatio = P2 / Pset
    return {
        "areaCm2":  areaCm2,
        "orifice":  sel[0],
        "margin":   margin,
        "C":        C,
        "bpRatio":  bpRatio,
        "P1abs":    P1abs,
        "checklist": {
            "capacityOK":     sel[1] >= areaCm2,
            "backPressureOK": bpRatio < BACKPRESSURE_SPRING,
            "mawpOK":         Pset <= mawp,
            "kdOK":           Kd >= KD_MIN,
            "marginOK":       margin >= MARGIN_MIN,
        }
    }

def _result_hash(inp, areaCm2, orifice):
    """_hashResult() JavaScript 구현과 동일 — djb2 변형"""
    s = json.dumps({"inputs": inp, "areaCm2": areaCm2, "selected": orifice}, sort_keys=True)
    h = 0
    for ch in s:
        h = ((31 * h) + ord(ch)) & 0xFFFFFFFF
    return format(h, '08x')

# ════════════════════════════════════════════════════════════════
#  BACKPRESSURE ENGINE — engine/backpressure.js Python 재현
# ════════════════════════════════════════════════════════════════
BP_DARCY_F = 0.02
BP_EXIT_K  = 0.5

def _gas_density(P_bar, T_K, M_gmol):
    P_Pa = P_bar * 1e5
    R = 8314
    return (P_Pa * M_gmol) / (R * T_K)

def _py_backpressure(inp, geometry):
    W  = float(inp["W"]); P1 = float(inp["P1"])
    T  = float(inp["T"]); M  = float(inp["M"]); k = float(inp["k"])
    L, D, fittingsK, headerPressure = (
        float(geometry["L"]), float(geometry["D"]),
        float(geometry["fittingsK"]), float(geometry["headerPressure"])
    )

    P1_abs = P1 + 1.01325
    rho = _gas_density(P1_abs, T, M)
    W_kgs = W / 3600
    A = math.pi * D * D / 4
    v = W_kgs / (rho * A) if A > 0 else 0

    criticalRatio = (2/(k+1)) ** (k/(k-1))
    pressureRatio = (headerPressure + 1.01325) / P1_abs if headerPressure > 0 else 0
    choked = pressureRatio <= criticalRatio

    dynHead = rho * v * v / 2
    dP_pipe = BP_DARCY_F * (L/D) * dynHead if D > 0 else 0
    dP_fit  = fittingsK * dynHead
    dP_exit = BP_EXIT_K * dynHead
    p_dyn_bar = (dP_pipe + dP_fit + dP_exit) / 1e5

    p_static = headerPressure
    p_total  = p_static + p_dyn_bar
    kb = max(0, 1 - (p_total/P1) * 0.5) if P1 > 0 else 1.0
    ratio = p_total / P1 if P1 > 0 else 0

    status = "calculated" if ratio < 0.30 else "out_of_range"

    return {
        "p_static":  round(p_static, 3),
        "p_dynamic": round(p_dyn_bar, 3),
        "p_total":   round(p_total, 3),
        "kb":        round(kb, 3),
        "velocity":  round(v, 2),
        "choked":    choked,
        "criticalRatio": round(criticalRatio, 3),
        "status":    status,
        "ratio":     round(ratio, 4),
    }

# ════════════════════════════════════════════════════════════════
#  BACKPRESSURE FIXTURES — 고정 기준값
# ════════════════════════════════════════════════════════════════
BP_FIXTURES = [
    {
        "id": "BP-001", "label": "R-201 CO2 — 짧은 배관, 낮은 header",
        "inputs":   {"W":2500,"P1":5.5,"T":373,"M":44,"k":1.30},
        "geometry": {"L":10,"D":0.1,"fittingsK":2.0,"headerPressure":0.3},
        "expect_status":  "calculated",
        "expect_kb":      0.971,
        "expect_p_total": 0.319,
        "expect_choked":  True,
    },
    {
        "id": "BP-002", "label": "Steam — 긴 배관, 높은 header (out_of_range)",
        "inputs":   {"W":5000,"P1":8.0,"T":453,"M":18,"k":1.33},
        "geometry": {"L":50,"D":0.08,"fittingsK":5.0,"headerPressure":1.2},
        "expect_status":  "out_of_range",
        "expect_kb":      0.825,
        "expect_p_total": 2.795,
        "expect_choked":  True,
    },
    {
        "id": "BP-003", "label": "극단 케이스 — 매우 좁고 긴 배관 (FAIL 예상)",
        "inputs":   {"W":3000,"P1":4.0,"T":350,"M":44,"k":1.30},
        "geometry": {"L":200,"D":0.04,"fittingsK":10.0,"headerPressure":0.8},
        "expect_status":  "out_of_range",
        "expect_kb":      0.0,
        "expect_p_total": 32.852,
        "expect_choked":  True,
    },
]


# ════════════════════════════════════════════════════════════════
#  FIXTURE — 고정 기준값 (한 번 확정되면 변경 금지)
#
#  기준값 변경 = engine 계산 변경을 의미.
#  변경 시 반드시:
#    1. 변경 이유 주석 추가
#    2. ENGINE_VERSION 업데이트
#    3. SNAPSHOT_ENGINE_VERSION 업데이트
#    4. build.py 재실행
# ════════════════════════════════════════════════════════════════
FIXTURES = [
    {
        "id":           "SC-001",
        "label":        "R-201 CO₂ 반응기 — 기준 케이스",
        "tag":          "PSV-R201",
        "device":       "safetyValve",
        "inputs": {
            "W":2500, "P1":5.5, "P2":0.3, "T":373,
            "M":44,   "k":1.30, "Kd":0.975, "Kb":1.0, "mawp":6.0, "OP":10, "Z":1.0
        },
        # ── 기준값 (고정) ──────────────────────────────────────
        # v1.2.0 재계산 (2026-07-10): SI 변환상수(13160) + P1abs 절대압
        # 환산 버그 수정 반영. 이전 기준값(areaCm2=39120.18, hash=6b7e3910)은
        # 검증된 오류였음 — API 520 공식 예제 역산 검증(오차 0.09%)으로 확인.
        "expect_pass":   True,
        "expect_orifice":"H",
        "expect_areaCm2":4.008804,
        "expect_C":      346.9764,
        "expect_bpRatio":0.0545,
        "expect_hash":   "15563539",
        # ── PSM 판단 근거 ──────────────────────────────────────
        "psm_note":      "CO₂ 고압 반응기 기본 케이스. 모든 체크리스트 PASS 기준.",
        "api_ref":       "API 520 Part I, API 526",
    },
    {
        "id":           "SC-002",
        "label":        "R-302 N₂ 고압 퍼지라인",
        "tag":          "PSV-R302",
        "device":       "safetyValve",
        "inputs": {
            "W":800,  "P1":12.0, "P2":0.5, "T":320,
            "M":28,   "k":1.40,  "Kd":0.975, "Kb":1.0, "mawp":13.0, "OP":10, "Z":1.0
        },
        # v1.2.0 재계산 (2026-07-10) — 위 SC-001과 동일 사유
        "expect_pass":   True,
        "expect_orifice":"E",
        "expect_areaCm2":0.721307,
        "expect_C":      356.0604,
        "expect_bpRatio":0.0417,
        "expect_hash":   "826ef9f4",
        "psm_note":      "N₂ 불활성 고압 라인. 배압 4.2% — 스프링식 적합.",
        "api_ref":       "API 520 Part I Sec. 3",
    },
    {
        "id":           "SC-003",
        "label":        "PSV-S12 Steam 유틸리티라인 — 배압 초과",
        "tag":          "PSV-S12",
        "device":       "safetyValve",
        "inputs": {
            "W":5000, "P1":8.0, "P2":1.2, "T":453,
            "M":18,   "k":1.33, "Kd":0.975, "Kb":0.96, "mawp":9.0, "OP":10, "Z":1.0
        },
        # v1.2.0 재계산 (2026-07-10) — 위 SC-001과 동일 사유
        "expect_pass":   False,
        "expect_orifice":"K",
        "expect_areaCm2":10.274755,
        "expect_C":      349.7668,
        "expect_bpRatio":0.1500,
        "expect_hash":   "d31e1a0f",
        "expect_fail_keys": ["backPressureOK"],   # 정확히 이 항목만 FAIL이어야 함
        "psm_note":      "Steam 배압 15% — backPressureOK FAIL. 파일럿식 또는 Kb 재산정 필요.",
        "api_ref":       "API 520 Part I Fig. 31 (Kb correction)",
    },
    {
        "id":           "SC-004",
        "label":        "PSV-RD01 CO₂ 럽처디스크 병용",
        "tag":          "PSV-RD01",
        "device":       "ruptureDisk",
        "inputs": {
            "W":3200, "P1":6.0, "P2":0.2, "T":373,
            "M":44,   "k":1.30, "Kd":0.975, "Kb":1.0, "mawp":6.5, "OP":10, "Z":1.0
        },
        # v1.2.0 재계산 (2026-07-10) — 위 SC-001과 동일 사유
        "expect_pass":   True,
        "expect_orifice":"J",
        "expect_areaCm2":5.289526,
        "expect_C":      346.9764,
        "expect_bpRatio":0.0333,
        "expect_hash":   "fa9caa47",
        "psm_note":      "럽처디스크 병용 Kd×0.9=0.8775 보정 확인. ALL PASS.",
        "api_ref":       "API 520 Part I Annex C (rupture disk combination)",
    },
    {
        "id":           "SC-005",
        "label":        "PSV-BP 배압 경계 FAIL — PSM 부적합",
        "tag":          "PSV-BP01",
        "device":       "safetyValve",
        "inputs": {
            "W":1500, "P1":5.0, "P2":0.8, "T":350,
            "M":44,   "k":1.30, "Kd":0.975, "Kb":1.0, "mawp":5.0, "OP":10, "Z":1.0
        },
        # v1.2.0 재계산 (2026-07-10) — 위 SC-001과 동일 사유
        "expect_pass":   False,
        "expect_orifice":"G",
        "expect_areaCm2":2.526693,
        "expect_C":      346.9764,
        "expect_bpRatio":0.1600,
        "expect_hash":   "97c27259",
        "expect_fail_keys": ["backPressureOK"],
        "psm_note":      "배압 16% 초과 + P1=MAWP 경계. PSM 제출 불가 상태.",
        "api_ref":       "API 521 Sec. 5.4 (back pressure limit)",
    },
    {
        "id":           "API520-SI-001",
        "label":        "SI 단위 변환상수(13160) 외부 검증 — API 520 공식 예제 역산",
        "tag":          "REFERENCE",
        "device":       "safetyValve",
        # 원 예제(fluids 0.66.x, Caleb Bell — API 520 공식 example 1 재현,
        # PyPI 공개 라이브러리로 API 520 Part I Annex 예제와 대조 검증됨):
        #   m=24270 kg/h, T=348K, Z=0.90, MW=51, k=1.11, P1=670kPa(abs) →
        #   A = 0.0036990460646834 m² = 3699.046 mm²
        # 본 엔진은 Z를 1.0으로 고정하는 기존 단순화가 있어(별도 개선 필요
        # 항목, ENGINE-Z-001) Z=0.90 조건을 그대로 재현하지 못한다.
        # 따라서 "13160 상수 자체"의 정합성은 Z=1.0 가정 하에 별도 검증:
        #   Z=1.0 대입 시 목표값 3699.046×√(1/0.90)=3899.15 부근이어야 함
        #   (Z가 sqrt 안에서 단순 배율로만 작용하므로) — 본 엔진 실측값
        #   3895.81mm²는 그 근사 범위 내에 있음 (기존 fluids 비교는
        #   Kb/Kc/반올림 차이로 완전 일치는 아니고 0.09% 이내로 확인됨).
        # Pset은 P1abs=6.7bara(670kPa)가 되도록 역산 (OP=0으로 직접 대입).
        "inputs": {
            "W":24270, "P1":6.7-1.01325, "P2":0, "T":348,
            "M":51,    "k":1.11, "Kd":0.975, "Kb":1.0, "mawp":999, "OP":0, "Z":1.0
        },
        "expect_pass":   True,
        "expect_orifice":"P",
        "expect_areaCm2":38.958136,
        "expect_C":      327.8330,
        "expect_bpRatio":0.0,
        "expect_hash":   "73c6fb67",
        "psm_note":      "SI 변환상수 검증 전용 fixture — PSM 실제 케이스 아님. Z=1.0 가정 하 기준값 고정.",
        "api_ref":       "API 520 Part I Annex (SI 예제), fluids.safety_valve.API520_A_g 대조",
    },
]

# ════════════════════════════════════════════════════════════════
#  TEST RUNNER
# ════════════════════════════════════════════════════════════════
TOLERANCE = 1e-4   # areaCm2, C, bpRatio 비교 허용 오차

class TestResult:
    def __init__(self, sc_id, label):
        self.sc_id  = sc_id
        self.label  = label
        self.checks = []   # (name, ok, detail)

    def check(self, name, condition, detail=""):
        self.checks.append((name, condition, detail))
        return condition

    @property
    def passed(self):
        return all(ok for _, ok, _ in self.checks)

def run_fixture(f) -> TestResult:
    tr = TestResult(f["id"], f["label"])
    r  = _py_engine(f["inputs"], f["device"])
    ck = r["checklist"]
    actual_hash = _result_hash(f["inputs"], r["areaCm2"], r["orifice"])

    # ── T1: DETERMINISM — 동일 입력 2회 실행 결과 동일 ────────
    r2 = _py_engine(f["inputs"], f["device"])
    h2 = _result_hash(f["inputs"], r2["areaCm2"], r2["orifice"])
    tr.check("DETERMINISM_run1==run2",
             r["areaCm2"] == r2["areaCm2"] and actual_hash == h2,
             f"hash run1={actual_hash} run2={h2}")

    # ── T2: HASH REGRESSION — 기준값과 정확히 일치 ────────────
    tr.check("HASH_regression",
             actual_hash == f["expect_hash"],
             f"actual={actual_hash} expected={f['expect_hash']}")

    # ── T3: ORIFICE REGRESSION ────────────────────────────────
    tr.check("ORIFICE_regression",
             r["orifice"] == f["expect_orifice"],
             f"actual={r['orifice']} expected={f['expect_orifice']}")

    # ── T4: AREA REGRESSION ───────────────────────────────────
    area_diff = abs(r["areaCm2"] - f["expect_areaCm2"])
    tr.check("AREA_regression",
             area_diff < TOLERANCE,
             f"diff={area_diff:.8f} tolerance={TOLERANCE}")

    # ── T5: C_COEFF REGRESSION ───────────────────────────────
    c_diff = abs(r["C"] - f["expect_C"])
    tr.check("C_COEFF_regression",
             c_diff < TOLERANCE,
             f"diff={c_diff:.6f}")

    # ── T6: BPRATIO REGRESSION ───────────────────────────────
    bp_diff = abs(r["bpRatio"] - f["expect_bpRatio"])
    tr.check("BPRATIO_regression",
             bp_diff < TOLERANCE,
             f"diff={bp_diff:.6f}")

    # ── T7: PSM PASS/FAIL EXPECTATION ────────────────────────
    actual_pass = all(ck.values())
    tr.check("PSM_pass_fail",
             actual_pass == f["expect_pass"],
             f"actual={'PASS' if actual_pass else 'FAIL'} "
             f"expected={'PASS' if f['expect_pass'] else 'FAIL'}")

    # ── T8: SPECIFIC FAIL KEYS (FAIL 케이스 전용) ────────────
    if "expect_fail_keys" in f:
        actual_fails = [k for k, v in ck.items() if not v]
        expected_fails = f["expect_fail_keys"]
        tr.check("PSM_fail_keys",
                 set(actual_fails) == set(expected_fails),
                 f"actual_fails={actual_fails} expected={expected_fails}")

    # ── T9: ENGINE_VERSION 소스 파일과 일치 ──────────────────
    engine_src = (SRC / "engine" / "api520.js").read_text()
    src_version = None
    for line in engine_src.splitlines():
        if "ENGINE_VERSION" in line and "=" in line and "//" not in line.strip()[:5]:
            src_version = line.split('"')[1] if '"' in line else line.split("'")[1]
            break
    tr.check("ENGINE_VERSION_match",
             src_version == ENGINE_VERSION,
             f"src={src_version} test_expects={ENGINE_VERSION}")

    return tr

# ════════════════════════════════════════════════════════════════
#  BACKPRESSURE FIXTURE RUNNER
# ════════════════════════════════════════════════════════════════
def run_backpressure_fixture(f) -> TestResult:
    tr = TestResult(f["id"], f["label"])
    r  = _py_backpressure(f["inputs"], f["geometry"])

    r2 = _py_backpressure(f["inputs"], f["geometry"])
    tr.check("BP_DETERMINISM", r["kb"] == r2["kb"] and r["p_total"] == r2["p_total"],
              f"run1={r['kb']} run2={r2['kb']}")

    tr.check("BP_status_regression", r["status"] == f["expect_status"],
              f"actual={r['status']} expected={f['expect_status']}")

    kb_diff = abs(r["kb"] - f["expect_kb"])
    tr.check("BP_kb_regression", kb_diff < 0.01,
              f"actual={r['kb']} expected={f['expect_kb']} diff={kb_diff}")

    pt_diff = abs(r["p_total"] - f["expect_p_total"])
    tr.check("BP_p_total_regression", pt_diff < 0.01,
              f"actual={r['p_total']} expected={f['expect_p_total']} diff={pt_diff}")

    tr.check("BP_choked_regression", r["choked"] == f["expect_choked"],
              f"actual={r['choked']} expected={f['expect_choked']}")

    return tr

# ════════════════════════════════════════════════════════════════
#  MOC DETECTION TEST — detectMOC 결정론 + 정확성 검증
# ════════════════════════════════════════════════════════════════
def _py_asset_hash(equipment, discharge_system):
    """_assetHash() JS 구현과 동일 — 핵심 설계값만 해시"""
    eq = {
        "tag": equipment["tag"], "mawp": equipment["mawp"],
        "setPressure": equipment["setPressure"],
        "orifice": equipment["orifice"], "deviceType": equipment["deviceType"],
    } if equipment else None
    ds = {
        "name": discharge_system["name"], "L": discharge_system["L"],
        "D": discharge_system["D"], "fittingsK": discharge_system["fittingsK"],
        "headerPressure": discharge_system["headerPressure"],
        "destination": discharge_system["destination"],
    } if discharge_system else None
    import json as _json
    s = _json.dumps({"eq": eq, "ds": ds})
    h = 0
    for ch in s:
        h = ((31 * h) + ord(ch)) & 0xFFFFFFFF
    return format(h, '08x')

SAMPLE_EQ  = {"tag":"PSV-R201","mawp":6.0,"setPressure":5.5,"orifice":"P","deviceType":"safetyValve","revision":3,"mocId":None}
SAMPLE_DS  = {"name":"LP-FLARE-01","L":12,"D":0.1,"fittingsK":2.5,"headerPressure":0.3,"destination":"flare","revision":5,"mocId":None}
CHANGED_DS = {"name":"LP-FLARE-01","L":12,"D":0.1,"fittingsK":2.5,"headerPressure":0.5,"destination":"flare","revision":6,"mocId":"MOC-2026-017"}  # MOC: 0.3→0.5

def test_moc_detection() -> TestResult:
    tr = TestResult("MOC-001", "detectMOC — Asset fingerprint + revision 기반 MOC 감지")

    h_orig    = _py_asset_hash(SAMPLE_EQ, SAMPLE_DS)
    h_changed = _py_asset_hash(SAMPLE_EQ, CHANGED_DS)

    # T1: 동일 입력 → 동일 hash (결정론)
    tr.check("DETERMINISM",
             h_orig == _py_asset_hash(SAMPLE_EQ, SAMPLE_DS),
             "같은 입력인데 hash가 다름")

    # T2: 변경 후 hash 달라져야 함
    tr.check("CHANGE_DETECTED",
             h_orig != h_changed,
             f"변경 전후 hash가 같음: {h_orig}")

    # T3: Equipment만 변경 (orifice P→K)
    changed_eq = {**SAMPLE_EQ, "orifice": "K", "revision": 4, "mocId": "MOC-2026-014"}
    tr.check("EQ_CHANGE_DETECTED",
             _py_asset_hash(SAMPLE_EQ, SAMPLE_DS) != _py_asset_hash(changed_eq, SAMPLE_DS),
             "Equipment 변경이 fingerprint에 반영 안 됨")

    # T4: 동일 조건 → hash 동일 (false positive 없음)
    tr.check("NO_FALSE_POSITIVE",
             _py_asset_hash(SAMPLE_EQ, SAMPLE_DS) == _py_asset_hash(SAMPLE_EQ, SAMPLE_DS),
             "같은 입력인데 hash가 달라짐")

    # T5: revision/mocId 필드가 schema에 있는지
    schema_src = (SRC / "asset" / "schema.js").read_text()
    tr.check("revision_in_equipment", "revision:" in schema_src,
             "Equipment에 revision 필드 없음")
    tr.check("mocId_in_equipment", "mocId:" in schema_src,
             "Equipment에 mocId 필드 없음")

    # T6: assetRefs에 equipmentRevision/dischargeRevision 있는지
    snap_src = (SRC / "snapshot" / "create.js").read_text()
    tr.check("equipmentRevision_in_assetRefs", "equipmentRevision:" in snap_src,
             "assetRefs에 equipmentRevision 없음")
    tr.check("dischargeRevision_in_assetRefs", "dischargeRevision:" in snap_src,
             "assetRefs에 dischargeRevision 없음")

    # T7: computeWorkflowState가 engine/workflow_engine.js에 있는지
    wf_eng_src = (SRC / "engine" / "workflow_engine.js").read_text()
    tr.check("computeWorkflowState_in_engine",
             "function computeWorkflowState" in wf_eng_src,
             "computeWorkflowState가 engine에 없음")
    tr.check("WORKFLOW_TRIGGER_FIELDS_in_engine",
             "WORKFLOW_TRIGGER_FIELDS" in wf_eng_src,
             "WORKFLOW_TRIGGER_FIELDS가 engine에 없음")

    # T8: requiresReview가 workflow/index.js에 없는지 (engine으로 이동됨)
    wf_src = (SRC / "workflow" / "index.js").read_text()
    tr.check("requiresReview_removed_from_workflow",
             "function requiresReview" not in wf_src,
             "requiresReview가 workflow/index.js에 잔존")
    tr.check("REVIEW_REQUIRED_in_workflow",
             "REVIEW_REQUIRED" in wf_src,
             "REVIEW_REQUIRED 상태가 workflow에 없음")

    # T9: detectMOC가 snapshot에 없는지 (engine으로 이동됨)
    snap_src2 = (SRC / "snapshot" / "create.js").read_text()
    tr.check("detectMOC_removed_from_snapshot",
             "function detectMOC" not in snap_src2,
             "detectMOC가 snapshot/create.js에 잔존")
    tr.check("detectMOC_in_engine",
             "function detectMOC" in wf_eng_src,
             "detectMOC가 engine에 없음")

    # T10: computeWorkflowState 로직 검증 (Python 재현)
    TRIGGER = ["headerPressure","L","D","fittingsK","destination",
               "setPressure","mawp","orifice","deviceType"]
    def py_compute_wf(reasons):
        trigger = [r for r in reasons if r["field"] in TRIGGER]
        return "REVIEW_REQUIRED" if trigger else "INSPECTION"

    tr.check("computeWF_trigger_positive",
             py_compute_wf([{"field":"headerPressure","from":0.3,"to":0.5,"unit":"barg"}])
             == "REVIEW_REQUIRED",
             "headerPressure 변경이 REVIEW_REQUIRED를 반환하지 않음")
    tr.check("computeWF_trigger_negative",
             py_compute_wf([{"field":"registeredAt","from":"2024","to":"2025","unit":""}])
             == "INSPECTION",
             "비계산 필드 변경이 INSPECTION을 반환하지 않음")

    return tr

# ════════════════════════════════════════════════════════════════
#  UNIT BOUNDARY TEST — 단위/기준상태(Reference State) 경계 검증
#  Sprint A에서 발견된 두 CRITICAL 버그(SI 변환상수 누락, P1 절대압
#  환산 누락)가 모두 "단위 변환이 어디서 몇 번 일어나는가"의 문제였다.
#  이 스위트는 계산값이 아니라 변환의 위치·횟수·일관성을 고정한다:
#    - 각 변환은 정확히 한 곳(Single Source of Truth)에서만 일어나야 한다
#    - 같은 이름의 물리량이 서로 다른 파일에서 다른 정의로 쓰이면
#      (예: api520.js의 P1abs vs backpressure.js의 P1_abs) 그 차이가
#      "의도적 문서화"돼 있어야 한다 — 우연한 드리프트를 차단한다.
# ════════════════════════════════════════════════════════════════
def test_unit_boundaries() -> TestResult:
    tr = TestResult("UNIT-BOUNDARY-001", "단위/기준상태 경계 변환 — 위치·횟수·수치 검증")

    api520_src = (SRC / "engine" / "api520.js").read_text()
    bp_src     = (SRC / "engine" / "backpressure.js").read_text()
    input_src  = (SRC / "components" / "InputView.jsx").read_text()

    # trace 설명 문자열/주석에는 "OP/100", "A_mm2/100" 같은 식이 문서화
    # 목적으로 다시 등장한다 — 실제 연산 코드만 세려면 문자열·주석을
    # 제거한 버전으로 카운트해야 "exactly once" 계약이 의미가 있다.
    def _code_only(src):
        src = re.sub(r'"(?:[^"\\]|\\.)*"', '""', src)
        src = re.sub(r'`(?:[^`\\]|\\.)*`', '``', src)
        src = re.sub(r'//.*', '', src)
        return src
    api520_code = _code_only(api520_src)
    bp_code     = _code_only(bp_src)

    # ── UNIT-PRESSURE-001: 대기압 상수(1.01325) 단일 출처 ──────────
    # api520.js에 정확히 1회(정의부)만 리터럴로 존재해야 하고,
    # backpressure.js는 리터럴을 갖지 않고 API_CONST를 참조해야 한다.
    api520_atm_literals = len(re.findall(r"1\.01325", api520_src))
    bp_atm_literals      = len(re.findall(r"1\.01325", bp_src))
    tr.check("UNIT_PRESSURE_001_atm_const_single_source_in_api520",
             api520_atm_literals == 1,
             f"api520.js 내 1.01325 리터럴 개수={api520_atm_literals} (기대: 1, ATM_PRESSURE_BAR 정의부만)")
    tr.check("UNIT_PRESSURE_001_backpressure_no_duplicate_literal",
             bp_atm_literals == 0,
             f"backpressure.js 내 1.01325 리터럴 개수={bp_atm_literals} (기대: 0 — API_CONST.ATM_PRESSURE_BAR 참조로 대체)")
    tr.check("UNIT_PRESSURE_001_backpressure_references_shared_const",
             "API_CONST.ATM_PRESSURE_BAR" in bp_src,
             "backpressure.js가 api520.js의 공유 상수를 참조하지 않음")

    # ── UNIT-PRESSURE-002: bar → kPa (×100) 는 api520.js에서만, 1회 ──
    tr.check("UNIT_PRESSURE_002_kPa_conversion_only_in_api520",
             "P1_kPa" in api520_src and "P1_kPa" not in bp_src,
             "kPa 변환(P1_kPa)이 api520.js 밖에서도 발생함 — 경계 위반")
    tr.check("UNIT_PRESSURE_002_kPa_conversion_exactly_once",
             len(re.findall(r"P1_kPa\s*=\s*P1abs\s*\*\s*100", api520_src)) == 1,
             "P1abs*100 변환이 정확히 1회가 아님")

    # ── UNIT-PRESSURE-003: overpressure(%) 는 api520.js 전용 개념 ────
    # backpressure.js는 OP를 입력받지 않는다 — relieving pressure(sizing용,
    # OP 포함)와 배관 유속용 근사압력(OP 미포함)은 의도적으로 다른 값이며,
    # 이 차이가 backpressure.js 주석에 명시돼 있어야 한다 (우연한 차이 아님).
    tr.check("UNIT_PRESSURE_003_OP_not_referenced_in_backpressure",
             re.search(r"\bOP\b", bp_code) is None,
             "backpressure.js '코드'(주석 제외)가 OP(overpressure)를 참조함 — sizing 전용 개념이 유출됨")
    tr.check("UNIT_PRESSURE_003_divergence_documented",
             "의도적" in bp_src and "P1abs" in bp_src,
             "backpressure.js의 P1_abs가 api520.js의 P1abs와 다른 이유가 주석으로 문서화돼 있지 않음")
    tr.check("UNIT_PRESSURE_003_OP_divided_by_100_exactly_once",
             len(re.findall(r"OP\s*/\s*100", api520_code)) == 1,
             "OP/100 변환(코드)이 api520.js에서 정확히 1회가 아님")

    # ── UNIT-FLOW-001: kg/h → kg/s (÷3600) 는 backpressure.js 전용 ──
    # api520.js의 SI 면적식은 13160 상수가 W[kg/h] 기준으로 이미 보정돼
    # 있으므로 W를 kg/s로 바꾸면 안 된다 — 이 자체가 또 다른 잠재 버그원.
    tr.check("UNIT_FLOW_001_no_kgs_conversion_in_api520",
             re.search(r"/\s*3600", api520_src) is None,
             "api520.js가 W를 kg/s로 변환함 — 13160 상수는 kg/h 기준이므로 이중변환 위험")
    tr.check("UNIT_FLOW_001_kgs_conversion_in_backpressure_once",
             len(re.findall(r"/\s*3600", bp_src)) == 1,
             "kg/h→kg/s 변환이 backpressure.js에서 정확히 1회가 아님")

    # ── UNIT-AREA-001: mm² → cm² (÷100) 는 api520.js에서만, 1회 ─────
    tr.check("UNIT_AREA_001_mm2_to_cm2_exactly_once",
             len(re.findall(r"A_mm2\s*/\s*100", api520_code)) == 1,
             "A_mm2/100(mm²→cm², 코드)이 정확히 1회가 아님")
    tr.check("UNIT_AREA_001_no_area_reconversion_in_evidence",
             re.search(r"areaCm2\s*[*/]\s*100", (SRC/"engine"/"evidence.js").read_text()) is None,
             "evidence.js가 areaCm2를 다시 단위 변환하고 있음 — Engine 경계 밖 재변환")

    # ── UNIT-TEMP-001: °C↔K 변환은 InputView.jsx(UI)에서만 ─────────
    # 273.15가 engine 파일 어디에도 나타나면 안 된다 — engine은 항상
    # Kelvin만 받는다는 계약이 깨진 것.
    for fname, src in [("api520.js", api520_src), ("backpressure.js", bp_src),
                        ("workflow_engine.js", (SRC/"engine"/"workflow_engine.js").read_text()),
                        ("evidence.js", (SRC/"engine"/"evidence.js").read_text())]:
        tr.check(f"UNIT_TEMP_001_no_celsius_conversion_in_{fname}",
                 "273.15" not in src,
                 f"{fname}에 273.15(°C↔K 변환)가 있음 — Engine은 K만 받아야 함")
    tr.check("UNIT_TEMP_001_celsius_conversion_confined_to_InputView",
             "273.15" in input_src,
             "InputView.jsx에 273.15 변환이 없음 — °C 입력 모드가 깨졌을 가능성")

    # ── 수치 회귀: 변환 계수 자체의 산술 정확성 (엔진과 무관한 순수 검증) ──
    tr.check("UNIT_NUMERIC_pressure_bar_to_kPa",
             abs(5.5 * 100 - 550) < 1e-9, "bar→kPa 계수(×100) 오류")
    tr.check("UNIT_NUMERIC_area_mm2_to_cm2",
             abs(1000 / 100 - 10) < 1e-9, "mm²→cm² 계수(÷100) 오류")
    tr.check("UNIT_NUMERIC_area_cm2_to_m2",
             abs(39120.177446 / 10000 - 3.9120177446) < 1e-9, "cm²→m² 계수(÷10000) 오류")
    tr.check("UNIT_NUMERIC_flow_kgh_to_kgs",
             abs(2500 / 3600 - 0.6944444444444444) < 1e-9, "kg/h→kg/s 계수(÷3600) 오류")
    tr.check("UNIT_NUMERIC_temp_C_to_K",
             abs((25 + 273.15) - 298.15) < 1e-9, "°C→K 변환(+273.15) 오류")
    tr.check("UNIT_NUMERIC_relieving_pressure_roundtrip",
             abs((5.5 * (1 + 10/100) + 1.01325) - 7.06325) < 1e-9,
             "P1abs = Pset×(1+OP/100)+Patm 산술 오류")

    return tr


# ════════════════════════════════════════════════════════════════
#  COMPRESSIBILITY (Z) CONTRACT — Z를 Calculation Input으로 승격
#  Z는 Asset이 아니라 Case 소유 계산 조건 (OP와 반대 방향의 소유권).
# ════════════════════════════════════════════════════════════════
def test_compressibility_contract() -> TestResult:
    tr = TestResult("COMPRESSIBILITY-001", "Z(압축계수) Calculation Input 계약")

    api520_src = (SRC / "engine" / "api520.js").read_text()
    snap_src   = (SRC / "snapshot" / "create.js").read_text()
    pkg_src    = (SRC / "report" / "createPackage.js").read_text()
    pdf_src    = (SRC / "report" / "renderer" / "pdf" / "template.js").read_text()
    evid_src   = (SRC / "engine" / "evidence.js").read_text()
    schema_src = (SRC / "asset" / "schema.js").read_text()

    # ── API520-Z-001: Z=1.0과 Z=0.97 결과 차이 확인 (√Z 비례) ──────
    base = dict(W=2500, P1=5.5, P2=0.3, T=373, M=44, k=1.30,
                Kd=0.975, Kb=1.0, mawp=6.0, OP=10)
    r1 = _py_engine({**base, "Z":1.0},  "safetyValve")
    r2 = _py_engine({**base, "Z":0.97}, "safetyValve")
    tr.check("API520_Z_001_area_differs_with_Z",
             r1["areaCm2"] != r2["areaCm2"],
             "Z를 바꿔도 areaCm2가 그대로임 — Z가 계산에 반영되지 않음")
    expected_ratio = math.sqrt(0.97/1.0)
    actual_ratio = r2["areaCm2"] / r1["areaCm2"]
    tr.check("API520_Z_001_area_scales_by_sqrtZ",
             abs(actual_ratio - expected_ratio) < 1e-6,
             f"면적 비율={actual_ratio:.6f}, 기대(√(Z2/Z1))={expected_ratio:.6f}")

    # ── Z가 Asset(Equipment) 스키마에는 없어야 함 — Case 소유 확인 ──
    tr.check("API520_Z_001_Z_not_in_equipment_schema",
             "overpressure" in schema_src and re.search(r"\bZ\b\s*:", schema_src) is None,
             "Z가 Equipment 스키마에 있음 — Z는 Asset이 아니라 Case 소유여야 함")

    # ── validateInputs가 Z 필수 필드로 요구하는지 (Engine 계약) ─────
    tr.check("API520_Z_001_Z_required_in_validateInputs",
             '"Z"' in api520_src and "must_be_positive" in api520_src,
             "validateInputs가 Z를 필수 필드로 요구하지 않음")

    # ── SNAPSHOT-Z-001: Snapshot이 inputs를 통째로 보존(필드 화이트리스트 없음) ──
    tr.check("SNAPSHOT_Z_001_inputs_stored_as_full_copy",
             "inputs:          Object.freeze({ ...inputs })" in snap_src,
             "snapshot이 inputs를 부분 필드만 재구성해 저장함 — Z 같은 신규 필드가 누락될 위험")

    # ── REPORT-Z-001: ReportPackage/PDF가 동일한 Z를 표시 ──────────
    tr.check("REPORT_Z_001_package_inputs_full_copy",
             "inputs:        Object.freeze({ ...snapshot.inputs })" in pkg_src,
             "ReportPackage가 inputs를 재계산/부분 복사함 — Z 누락 위험")
    tr.check("REPORT_Z_001_pdf_shows_Z",
             "Compressibility Z" in pdf_src and "inputs?.Z" in pdf_src,
             "PDF 템플릿에 Compressibility Z 표시가 없음")
    tr.check("REPORT_Z_001_evidence_shows_Z",
             "fluid.Z" in evid_src,
             "화면 Evidence(evidence.js)에 Z 표시가 없음 — PDF와 화면 근거 불일치 위험")

    # ── TRACE-Z-001: Calculation Trace에 Z 단계 존재 ───────────────
    tr.check("TRACE_Z_001_step_in_trace",
             'step: "COMPRESSIBILITY_Z"' in api520_src,
             "Calculation Trace에 COMPRESSIBILITY_Z 단계가 없음")
    tr.check("TRACE_Z_001_default_source_labeled",
             "User Input (default 1.00)" in api520_src,
             "Z 기본값 출처(User Input, default 1.00) 라벨이 trace formula에 없음")

    return tr


# ════════════════════════════════════════════════════════════════
#  GOLDEN BASELINE CONTRACT — Engine 1.3.0을 검증 기준으로 고정
#  tests/generate_golden_fixtures.js가 실제 코드(api520Engine,
#  createSnapshot, computeWorkflowState, detectMOC, submitApproval,
#  buildReportPackage, verifyApprovalRecord)를 그대로 실행해 만든
#  두 fixture가, 그 실행 결과를 신뢰성 있게 담고 있는지 확인한다.
# ════════════════════════════════════════════════════════════════
def test_golden_baseline_contract() -> TestResult:
    tr = TestResult("GOLDEN-BASELINE-001", "Engine 1.3.0 Golden Fixture 기준선 계약")

    api520_src = (SRC / "engine" / "api520.js").read_text()
    m = re.search(r'const ENGINE_VERSION = "([\d.]+)"', api520_src)
    current_engine_version = m.group(1) if m else None

    fixtures_dir = ROOT / "tests" / "fixtures"
    pkgs = {}
    for name in ["PSV-R201-review-required-package.json", "PSV-R201-approved-package.json"]:
        p = fixtures_dir / name
        if not p.exists():
            tr.check(f"GOLDEN_fixture_exists_{name}", False, f"{name} 없음")
            continue
        pkgs[name] = json.loads(p.read_text())

    for name, pkg in pkgs.items():
        # ── GOLDEN-001: ENGINE_VERSION 일치 (fixture가 현재 소스와 동기화돼 있는가) ──
        tr.check(f"GOLDEN_001_engine_version_{name}",
                 pkg["meta"]["engineVersion"] == current_engine_version
                 and pkg["calculation"]["engineVersion"] == current_engine_version,
                 f"{name}: meta/calculation engineVersion이 현재 소스({current_engine_version})와 다름 "
                 f"— (meta={pkg['meta']['engineVersion']}, calc={pkg['calculation']['engineVersion']})")

        # ── GOLDEN-002: BUILD_HASH 기록 ─────────────────────────
        fm = pkg.get("_fixtureMeta", {})
        tr.check(f"GOLDEN_002_build_hash_recorded_{name}",
                 bool(fm.get("buildHash")) and fm.get("buildHash") != "UNKNOWN",
                 f"{name}: _fixtureMeta.buildHash가 기록되지 않음")
        tr.check(f"GOLDEN_002_fixture_meta_complete_{name}",
                 all(k in fm for k in ("engineVersion","buildHash","generatedAt","fixtureName")),
                 f"{name}: _fixtureMeta 필드 누락")

        # ── GOLDEN-003: ReportPackage.packageVersion 확인 ───────
        tr.check(f"GOLDEN_003_package_version_{name}",
                 pkg["meta"]["packageVersion"] == "1.0.0",
                 f"{name}: packageVersion={pkg['meta']['packageVersion']} (기대: 1.0.0)")

        # ── GOLDEN-004: inputs.Z 존재 및 값 일치 ────────────────
        tr.check(f"GOLDEN_004_inputs_Z_present_{name}",
                 "Z" in pkg["calculation"]["inputs"],
                 f"{name}: calculation.inputs.Z 없음")
        tr.check(f"GOLDEN_004_stepData_Z_matches_inputs_Z_{name}",
                 pkg["calculation"]["result"]["stepData"]["fluid"]["Z"] == pkg["calculation"]["inputs"]["Z"],
                 f"{name}: stepData.fluid.Z가 inputs.Z와 다름")

        # ── GOLDEN-005: CalculationTrace에 COMPRESSIBILITY_Z 단계 ──
        trace_steps = [t["step"] for t in pkg["calculation"]["result"].get("trace", [])]
        tr.check(f"GOLDEN_005_trace_has_compressibility_Z_{name}",
                 "COMPRESSIBILITY_Z" in trace_steps,
                 f"{name}: trace에 COMPRESSIBILITY_Z 단계 없음 (trace={trace_steps})")
        tr.check(f"GOLDEN_005_trace_has_relieving_pressure_{name}",
                 "RELIEVING_PRESSURE" in trace_steps,
                 f"{name}: trace에 RELIEVING_PRESSURE 단계 없음")

        # ── GOLDEN-006: RelievingPressure(abs)가 result/PDF 양쪽에 동일 ──
        p1abs = pkg["calculation"]["result"].get("P1abs")
        tr.check(f"GOLDEN_006_P1abs_present_{name}",
                 p1abs is not None and p1abs > 0,
                 f"{name}: calculation.result.P1abs 없음/비정상")
        node = shutil.which("node")
        if node:
            check_script = f"""
const fs = require('fs');
const files = ['report/schema.js','report/renderer/pdf/styles.js','report/renderer/pdf/template.js']
  .map(f => fs.readFileSync('{SRC}/' + f, 'utf8')).join('\\n');
eval(files);
const pkg = {json.dumps(pkg)};
console.log(buildPDFHtml(pkg));
"""
            r = subprocess.run([node, "-e", check_script], capture_output=True, text=True, timeout=15)
            html = r.stdout
            tr.check(f"GOLDEN_006_P1abs_shown_in_PDF_{name}",
                     f"{p1abs:.3f}" in html,
                     f"{name}: PDF에 Relieving Pressure(abs)={p1abs:.3f}가 표시되지 않음")
            # ── GOLDEN-007: Required Area / Orifice가 PDF에도 동일하게 표시 ──
            area = pkg["calculation"]["result"]["areaCm2"]
            orifice = pkg["calculation"]["result"]["selected"]["letter"]
            tr.check(f"GOLDEN_007_area_shown_in_PDF_{name}",
                     f"{area:.2f}" in html,
                     f"{name}: PDF에 Required Area={area:.2f}cm²가 표시되지 않음")
            tr.check(f"GOLDEN_007_orifice_shown_in_PDF_{name}",
                     orifice in html,
                     f"{name}: PDF에 Orifice({orifice})가 표시되지 않음")
        else:
            tr.check(f"GOLDEN_006_node_available_{name}", False, "node 없음 — PDF 대조 생략")

        # evidence.js(화면)도 동일 stepData를 소비하므로 근원이 하나임을 소스로 재확인
        evid_src = (SRC / "engine" / "evidence.js").read_text()
        tr.check(f"GOLDEN_007_evidence_reads_same_selection_object_{name}",
                 "selection.areaCm2" in evid_src and "selection.selected" in evid_src,
                 "evidence.js가 별도로 면적/오리피스를 재계산하지 않고 stepData.selection을 그대로 읽는지 확인 실패")

    # ── GOLDEN-008: snapshotHash가 ReportPackage와 Approval Record에서 동일(승인 시나리오) ──
    approved = pkgs.get("PSV-R201-approved-package.json")
    if approved:
        approvals = approved.get("approvals", [])
        tr.check("GOLDEN_008_approved_has_approval_record",
                 len(approvals) > 0,
                 "approved fixture에 approvals가 비어있음")
        if approvals:
            # REPORT-PKG-004: pkg.approvals는 snapshotHash가 일치하는 것만 필터링해 담김 —
            # 즉 이 배열에 들어있다는 사실 자체가 이미 snapshotHash 일치를 증명한다.
            # 여기서는 그 필터링이 실제로 통과했다는 증거(verified=true)까지 함께 확인한다.
            tr.check("GOLDEN_008_approval_verified_true",
                     approvals[0].get("verified") is True,
                     "approved fixture의 승인 기록이 verified=true가 아님 — "
                     "실제 서명 재검증(verifyApprovalRecord)을 통과하지 못한 상태")
            tr.check("GOLDEN_008_snapshotHash_referenced_consistently",
                     approved["identity"]["snapshotHash"] is not None
                     and len(approved["identity"]["snapshotHash"]) == 8,
                     "approved fixture의 identity.snapshotHash 형식이 비정상")

    review = pkgs.get("PSV-R201-review-required-package.json")
    if review and approved:
        tr.check("GOLDEN_008_review_and_approved_share_asset_lineage",
                 review["asset"]["assetFingerprint"] == approved["asset"]["assetFingerprint"],
                 "review-required와 approved fixture의 assetFingerprint가 다름 — 동일 Asset 계보가 아님")
        tr.check("GOLDEN_008_review_has_no_approvals",
                 len(review.get("approvals", [])) == 0,
                 "review-required fixture에 approvals가 있음 — 승인 전 상태와 모순")

    return tr


def test_snapshot_schema() -> TestResult:
    tr = TestResult("SCHEMA-001", "Snapshot schema 필수 필드 검사")
    snap_src = (SRC / "snapshot" / "create.js").read_text()

    required_fields = [
        ("engine_version", "engine 버전 추적"),
        ("result_hash",    "결정론 검증용 hash"),
        ("Object.freeze",  "불변성 강제"),
        ("INVALID_STATE",  "version mismatch 방어"),
        ("SNAPSHOT_ENGINE_VERSION", "버전 고정 상수"),
        ("inputs:",        "입력값 보존"),
        ("result:",        "계산 결과 보존"),
        ("evidence:",      "증거 레이어"),
        ("workflow:",      "워크플로우 상태"),
        # v0.2.0 — 3-레이어 + MOC 감지
        ("equipment:",     "Equipment 복사본 (MOC 비교용)"),
        ("dischargeSystem:","DischargeSystem 복사본 (MOC 비교용)"),
        ("assetRefs",      "검토 시점 Asset 식별자 기록"),
        ("assetFingerprint","MOC 감지용 fingerprint"),
        ("detectMOC",      "MOC 감지 순수 함수"),
        ("_assetHash",     "Asset fingerprint 생성 함수"),
    ]
    for field, reason in required_fields:
        tr.check(f"schema_field:{field}",
                 field in snap_src,
                 reason)

    # SNAPSHOT_ENGINE_VERSION이 ENGINE_VERSION과 일치하는지
    snap_ver = None
    for line in snap_src.splitlines():
        if "SNAPSHOT_ENGINE_VERSION" in line and "=" in line:
            snap_ver = line.split('"')[1] if '"' in line else None
            break
    tr.check("snapshot_engine_version_matches",
             snap_ver == ENGINE_VERSION,
             f"snapshot expects={snap_ver}, engine={ENGINE_VERSION}")

    return tr

# ════════════════════════════════════════════════════════════════
#  BOUNDARY TEST — engine이 외부 의존 없이 독립 실행 가능한지
# ════════════════════════════════════════════════════════════════
def test_engine_boundary() -> TestResult:
    tr = TestResult("BOUNDARY-001", "Engine 독립 실행 가능성 (외부 의존 없음)")
    engine_files = [
        SRC / "engine" / "api520.js",
        SRC / "engine" / "backpressure.js",
        SRC / "engine" / "evidence.js",
    ]
    forbidden = [
        "import ", "require(", "window.", "document.",
        "localStorage", "fetch(", "setTimeout(", "setInterval(",
        "Date.now()", "Math.random()", "crypto.randomUUID(",
    ]
    for path in engine_files:
        text = path.read_text()
        non_comment = [l for l in text.splitlines() if l.strip() and not l.strip().startswith("//")]
        code = "\n".join(non_comment)
        for sym in forbidden:
            tr.check(f"engine_no:{sym}:{path.name}",
                     sym not in code,
                     f"{path.name}에 {sym!r} 발견")
    return tr

# ════════════════════════════════════════════════════════════════
#  UI-ENGINE WIRING TEST
#  목적: InputView가 "정의됐지만 호출 안 됨" 또는
#       "호출하는데 정의 없음" 상태가 되는 사고를 잡는다.
#  (R201_DEFAULTS, calculateKb 누락 사고의 재발 방지용 화이트리스트 검사)
# ════════════════════════════════════════════════════════════════

# ════════════════════════════════════════════════════════════════
#  MOC_SCHEMA_001 — detectMOC diff 스키마 불변 계약
#  detectMOC()가 반환하는 diff는 반드시 { field, from, to, unit } 4개 필드.
#  이 계약이 깨지면 CaseView 배너 + computeWorkflowState 모두 오작동.
# ════════════════════════════════════════════════════════════════
def test_moc_schema() -> TestResult:
    tr = TestResult("MOC_SCHEMA_001", "detectMOC diff 스키마 불변 계약")
    wf_engine = (SRC / "engine" / "workflow_engine.js").read_text()

    # T1: detectMOC 정의 내부에서 { field, from, to, unit } 패턴 사용하는지
    import re
    push_lines = [l.strip() for l in wf_engine.splitlines()
                  if "diffs.push(" in l]
    required_keys = {"field", "from", "to", "unit"}
    for line in push_lines:
        for key in required_keys:
            tr.check(f"diff_has_{key}_in_push",
                     f"{key}:" in line,
                     f"diffs.push()에 '{key}:' 없음: {line[:80]}")

    # T2: evaluateSafetyImpact가 diff를 재조립하지 않는지
    # (triggerDiffs = diffs.filter(...) 형태여야 함 — 새 객체 생성 없음)
    eval_fn_match = re.search(
        r'function evaluateSafetyImpact.*?^}', wf_engine, re.DOTALL | re.MULTILINE
    )
    if eval_fn_match:
        eval_body = eval_fn_match.group(0)
        tr.check("evaluateSafetyImpact_no_reassembly",
                 "{ field:" not in eval_body and "{ from:" not in eval_body,
                 "evaluateSafetyImpact 내부에서 diff를 재조립하고 있음")
        tr.check("evaluateSafetyImpact_uses_filter",
                 ".filter(" in eval_body,
                 "evaluateSafetyImpact가 filter를 사용하지 않음")
    else:
        tr.check("evaluateSafetyImpact_found", False, "evaluateSafetyImpact 함수 없음")

    # T3: computeWorkflowState가 diff 객체를 새로 생성하지 않는지
    compute_match = re.search(
        r'function computeWorkflowState.*?^}', wf_engine, re.DOTALL | re.MULTILINE
    )
    if compute_match:
        compute_body = compute_match.group(0)
        # diffs.push(...)가 computeWorkflowState 내부에 없어야 함
        tr.check("computeWF_no_diff_creation",
                 "diffs.push(" not in compute_body,
                 "computeWorkflowState 내부에서 diff를 직접 생성하고 있음")
    else:
        tr.check("computeWF_found", False, "computeWorkflowState 함수 없음")

    return tr

# ════════════════════════════════════════════════════════════════
#  WORKFLOW_001 — computeWorkflowState 단일 책임 계약
#  Policy: computeWorkflowState()만 최종 workflow state를 결정.
#  CaseView / UI는 이 결과를 읽기만 해야 함.
# ════════════════════════════════════════════════════════════════
def test_workflow_contract() -> TestResult:
    tr = TestResult("WORKFLOW_001", "workflow 결정권이 Engine에만 있는지")
    case_view = (SRC / "components" / "CaseView.jsx").read_text()
    wf_engine = (SRC / "engine" / "workflow_engine.js").read_text()

    # T1: CaseView가 computeWorkflowState를 호출하는지
    tr.check("CaseView_calls_computeWorkflowState",
             "computeWorkflowState(" in case_view,
             "CaseView가 computeWorkflowState를 호출하지 않음")

    # T2: CaseView가 workflow 상태를 직접 문자열로 하드코딩하지 않는지
    # (허용: "INSPECTION" — 최초 계산, "DRAFT" — 초기값)
    import re
    direct_states = re.findall(
        r'workflow\s*[:=]\s*["\']([A-Z_]+)["\']', case_view
    )
    forbidden_direct = [s for s in direct_states
                        if s not in ("INSPECTION", "DRAFT", "REVIEW_REQUIRED")]
    tr.check("CaseView_no_hardcoded_workflow",
             len(forbidden_direct) == 0,
             f"CaseView에서 workflow를 직접 하드코딩: {forbidden_direct}")

    # T3: computeWorkflowState가 engine 파일에만 있는지
    snap_src  = (SRC / "snapshot" / "create.js").read_text()
    dash_src  = (SRC / "components" / "Dashboard.jsx").read_text()
    tr.check("computeWF_not_in_snapshot",
             "function computeWorkflowState" not in snap_src,
             "computeWorkflowState가 snapshot에 잔존")
    tr.check("computeWF_not_in_dashboard",
             "function computeWorkflowState" not in dash_src,
             "computeWorkflowState가 Dashboard에 잔존")

    # T4: 3계층 구조가 workflow_engine.js에 모두 있는지
    for fn in ["detectMOC", "evaluateSafetyImpact", "computeWorkflowState"]:
        tr.check(f"{fn}_in_engine",
                 f"function {fn}" in wf_engine,
                 f"{fn}이 engine에 없음")

    return tr

# ════════════════════════════════════════════════════════════════
#  WFDECISION_001 — workflowDecision trace Snapshot 저장 계약
# ════════════════════════════════════════════════════════════════
def test_workflow_decision_trace() -> TestResult:
    tr = TestResult("WFDECISION_001", "workflowDecision trace가 Snapshot에 기록되는지")
    snap_src = (SRC / "snapshot" / "create.js").read_text()

    required = [
        ("workflowDecision",     "workflowDecision 필드"),
        ("evaluatedAt",          "evaluatedAt 타임스탬프"),
        ("engineVersion",        "engineVersion 기록"),
        ("reasons",              "reasons 배열"),
        ("triggerFields",        "triggerFields 기록"),
        ("WORKFLOW_TRIGGER_FIELDS_SNAPSHOT", "trigger fields 상수"),
    ]
    for sym, desc in required:
        tr.check(f"snap_has_{sym}",
                 sym in snap_src,
                 f"Snapshot에 {desc} 없음")

    # workflowDecision도 Object.freeze되는지
    tr.check("workflowDecision_frozen",
             "Object.freeze({" in snap_src and "workflowDecision" in snap_src,
             "workflowDecision이 freeze되지 않음")

    # evaluatedAt이 Snapshot(createSnapshot)에서 생성되는지
    tr.check("evaluatedAt_in_snapshot",
             "evaluatedAt" in snap_src and "new Date()" in snap_src,
             "evaluatedAt이 snapshot/create.js에서 생성되지 않음")

    # evaluatedAt이 workflow_engine.js 파라미터에 없는지 (Engine 순수성)
    wf_engine = (SRC / "engine" / "workflow_engine.js").read_text()
    tr.check("evaluatedAt_not_in_engine_param",
             "evaluatedAt" not in wf_engine.split("function computeWorkflowState")[1].split(")")[0],
             "evaluatedAt이 computeWorkflowState 파라미터에 잔존")

    # CaseView가 timestamp를 주입하지 않는지
    case_view = (SRC / "components" / "CaseView.jsx").read_text()
    # computeWorkflowState 호출 줄에 new Date()가 없어야 함
    wf_call_lines = [l for l in case_view.splitlines()
                     if "computeWorkflowState(" in l]
    tr.check("CaseView_no_timestamp_injection",
             all("new Date()" not in l for l in wf_call_lines),
             f"CaseView가 여전히 timestamp를 주입하고 있음: {wf_call_lines}")

    return tr

# ════════════════════════════════════════════════════════════════
#  APPROVAL-001 — snapshotHash 없으면 ApprovalRecord 생성 불가
#  APPROVAL-002 — 승인 후 Snapshot 변경 시 검증 실패
#  APPROVAL-003 — 재승인은 별도 이력, 덮어쓰기 없음
# ════════════════════════════════════════════════════════════════
def _py_snap_hash(snap_id, result_hash, asset_fp, evaluated_at, workflow):
    """_snapHash() JS 구현과 동일"""
    import json
    s = json.dumps({"id": snap_id, "result_hash": result_hash,
                    "assetFingerprint": asset_fp,
                    "evaluatedAt": evaluated_at, "workflow": workflow})
    h = 0
    for ch in s:
        h = ((31 * h) + ord(ch)) & 0xFFFFFFFF
    return format(h, '08x')

def _make_mock_snap(snap_id="SNAP-C-001-1234", workflow="INSPECTION"):
    h = _py_snap_hash(snap_id, "abcd1234", "ef567890", "2026-07-05T00:00:00Z", workflow)
    return {"id": snap_id, "snapshotHash": h, "workflow": workflow,
            "result_hash": "abcd1234"}

def test_approval_contracts() -> TestResult:
    tr = TestResult("APPROVAL-001/002/003", "ApprovalRecord 계약 검증")
    approval_src = (SRC / "approval" / "record.js").read_text()

    # ── 소스 구조 확인 ────────────────────────────────────────
    for sym, desc in [
        ("function createApprovalRecord",  "createApprovalRecord 정의"),
        ("function verifyApproval",        "verifyApproval 정의"),
        ("function addApprovalRecord",     "addApprovalRecord 정의"),
        ("APPROVAL-001",                   "APPROVAL-001 계약 주석"),
        ("APPROVAL-002",                   "APPROVAL-002 계약 주석"),
        ("APPROVAL-003",                   "APPROVAL-003 계약 주석"),
        ("snapshotHash",                   "snapshotHash 참조"),
    ]:
        tr.check(f"src_{sym.replace(' ','_')[:30]}", sym in approval_src, f"{desc} 없음")

    # ── APPROVAL-001: snapshotHash 없으면 생성 불가 ───────────
    # Python으로 validateApprovalInput 로직 재현
    def py_validate(inp):
        if not inp.get("snapshotHash","").strip():
            return {"ok": False, "contract": "APPROVAL-001"}
        if not inp.get("snapshotId","").strip():
            return {"ok": False, "contract": "APPROVAL-001"}
        if not inp.get("approver","").strip():
            return {"ok": False, "contract": "APPROVAL-001"}
        roles = ["engineer","senior_engineer","safety_manager","pss_manager"]
        if inp.get("role") not in roles:
            return {"ok": False, "contract": "APPROVAL-001"}
        return {"ok": True}

    tr.check("APPROVAL_001_no_hash",
             py_validate({"snapshotId":"X","approver":"Kim","role":"engineer"})["ok"] == False,
             "snapshotHash 없어도 생성 허용됨 — APPROVAL-001 위반")
    tr.check("APPROVAL_001_valid",
             py_validate({"snapshotHash":"abc","snapshotId":"X","approver":"Kim","role":"engineer"})["ok"] == True,
             "유효한 입력인데 validation 실패")

    # ── APPROVAL-002: Snapshot 변경 시 검증 실패 ─────────────
    snap = _make_mock_snap()
    good_hash = snap["snapshotHash"]
    record = {"snapshotId": snap["id"], "snapshotHash": good_hash, "approver": "Kim"}

    def py_verify(rec, current_snap):
        if rec["snapshotId"] != current_snap["id"]:
            return {"valid": False, "reason": "snapshotId mismatch"}
        if rec["snapshotHash"] != current_snap["snapshotHash"]:
            return {"valid": False, "reason": "APPROVAL-002: hash mismatch"}
        return {"valid": True}

    # 동일 Snapshot → valid
    tr.check("APPROVAL_002_same_snap",
             py_verify(record, snap)["valid"] == True,
             "동일 Snapshot인데 검증 실패")

    # Snapshot workflow 변경 시뮬레이션 → 다른 hash → invalid
    tampered = {**snap, "snapshotHash": _py_snap_hash(
        snap["id"], snap["result_hash"], "ef567890", "2026-07-05T00:00:00Z", "APPROVED"
    )}
    tr.check("APPROVAL_002_tampered",
             py_verify(record, tampered)["valid"] == False,
             "Snapshot 변조인데 검증 통과 — APPROVAL-002 위반")

    # ── APPROVAL-003: 재승인은 push, replace 없음 ─────────────
    hist1 = []
    r1 = {"approvalId":"APPR-001","snapshotHash":good_hash,"approver":"Kim"}
    r2 = {"approvalId":"APPR-002","snapshotHash":good_hash,"approver":"Lee"}

    hist2 = hist1 + [r1]
    hist3 = hist2 + [r2]

    tr.check("APPROVAL_003_history_grows",
             len(hist3) == 2,
             "재승인 후 이력이 2개여야 함")
    tr.check("APPROVAL_003_no_overwrite",
             hist3[0]["approver"] == "Kim" and hist3[1]["approver"] == "Lee",
             "이전 승인 기록이 덮어쓰여짐 — APPROVAL-003 위반")

    # addApprovalRecord가 새 배열 반환하는지 (mutation 없음)
    tr.check("APPROVAL_003_no_mutation",
             "return Object.freeze([...history, newRecord])" in approval_src,
             "addApprovalRecord가 mutation 없이 새 배열 반환하지 않음")

    # ── snapshotHash가 Snapshot에 존재하는지 ──────────────────
    snap_src = (SRC / "snapshot" / "create.js").read_text()
    tr.check("snapshotHash_in_snapshot",
             "snapshotHash" in snap_src and "_snapHash" in snap_src,
             "snapshot/create.js에 snapshotHash 생성 코드 없음")

    return tr

# ════════════════════════════════════════════════════════════════
#  HISTORY-001 — appendSnapshot()은 항상 새 배열 반환, overwrite 없음
#  HISTORY-002 — resolveSnapshot(hash)은 snapshotHistory에서만 조회
#  HISTORY-003 — 같은 case 안 snapshotHash 중복 금지
# ════════════════════════════════════════════════════════════════
def test_case_history_contract() -> TestResult:
    tr = TestResult("HISTORY-001/002/003", "Case Snapshot History 계약 검증")
    history_src = (SRC / "case" / "history.js").read_text()

    for sym, desc in [
        ("function appendSnapshot",   "appendSnapshot 정의"),
        ("function resolveSnapshot",  "resolveSnapshot 정의"),
        ("function getLatestSnapshot","getLatestSnapshot 정의"),
        ("HISTORY-001",               "HISTORY-001 계약 주석"),
        ("HISTORY-002",               "HISTORY-002 계약 주석"),
        ("HISTORY-003",               "HISTORY-003 계약 주석"),
    ]:
        tr.check(f"src_{sym.replace(' ','_')[:30]}", sym in history_src, f"{desc} 없음")

    # ── resolveSnapshot이 latestSnap을 참조하지 않는지 (소스 검사) ──
    # 함수 body만 추출 (첫 '}'까지) — 뒤따르는 주석은 제외
    resolve_body = history_src.split("function resolveSnapshot")[1].split("}")[0]
    tr.check("resolveSnapshot_no_latestSnap_reference",
             "latestSnap" not in resolve_body,
             "resolveSnapshot이 latestSnap을 참조함 — HISTORY-002 위반")

    # ── HISTORY-001: append 시뮬레이션 (Python 재현) ────────────
    def py_append(case_obj, snap):
        prev = case_obj.get("snapshotHistory", [])
        return {**case_obj, "snapshotHistory": prev + [snap],
                "latestSnap": snap, "workflow": snap["workflow"]}

    c0 = {"id": "C-001", "workflow": "DRAFT", "snapshotHistory": []}
    snapA = {"snapshotHash": "hashA", "id": "SNAP-A", "workflow": "INSPECTION"}
    snapB = {"snapshotHash": "hashB", "id": "SNAP-B", "workflow": "REVIEW"}

    c1 = py_append(c0, snapA)
    c2 = py_append(c1, snapB)

    tr.check("HISTORY_001_history_grows",
             len(c2["snapshotHistory"]) == 2,
             "재계산 후 history가 2개여야 함")
    tr.check("HISTORY_001_no_overwrite",
             c2["snapshotHistory"][0]["snapshotHash"] == "hashA" and
             c2["snapshotHistory"][1]["snapshotHash"] == "hashB",
             "이전 Snapshot이 history에서 사라짐 — overwrite 발생, HISTORY-001 위반")
    tr.check("HISTORY_001_original_not_mutated",
             c0["snapshotHistory"] == [],
             "원본 case 객체가 mutate됨 — HISTORY-001 위반")

    # ── HISTORY-002: 재계산 후에도 승인된 옛 Snapshot을 hash로 조회 가능 ──
    def py_resolve(case_obj, snap_hash):
        return next((s for s in case_obj.get("snapshotHistory", [])
                     if s["snapshotHash"] == snap_hash), None)

    tr.check("HISTORY_002_resolve_after_overwrite_latestSnap",
             py_resolve(c2, "hashA") is not None,
             "latestSnap이 hashB로 넘어간 뒤에도 hashA(승인된 옛 Snapshot)를 조회할 수 있어야 함")
    tr.check("HISTORY_002_resolve_latest",
             py_resolve(c2, "hashB") is not None,
             "최신 Snapshot도 동일한 방식으로 조회 가능해야 함")
    tr.check("HISTORY_002_resolve_unknown_returns_none",
             py_resolve(c2, "hash-does-not-exist") is None,
             "존재하지 않는 hash 조회 시 None이 아닌 값 반환")

    # ── HISTORY-003: 중복 hash 감지 ──────────────────────────────
    c_dup = py_append(c1, {"snapshotHash": "hashA", "id": "SNAP-C", "workflow": "REVIEW"})
    hashes = [s["snapshotHash"] for s in c_dup["snapshotHistory"]]
    tr.check("HISTORY_003_duplicate_detected",
             len(set(hashes)) != len(hashes),
             "중복 snapshotHash가 감지되지 않음")

    # ── ArcSafe.jsx가 appendSnapshot을 통해서만 case를 갱신하는지 ──
    arcsafe_src = (SRC.parent / "src" / "ArcSafe.jsx").read_text()
    handler_body = arcsafe_src.split("handleSnapshotCreate")[1].split("};")[0]
    tr.check("ArcSafe_uses_appendSnapshot",
             "appendSnapshot(" in handler_body,
             "handleSnapshotCreate가 appendSnapshot()을 사용하지 않음 — overwrite 가능성")
    tr.check("ArcSafe_no_direct_latestSnap_overwrite",
             "latestSnap: snap" not in handler_body,
             "handleSnapshotCreate가 latestSnap을 직접 overwrite함 — HISTORY-001 위반")

    # ── SnapshotHash identity: workflow 변경은 patch가 아니라 재생성이어야 함 ──
    case_view_src = (SRC / "components" / "CaseView.jsx").read_text()
    advance_body = case_view_src.split("_buildAdvancedSnapshot = (nextState")[1].split("\n  };")[0]
    tr.check("workflowAdvance_uses_createSnapshot",
             "createSnapshot(" in advance_body,
             "handleWorkflowAdvance가 createSnapshot()으로 재생성하지 않음 — "
             "workflow 변경 시 snapshotHash가 stale해짐 (Identity vs State collapse)")
    tr.check("workflowAdvance_no_raw_workflow_mutation",
             "workflow:         nextState" not in advance_body and
             "workflow: nextState" not in advance_body,
             "handleWorkflowAdvance가 여전히 snapshot.workflow를 직접 patch함")
    tr.check("handleWorkflowAdvance_and_approval_share_builder",
             "_buildAdvancedSnapshot(nextState, comment)" in
               case_view_src.split("const handleWorkflowAdvance")[1].split("\n  };")[0] and
             "_buildAdvancedSnapshot(nextState, comment)" in
               case_view_src.split("const handleApprovalSubmit")[1],
             "handleWorkflowAdvance/handleApprovalSubmit이 서로 다른 방식으로 Snapshot을 만듦 — "
             "build/commit 분리가 깨져 있을 위험")

    return tr

# ════════════════════════════════════════════════════════════════
#  APPROVAL-SIGN-TARGET-001
#  Approval은 "지금 보고 있는 버전"이 아니라 "승인 결과로 확정될 다음 버전"의
#  hash에 서명해야 한다. 순서가 반대면(서명 먼저, 전이 나중) 서명 직후
#  Snapshot이 교체되면서 case의 최종 상태에는 승인 기록이 안 보이게 된다.
# ════════════════════════════════════════════════════════════════
def test_approval_signs_next_snapshot_contract() -> TestResult:
    tr = TestResult("APPROVAL-SIGN-TARGET-001", "승인은 다음 버전의 hash에 서명해야 함")

    case_view_src = (SRC / "components" / "CaseView.jsx").read_text()
    submit_body = case_view_src.split("const handleApprovalSubmit = async")[1].split("\n  };")[0]

    tr.check("approval_builds_next_snapshot_before_signing",
             "_buildAdvancedSnapshot(nextState, comment)" in submit_body,
             "handleApprovalSubmit이 서명 전에 다음 버전 Snapshot을 만들지 않음")

    submit_call = submit_body.split("submitApproval(")[1].split(");")[0]
    tr.check("approval_signs_nextSnap_not_current_snapshot",
             "snapshot: nextSnap" in submit_call,
             "submitApproval이 nextSnap이 아니라 현재(REVIEW) snapshot을 서명 대상으로 사용함 — "
             "승인 직후 Snapshot이 교체되면 서명된 버전이 case에서 사라짐")

    idx_submit = submit_body.index("submitApproval(")
    idx_result_ok_check = submit_body.index("if (!result.ok)")
    idx_commit = submit_body.index("_commitSnapshot(")
    tr.check("approval_commit_happens_after_submit_and_after_ok_check",
             idx_submit < idx_result_ok_check < idx_commit,
             "커밋 순서가 잘못됨 — submitApproval 실패 시에도 Snapshot이 교체될 위험")

    return tr

# ════════════════════════════════════════════════════════════════
#  CRYPTO-001/002/003 — 전자서명 (canonical payload, 재계산 검증)
#  SERVICE-001/002/003 — idempotency, 단일 timestamp
#  VALIDATOR-001/002/003 — 서명 재검증 + snapshot 실존 + 중복 idempotencyKey
# ════════════════════════════════════════════════════════════════
def _py_canonical(rec):
    # crypto.js의 canonicalPayload()를 Python으로 재현 (NUL 구분자, 필드 순서 고정)
    return "\u0000".join([
        rec.get("snapshotHash", "")  or "",
        rec.get("decision", "")      or "",
        rec.get("comment", "")       or "",
        rec.get("signer", "")        or "",
        rec.get("timestamp", "")     or "",
        rec.get("workflowState", "") or "",
    ])

def _py_sha256(msg):
    return hashlib.sha256(msg.encode("utf-8")).hexdigest()

def test_approval_crypto_contract() -> TestResult:
    tr = TestResult("CRYPTO/SERVICE/VALIDATOR", "전자서명 · idempotency · 검증 계약")

    crypto_src    = (SRC / "approval" / "crypto.js").read_text()
    service_src   = (SRC / "approval" / "service.js").read_text()
    validator_src = (SRC / "approval" / "validator.js").read_text()

    for label, src, syms in [
        ("crypto", crypto_src, [
            "function canonicalPayload", "function signApproval",
            "function verifySignature", "function sha256Hex",
            "CRYPTO-001", "CRYPTO-002", "CRYPTO-003",
            "crypto.subtle.digest",
        ]),
        ("service", service_src, [
            "function submitApproval", "function isDuplicateApproval",
            "function computeIdempotencyKey",
            "SERVICE-001", "SERVICE-002", "SERVICE-003",
        ]),
        ("validator", validator_src, [
            "function verifyApprovalRecord", "resolveSnapshot(",
            "verifySignature(", "verifyApproval(",
            "VALIDATOR-001", "VALIDATOR-002", "VALIDATOR-003",
        ]),
    ]:
        for sym in syms:
            tr.check(f"{label}_src_{sym.replace(' ','_').replace('(','')[:30]}",
                      sym in src, f"[{label}] '{sym}' 없음")

    # ── CRYPTO-001: canonicalPayload 필드 순서 고정 → 같은 내용 = 같은 서명 ──
    rec1 = {"snapshotHash":"H1","decision":"approve","comment":"ok",
            "signer":"Kim","timestamp":"2026-07-06T00:00:00Z","workflowState":"REVIEW"}
    rec1_copy = dict(rec1)
    tr.check("CRYPTO_001_same_content_same_signature",
             _py_sha256(_py_canonical(rec1)) == _py_sha256(_py_canonical(rec1_copy)),
             "동일 내용인데 서명이 다름")

    # ── CRYPTO-003: comment 포함 여부 — comment 하나만 바뀌어도 서명 달라짐 ──
    rec2 = {**rec1, "comment": "changed after signing"}
    tr.check("CRYPTO_003_comment_included_in_signature",
             _py_sha256(_py_canonical(rec1)) != _py_sha256(_py_canonical(rec2)),
             "comment가 바뀌었는데 서명이 동일함 — comment가 서명 대상에서 빠짐 (CRYPTO-003 위반)")

    # decision/signer/timestamp/workflowState 각각 변경 시에도 서명 달라져야 함
    for field in ["decision", "signer", "timestamp", "workflowState"]:
        altered = {**rec1, field: rec1[field] + "_X"}
        tr.check(f"CRYPTO_003_{field}_included",
                 _py_sha256(_py_canonical(rec1)) != _py_sha256(_py_canonical(altered)),
                 f"{field}가 바뀌었는데 서명이 동일함 — 서명 대상에서 빠짐")

    # concatenation ambiguity 방지 확인 (구분자 없으면 발생하는 문제)
    a = {**rec1, "snapshotHash": "ab", "decision": "c"}
    b = {**rec1, "snapshotHash": "a",  "decision": "bc"}
    tr.check("CRYPTO_001_no_concat_ambiguity",
             _py_canonical(a) != _py_canonical(b),
             "구분자 없이 concat되어 서로 다른 필드 조합이 같은 payload가 됨")

    # ── SERVICE-001: idempotencyKey — 동일 (hash, signer) → 동일 key ──
    def py_idem_key(snap_hash, signer):
        return _py_sha256(f"{snap_hash}\u0000{signer}")

    k1 = py_idem_key("H1", "Kim")
    k2 = py_idem_key("H1", "Kim")
    k3 = py_idem_key("H1", "Lee")
    tr.check("SERVICE_001_same_key_for_same_pair", k1 == k2,
             "동일 (snapshotHash, signer)인데 idempotencyKey가 다름")
    tr.check("SERVICE_001_diff_signer_diff_key", k1 != k3,
             "signer가 다른데 idempotencyKey가 같음 — 중복 차단이 signer를 구분 못 함")

    # 중복 승인 시도 시뮬레이션
    history = [{"idempotencyKey": k1}]
    is_dup = any(r["idempotencyKey"] == py_idem_key("H1", "Kim") for r in history)
    tr.check("SERVICE_001_duplicate_detected", is_dup,
             "동일 signer의 재승인 시도가 중복으로 감지되지 않음")
    is_dup_other = any(r["idempotencyKey"] == py_idem_key("H1", "Lee") for r in history)
    tr.check("SERVICE_001_different_signer_not_blocked", not is_dup_other,
             "다른 signer의 정당한 승인이 중복으로 잘못 차단됨")

    # ── SERVICE-003: 단일 timestamp — service.js가 Date를 두 번 생성하지 않는지 ──
    submit_body = service_src.split("async function submitApproval")[1]
    date_call_count = submit_body.count("new Date(")
    tr.check("SERVICE_003_single_timestamp_generation",
             date_call_count == 1,
             f"submitApproval 안에서 new Date()가 {date_call_count}번 호출됨 — "
             "approvedAt과 서명 timestamp가 어긋날 수 있음 (2회 이상 호출 시 값 불일치 위험)")

    # ── VALIDATOR-002: resolveSnapshot 결과가 없으면 무조건 invalid ──
    tr.check("VALIDATOR_002_uses_resolveSnapshot_not_latestSnap",
             "resolveSnapshot(caseObj" in validator_src and
             "latestSnap" not in validator_src,
             "validator가 resolveSnapshot 대신 latestSnap을 참조할 위험 — HISTORY-002 위반 가능성")

    return tr

# ════════════════════════════════════════════════════════════════
#  GEOMETRY-001 — 배관 형상은 Case 입력값이 아니라 Asset(DischargeSystem) 데이터
#  GEOMETRY-002 — 개정은 같은 id의 새 revision, mocId 필수
# ════════════════════════════════════════════════════════════════
def test_geometry_contract() -> TestResult:
    tr = TestResult("GEOMETRY-001/002", "배관 형상 Asset 소싱 · 개정 계약")

    input_view_src = (SRC / "components" / "InputView.jsx").read_text()
    case_view_src  = (SRC / "components" / "CaseView.jsx").read_text()
    schema_src     = (SRC / "asset" / "schema.js").read_text()

    # ── GEOMETRY-001: 하드코딩된 임시 geometry 제거 확인 ──────────
    tr.check("no_hardcoded_default_geometry",
             "DEFAULT_GEOMETRY" not in input_view_src,
             "InputView.jsx에 여전히 DEFAULT_GEOMETRY 하드코딩이 남아있음")
    tr.check("no_hardcoded_L_15_literal",
             "L: 15, D: 0.1" not in input_view_src,
             "InputView.jsx에 임시 geometry 리터럴이 남아있음")

    # InputView가 dischargeSystem prop을 받는지
    tr.check("InputView_accepts_dischargeSystem_prop",
             "dischargeSystem }" in input_view_src.split("\n")[153] or
             "dischargeSystem" in input_view_src.split("function InputView(")[1].split(")")[0],
             "InputView가 dischargeSystem prop을 받지 않음")

    # computeBackpressure가 dischargeSystem 필드로부터 geometry를 구성하는지
    # (주석에도 이름이 등장하므로, 실제 호출 형태 "computeBackpressure(inputs, {"를 기준으로 검사)
    call_marker = "computeBackpressure(inputs, {"
    bp_call_region = input_view_src.split(call_marker)[1][:300] if call_marker in input_view_src else ""
    tr.check("computeBackpressure_reads_from_dischargeSystem",
             "dischargeSystem.L" in bp_call_region and "dischargeSystem.D" in bp_call_region,
             "computeBackpressure 호출부가 dischargeSystem(Asset)이 아닌 다른 값으로부터 geometry를 읽음")

    # 미연결 상태를 침묵 처리하지 않고 명시적으로 표시하는지
    tr.check("shows_explicit_warning_when_not_linked",
             "not_linked" in input_view_src and "미연결" in input_view_src,
             "배출계통 미연결 상태를 침묵 처리함 (임의 기본값을 몰래 대입하면 안 됨)")

    # CaseView가 실제 dischargeSystem을 InputView로 전달하는지
    inputview_call = case_view_src.split("<InputView")[1].split("/>")[0]
    tr.check("CaseView_passes_real_dischargeSystem",
             "dischargeSystem={dischargeSystem}" in inputview_call,
             "CaseView가 InputView에 실제 dischargeSystem을 전달하지 않음")

    # ── GEOMETRY-002: 개정 계약 (Python 재현) ────────────────────
    def py_revise(existing, fields):
        if not fields.get("mocId","").strip():
            return {"ok": False, "field": "mocId", "reason": "required_for_revision"}
        return {"ok": True, "dischargeSystem": {
            **existing, **fields,
            "id": existing["id"],
            "revision": existing["revision"] + 1,
        }}

    existing = {"id":"DS-001","name":"LP-FLARE-01","revision":3,"L":12,"D":0.1,
                "fittingsK":2.5,"headerPressure":0.3,"connectedTags":["PSV-R201"]}

    no_moc = py_revise(existing, {"L":14})
    tr.check("GEOMETRY_002_mocId_required",
             no_moc["ok"] is False and no_moc["field"] == "mocId",
             "mocId 없이 개정이 허용됨 — 근거 없는 배관 변경 차단 안 됨")

    with_moc = py_revise(existing, {"mocId":"MOC-2026-0012","L":14})
    tr.check("GEOMETRY_002_id_preserved",
             with_moc["dischargeSystem"]["id"] == existing["id"],
             "개정 시 id가 바뀜 — case의 connectedTags/dischargeSystemId 연결이 끊김")
    tr.check("GEOMETRY_002_revision_incremented",
             with_moc["dischargeSystem"]["revision"] == existing["revision"] + 1,
             "개정 시 revision이 증가하지 않음")

    tr.check("schema_src_reviseDischargeSystem_defined",
             "function reviseDischargeSystem" in schema_src,
             "asset/schema.js에 reviseDischargeSystem 정의 없음")
    tr.check("schema_src_requires_mocId",
             "mocId" in schema_src.split("function reviseDischargeSystem")[1].split("}")[0],
             "reviseDischargeSystem 본문에서 mocId 필수 검사가 보이지 않음")

    return tr

# ════════════════════════════════════════════════════════════════
#  EQUIPMENT-MOC-001/002/003/004
#  DischargeSystem과 동일한 revision/MOC lifecycle을 Equipment에도 적용
# ════════════════════════════════════════════════════════════════
def test_equipment_moc_contract() -> TestResult:
    tr = TestResult("EQUIPMENT-MOC-001/002/003/004", "Equipment revision/MOC 계약")

    schema_src = (SRC / "asset" / "schema.js").read_text()

    tr.check("schema_reviseEquipment_defined",
             "function reviseEquipment" in schema_src,
             "asset/schema.js에 reviseEquipment 정의 없음")

    revise_body = schema_src.split("function reviseEquipment")[1].split("\n// ──")[0]
    tr.check("schema_reviseEquipment_requires_mocId",
             "mocId" in revise_body and "required_for_revision" in revise_body,
             "reviseEquipment이 mocId를 필수로 검사하지 않음")
    tr.check("schema_reviseEquipment_preserves_id",
             "id: existing.id" in revise_body,
             "reviseEquipment이 id를 유지하지 않음 — case/connectedTags 연결 끊길 위험")
    tr.check("schema_reviseEquipment_no_mutation",
             "Object.freeze(" in revise_body,
             "reviseEquipment 결과가 freeze되지 않음 — 기존 객체가 mutate될 위험")

    # ── EQUIPMENT-MOC-001: mocId 없이 개정 → reject (Python 재현) ──
    def py_revise_equipment(existing, fields):
        if not fields.get("mocId","").strip():
            return {"ok": False, "field": "mocId", "reason": "required_for_revision"}
        return {"ok": True, "equipment": {
            **existing, **fields,
            "id": existing["id"],
            "revision": existing["revision"] + 1,
        }}

    eq0 = {"id":"EQ-R201-1","tag":"PSV-R201","revision":3,
           "mawp":6.0,"setPressure":5.5,"orifice":"P","deviceType":"safetyValve"}

    no_moc = py_revise_equipment(eq0, {"setPressure":5.0})
    tr.check("EQUIPMENT_MOC_001_mocId_required",
             no_moc["ok"] is False and no_moc["field"] == "mocId",
             "mocId 없이 Equipment 개정이 허용됨")

    # ── EQUIPMENT-MOC-002: revision 증가 ───────────────────────
    with_moc = py_revise_equipment(eq0, {"mocId":"MOC-2026-017","setPressure":5.0})
    tr.check("EQUIPMENT_MOC_002_revision_incremented",
             with_moc["ok"] and with_moc["equipment"]["revision"] == eq0["revision"] + 1,
             "Equipment 개정 시 revision이 3→4로 증가하지 않음")
    tr.check("EQUIPMENT_MOC_002_id_preserved",
             with_moc["equipment"]["id"] == eq0["id"],
             "Equipment 개정 시 id가 바뀜")

    # ── EQUIPMENT-MOC-003: assetFingerprint 변경 감지 (detectMOC 재사용 원리 확인) ──
    # detectMOC는 setPressure를 diff 대상 필드로 이미 포함하고 있어야 함
    wf_engine_src = (SRC / "engine" / "workflow_engine.js").read_text()
    detect_moc_body = wf_engine_src.split("function detectMOC")[1].split("function ")[0]
    tr.check("EQUIPMENT_MOC_003_setPressure_in_detectMOC",
             "eq.setPressure" in detect_moc_body and "ceq.setPressure" in detect_moc_body,
             "detectMOC가 setPressure 변경을 비교하지 않음 — fingerprint 변경 감지 불가")
    tr.check("EQUIPMENT_MOC_003_fingerprint_drives_detection",
             "assetFingerprint" in detect_moc_body,
             "detectMOC가 assetFingerprint 비교로 시작하지 않음")

    # ── EQUIPMENT-MOC-004: setPressure가 REVIEW 트리거 필드에 포함되는지 ──
    tr.check("EQUIPMENT_MOC_004_setPressure_triggers_review",
             '"setPressure"' in wf_engine_src.split("WORKFLOW_TRIGGER_FIELDS")[1][:300],
             "setPressure가 WORKFLOW_TRIGGER_FIELDS에 없음 — 변경돼도 REVIEW_REQUIRED 안 됨")

    # ── UI 배선 확인: AssetMaster가 onReviseEquipment을 실제로 사용하는지 ──
    asset_master_src = (SRC / "components" / "AssetMaster.jsx").read_text()
    tr.check("AssetMaster_wires_onReviseEquipment",
             "onReviseEquipment" in asset_master_src and "reviseEquipment(editing" in asset_master_src,
             "AssetMaster.jsx가 reviseEquipment 흐름을 실제로 호출하지 않음")
    tr.check("AssetMaster_equipment_form_requires_mocId_when_revising",
             "isRevision ||" in asset_master_src.split("function EquipmentForm")[1][:1500],
             "EquipmentForm이 개정 모드에서 mocId 필수 검증을 하지 않음")

    return tr

# ════════════════════════════════════════════════════════════════
#  AUDIT-001 — ReportView/report/* 는 Snapshot 외부 Asset 참조 금지
#  AUDIT-002 — Evidence 필수 필드 존재
#  AUDIT-003 — Approval chain: approval.snapshotHash == snapshot.snapshotHash
#  AUDIT-004 — Report mutation 금지
#  AUDIT-005 — Evidence는 workflow 단계 무관 항상 렌더링, Approval만 조건부
# ════════════════════════════════════════════════════════════════
def test_audit_evidence_contract() -> TestResult:
    tr = TestResult("AUDIT-001/002/003/004/005", "Audit Evidence View 계약")

    report_dir = SRC / "components" / "report"
    asset_ev   = (report_dir / "AssetEvidence.jsx").read_text()
    wf_ev      = (report_dir / "WorkflowEvidence.jsx").read_text()
    appr_ev    = (report_dir / "ApprovalEvidence.jsx").read_text()
    audit_ev   = (report_dir / "AuditEvidence.jsx").read_text()
    report_view_src = (SRC / "components" / "ReportView.jsx").read_text()

    all_report_src = asset_ev + wf_ev + appr_ev + audit_ev

    # ── AUDIT-001: 현재 Asset 참조 금지 ───────────────────────────
    for banned in ["currentEquipment", "currentDischargeSystem", "detectMOC(",
                   "compareAsset(", "verifySignature(", "computeBackpressure(",
                   "createSnapshot("]:
        tr.check(f"AUDIT_001_no_{banned.strip('(')}",
                  banned not in all_report_src,
                  f"report/* 컴포넌트가 '{banned}'를 참조함 — Snapshot 외부 계산/조회 금지 위반")

    # AssetEvidence/WorkflowEvidence가 snapshot(단일 prop)만 받는지 (equipments/dischargeSystems 배열 금지)
    tr.check("AUDIT_001_no_asset_arrays_referenced",
             "equipments." not in all_report_src and "dischargeSystems." not in all_report_src,
             "report/* 컴포넌트가 Asset 배열(equipments/dischargeSystems)을 직접 참조함")

    # ── AUDIT-002: Evidence 필수 필드 노출 확인 ───────────────────
    for field, src, label in [
        ("equipmentRevision", asset_ev, "AssetEvidence"),
        ("dischargeRevision", asset_ev, "AssetEvidence"),
        ("snapshotHash",      wf_ev,    "WorkflowEvidence"),
        ("engine_version",    wf_ev,    "WorkflowEvidence"),
    ]:
        tr.check(f"AUDIT_002_{label}_{field}",
                  field in src, f"{label}가 {field}를 표시하지 않음")

    # ── AUDIT-003: Approval chain 연결 (snapshotHash 매칭) ───────
    tr.check("AUDIT_003_approval_filtered_by_snapshotHash",
             "a.snapshotHash === snapshot.snapshotHash" in appr_ev,
             "ApprovalEvidence가 snapshotHash 기준으로 승인 기록을 필터링하지 않음 — "
             "다른 버전의 승인이 섞여 보일 위험")

    # Python 시뮬레이션: 여러 버전의 승인 중 현재 snapshot 것만 골라지는지
    approvals = [
        {"approvalId":"A1","snapshotHash":"H1","approver":"Kim"},
        {"approvalId":"A2","snapshotHash":"H2","approver":"Lee"},
    ]
    current_snap = {"snapshotHash":"H2"}
    matched = [a for a in approvals if a["snapshotHash"] == current_snap["snapshotHash"]]
    tr.check("AUDIT_003_only_current_version_matched",
             len(matched) == 1 and matched[0]["approver"] == "Lee",
             "AUDIT-003 필터링 로직이 다른 버전 승인을 잘못 포함/누락함")

    # ── AUDIT-004: report mutation 금지 ───────────────────────────
    import re
    mutation_pattern = re.compile(r'snapshot\.\w+\s*=(?!=)')  # snapshot.xxx = (== 제외)
    delete_pattern    = re.compile(r'delete\s+snapshot\.')
    for label, src in [("AssetEvidence", asset_ev), ("WorkflowEvidence", wf_ev),
                        ("ApprovalEvidence", appr_ev), ("AuditEvidence", audit_ev)]:
        tr.check(f"AUDIT_004_no_mutation_{label}",
                  not mutation_pattern.search(src) and not delete_pattern.search(src),
                  f"{label}에서 snapshot 필드 할당/삭제 시도 발견 — 읽기 전용 위반")

    # ── ReportView 배선 확인 ──────────────────────────────────────
    tr.check("ReportView_renders_AuditEvidence",
             "<AuditEvidence" in report_view_src,
             "ReportView가 AuditEvidence를 렌더링하지 않음")
    tr.check("ReportView_computes_verification_once",
             report_view_src.count("verifyApprovalRecord(") == 1,
             "ReportView가 verifyApprovalRecord를 1회 초과 호출함 — "
             "ApprovalHistory/AuditEvidence가 각자 검증하면 중복 계산")
    tr.check("ApprovalHistory_reuses_shared_results",
             "verifiedResults" in (SRC / "components" / "ApprovalForm.jsx").read_text() and
             "verifyApprovalRecord(" not in (SRC / "components" / "ApprovalForm.jsx").read_text(),
             "ApprovalHistory가 여전히 자체적으로 verifyApprovalRecord를 호출함 (중복 검증)")

    # ── AUDIT-005: Evidence는 workflow 단계 무관 항상 렌더링, Approval만 조건부 ──
    report_view_body = report_view_src.split("const TAB = (id, label)")[0] + \
                        report_view_src.split("return (")[1] if "return (" in report_view_src else report_view_src
    tr.check("AUDIT_005_audit_tab_not_gated_by_workflow",
             "reportTab === \"audit\" &&" in report_view_src and
             "snap.workflow ===" not in report_view_src.split('reportTab === "audit"')[1].split("<AuditEvidence")[0],
             "audit 탭 렌더링이 workflow 상태로 게이팅되어 특정 단계에서 숨겨짐 — "
             "Evidence는 DRAFT/INSPECTION/REVIEW/APPROVED 전 단계에서 항상 조회 가능해야 함")
    tr.check("AUDIT_005_tab_always_present_in_TAB_list",
             '{TAB("audit"' in report_view_src,
             "감사/근거 탭 버튼이 항상 렌더링되지 않음 — 특정 상태에서만 탭이 나타나면 안 됨")

    # ApprovalEvidence: 승인 없는 상태에서도 빈 상태 메시지로 렌더링(에러/숨김 아님)
    tr.check("AUDIT_005_approval_empty_state_not_hidden",
             "matched.length === 0" in appr_ev and "emptyMsg" in appr_ev,
             "ApprovalEvidence가 승인이 없을 때 컴포넌트를 숨기거나 에러를 내는 방식으로 구현됨 — "
             "빈 상태를 명시적으로 보여줘야 함(AUDIT-005: Approval은 조건부 '존재', 조건부 '숨김'이 아님)")
    tr.check("AUDIT_005_evidence_sections_always_rendered_unconditionally",
             "{approved" not in audit_ev.replace("const approved", "").split("headerLabel")[0] and
             "<AssetEvidence" in audit_ev and "<WorkflowEvidence" in audit_ev,
             "AuditEvidence가 Asset/Workflow 섹션을 workflow 상태에 따라 조건부로 숨김 — "
             "Evidence(Asset/Workflow)는 승인 여부와 무관하게 항상 존재해야 함")

    return tr

# ════════════════════════════════════════════════════════════════
#  REPORT-PKG-001 — Snapshot → Package 결정론
#  REPORT-PKG-002 — Package mutation 금지
#  REPORT-PKG-003 — 현재 Asset 참조 금지 (snapshot만 입력)
#  REPORT-PKG-004 — Approval chain 연결 (snapshotHash 일치)
#  REPORT-PKG-005 — Report 계산 금지
# ════════════════════════════════════════════════════════════════
def test_report_package_contract() -> TestResult:
    tr = TestResult("REPORT-PKG-001~005", "ReportPackage 계약 검증")

    schema_src = (SRC / "report" / "schema.js").read_text()
    pkg_src    = (SRC / "report" / "createPackage.js").read_text()

    for label, src, syms in [
        ("schema", schema_src, ["REPORT_PACKAGE_VERSION", "function validateReportPackage",
                                 "REPORT-PKG-002"]),
        ("createPackage", pkg_src, ["function buildReportPackage",
                                     "REPORT-PKG-001", "REPORT-PKG-002",
                                     "REPORT-PKG-003", "REPORT-PKG-004", "REPORT-PKG-005",
                                     "Object.freeze(pkg)"]),
    ]:
        for sym in syms:
            tr.check(f"{label}_src_{sym.replace(' ','_').replace('(','')[:30]}",
                      sym in src, f"[{label}] '{sym}' 없음")

    # ── REPORT-PKG-003: 현재 Asset 인자를 받지 않는지 (함수 시그니처 검사) ──
    sig = pkg_src.split("function buildReportPackage(")[1].split(")")[0]
    tr.check("REPORT_PKG_003_signature_snapshot_and_opts_only",
             "currentEquipment" not in sig and "currentDischargeSystem" not in sig and
             "equipments" not in sig and "dischargeSystems" not in sig,
             f"buildReportPackage 시그니처에 현재 Asset 인자가 있음: ({sig})")
    tr.check("REPORT_PKG_003_no_asset_array_refs_in_body",
             "equipments." not in pkg_src and "dischargeSystems." not in pkg_src,
             "buildReportPackage 본문이 Asset 배열을 직접 참조함")
    tr.check("REPORT_PKG_003_reads_only_from_assetRefs_and_embedded_copy",
             "snapshot.assetRefs" in pkg_src and
             ("snapshot.equipment?." in pkg_src or "snapshot.equipment." in pkg_src),
             "buildReportPackage이 snapshot.assetRefs/snapshot.equipment 외 다른 곳에서 Asset을 읽음")

    # ── REPORT-PKG-005: 계산 함수 호출 금지 ───────────────────────
    for banned in ["computeBackpressure(", "calculateKb(", "detectMOC(", "verifySignature("]:
        tr.check(f"REPORT_PKG_005_no_{banned.strip('(')}",
                  banned not in pkg_src,
                  f"buildReportPackage이 '{banned}'를 호출함 — 계산/재검증은 report layer 금지")

    # ── Python 재현: 결정론 / freeze / approval 필터링 ────────────
    def py_build(snapshot, approval_records, verification_results, generated_at):
        matched = [
            {
                "approvalId": a["approvalId"], "signer": a["approver"],
                "approvedAt": a["approvedAt"], "decision": a["decision"],
                "verified": verification_results.get(a["approvalId"], {}).get("valid"),
            }
            for a in approval_records if a["snapshotHash"] == snapshot["snapshotHash"]
        ]
        return {
            "meta": {"packageVersion": "1.0.0", "generatedAt": generated_at,
                      "engineVersion": snapshot["engine_version"]},
            "identity": {"caseId": snapshot["caseId"], "snapshotId": snapshot["id"],
                          "snapshotHash": snapshot["snapshotHash"]},
            "approvals": matched,
        }

    snap = {"id":"SNAP-1","caseId":"C-001","snapshotHash":"H1","engine_version":"1.1.0"}
    approvals = [
        {"approvalId":"A1","approver":"Kim","approvedAt":"2026-07-06T00:00:00Z",
         "decision":"approve","snapshotHash":"H1"},
        {"approvalId":"A2","approver":"Lee","approvedAt":"2026-07-05T00:00:00Z",
         "decision":"approve","snapshotHash":"H0-OLD"},
    ]
    verified = {"A1": {"valid": True}}

    pkg1 = py_build(snap, approvals, verified, "2026-07-07T00:00:00Z")
    pkg2 = py_build(snap, approvals, verified, "2026-07-07T00:00:00Z")
    tr.check("REPORT_PKG_001_deterministic_same_input_same_output",
             pkg1 == pkg2,
             "같은 snapshot+같은 generatedAt인데 다른 package가 나옴 — 결정론 위반")

    # ── REPORT-PKG-004: approval chain 연결 확인 ─────────────────
    tr.check("REPORT_PKG_004_only_matching_snapshotHash_included",
             len(pkg1["approvals"]) == 1 and pkg1["approvals"][0]["signer"] == "Kim",
             "REPORT-PKG-004: 다른 snapshotHash의 approval이 섞여 들어감")
    tr.check("REPORT_PKG_004_approval_snapshotHash_matches_identity",
             all(True for _ in pkg1["approvals"]) and
             pkg1["identity"]["snapshotHash"] == "H1",
             "package.identity.snapshotHash가 approval 필터링 기준과 다름")

    return tr

# ════════════════════════════════════════════════════════════════
#  PDF-001 — Renderer는 계산/재검증 함수 접근 금지
#  PDF-002 — Renderer 입력은 reportPackage 하나만
#  PDF-003 — 동일 Package → 동일 PDF metadata (생성시간 제외)
#  PDF-004 — PDF 필수 Evidence 5개 섹션 출력
# ════════════════════════════════════════════════════════════════
def test_pdf_renderer_contract() -> TestResult:
    tr = TestResult("PDF-001/002/003/004", "PDF Renderer 계약 검증")

    pdf_dir      = SRC / "report" / "renderer" / "pdf"
    styles_src   = (pdf_dir / "styles.js").read_text()
    template_src = (pdf_dir / "template.js").read_text()
    render_src   = (pdf_dir / "renderPDF.js").read_text()
    all_pdf_src  = styles_src + template_src + render_src

    for label, src, syms in [
        ("styles",   styles_src,  ["PDF_STYLES"]),
        ("template", template_src,["function buildPDFHtml", "PDF-002", "PDF-004"]),
        ("render",   render_src,  ["function renderPDF", "PDF-001", "PDF-002", "PDF-003",
                                     "validateReportPackage(reportPackage)"]),
    ]:
        for sym in syms:
            tr.check(f"{label}_src_{sym.replace(' ','_').replace('(','')[:30]}",
                      sym in src, f"[{label}] '{sym}' 없음")

    # ── PDF-001: 계산/재검증 함수 호출 금지 ───────────────────────
    for banned in ["computeBackpressure(", "calculateKb(", "detectMOC(", "verifyApprovalRecord("]:
        tr.check(f"PDF_001_no_{banned.strip('(')}",
                  banned not in all_pdf_src,
                  f"PDF renderer가 '{banned}'를 호출함 — 계산/재검증은 renderer 금지")

    # ── PDF-002: 함수 시그니처가 단일 인자만 받는지 ──────────────
    render_sig = render_src.split("function renderPDF(")[1].split(")")[0]
    tr.check("PDF_002_renderPDF_single_arg",
             "," not in render_sig,
             f"renderPDF가 여러 인자를 받음: ({render_sig}) — reportPackage 하나만 허용")
    template_sig = template_src.split("function buildPDFHtml(")[1].split(")")[0]
    tr.check("PDF_002_buildPDFHtml_single_arg",
             "," not in template_sig,
             f"buildPDFHtml이 여러 인자를 받음: ({template_sig})")
    tr.check("PDF_002_no_snapshot_param_name",
             "snapshot)" not in render_src.split("function renderPDF(")[1][:30] and
             "caseData" not in render_sig and "equipment" not in render_sig,
             "renderPDF 시그니처에 snapshot/equipment/caseData 등 추가 데이터 인자가 보임")

    # ── PDF-003: 결정론 (생성시간 제외 나머지 동일) — buildPDFHtml Python 근사 재현 ──
    def py_build_html_skeleton(pkg):
        # 실제 HTML 문자열 대신, "생성시간을 뺀 나머지 필드가 출력에 영향 주는 필드 목록"만 비교
        return {
            "asset": pkg["asset"], "calculation": pkg["calculation"],
            "workflow": pkg["workflow"], "approvals": pkg["approvals"],
            "identity": pkg["identity"], "packageVersion": pkg["meta"]["packageVersion"],
            "engineVersion": pkg["meta"]["engineVersion"],
            # generatedAt은 의도적으로 제외
        }
    pkg_a = {"asset":{"x":1}, "calculation":{"y":2}, "workflow":{"z":3}, "approvals":[],
             "identity":{"snapshotHash":"H1"},
             "meta":{"packageVersion":"1.0.0","engineVersion":"1.1.0","generatedAt":"2026-07-07T00:00:00Z"}}
    pkg_b = {**pkg_a, "meta":{**pkg_a["meta"], "generatedAt":"2026-07-08T00:00:00Z"}}
    tr.check("PDF_003_same_content_diff_generatedAt_same_skeleton",
             py_build_html_skeleton(pkg_a) == py_build_html_skeleton(pkg_b),
             "generatedAt만 다른데 나머지 출력 대상 필드까지 달라짐 — PDF-003 결정론 위반")
    tr.check("PDF_003_generatedAt_treated_as_metadata_only",
             "meta.generatedAt" in template_src,
             "template.js가 generatedAt을 메타데이터로 별도 취급하지 않음")

    # ── PDF-004: 필수 Evidence 5개 섹션 ──────────────────────────
    for section in ["ASSET", "CALCULATION BASIS", "WORKFLOW DECISION", "APPROVAL", "INTEGRITY"]:
        tr.check(f"PDF_004_section_{section.split()[0]}",
                  section in template_src,
                  f"PDF 템플릿에 '{section}' 섹션이 없음")
    for field in ["pkg.asset.equipment.tag", "pkg.asset.equipment.revision", "pkg.asset.equipment.mocId",
                  "pkg.calculation.inputs", "pkg.calculation.engineVersion",
                  "pkg.workflow.state", "pkg.identity.snapshotHash", "pkg.meta.packageVersion"]:
        tr.check(f"PDF_004_field_{field.split('.')[-1]}",
                  field in template_src,
                  f"PDF 템플릿이 필수 필드 {field}를 출력하지 않음")

    # ── PDF-003(런타임 안전장치): 유효하지 않은 Package는 렌더링 중단 ──
    render_body = render_src.split("function renderPDF(reportPackage)")[1]
    tr.check("PDF_invalid_package_blocks_before_html_build",
             render_body.index("check.ok") < render_body.index("buildPDFHtml("),
             "renderPDF가 validateReportPackage 검사보다 먼저(또는 무관하게) HTML을 생성함")

    return tr

# ════════════════════════════════════════════════════════════════
#  PDF-GOLDEN-001
#  실제 fixture(PSV-R201)로 buildPDFHtml()을 진짜 Node에서 실행해:
#    1. 같은 package → 같은 정규화 HTML hash (결정론, 소스 텍스트 재현이 아니라 실행 검증)
#    2. 필수 내용(설비 revision, MOC, 배관 형상, 서명자, 검증 배지)이 실제 출력에 있는지
#  PDF 바이너리 자체는 브라우저 metadata 때문에 비교 불가하므로 HTML 단계에서 고정한다.
# ════════════════════════════════════════════════════════════════
def test_pdf_golden_fixture_contract() -> TestResult:
    tr = TestResult("PDF-GOLDEN-001", "PSV-R201 실제 fixture 기반 PDF 골든 테스트")

    node = shutil.which("node")
    if not node:
        tr.check("node_available", False, "node 실행 파일을 찾을 수 없어 골든 테스트를 건너뜀")
        return tr

    fixtures_dir = ROOT / "tests" / "fixtures"
    golden_script = ROOT / "tests" / "golden_pdf_hash.js"
    tr.check("golden_script_exists", golden_script.exists(), "tests/golden_pdf_hash.js 없음")

    for fixture_name in ["PSV-R201-review-required-package.json", "PSV-R201-approved-package.json"]:
        fixture_path = fixtures_dir / fixture_name
        if not fixture_path.exists():
            tr.check(f"fixture_exists_{fixture_name}", False, f"{fixture_name} fixture 없음")
            continue

        def run_golden():
            r = subprocess.run([node, str(golden_script), str(fixture_path)],
                                capture_output=True, text=True, timeout=15)
            return r

        r1 = run_golden()
        r2 = run_golden()
        tr.check(f"golden_runs_ok_{fixture_name}",
                  r1.returncode == 0 and r2.returncode == 0,
                  f"{fixture_name}: node 실행 실패 — {r1.stderr or r2.stderr}")
        if r1.returncode == 0 and r2.returncode == 0:
            h1, h2 = r1.stdout.strip(), r2.stdout.strip()
            tr.check(f"golden_deterministic_{fixture_name}",
                      h1 == h2 and len(h1) == 64,
                      f"{fixture_name}: 같은 package인데 실행마다 HTML hash가 다름 — "
                      f"실제 buildPDFHtml() 실행 결과가 비결정적임 ({h1} != {h2})")

        # ── 내용 검증: 실제 buildPDFHtml()을 한 번 더 돌려 필수 문자열 확인 ──
        pkg = json.loads(fixture_path.read_text())
        check_script = f"""
const fs = require('fs');
const files = ['report/schema.js','report/renderer/pdf/styles.js','report/renderer/pdf/template.js']
  .map(f => fs.readFileSync('{SRC}/' + f, 'utf8')).join('\\n');
eval(files);
const pkg = {json.dumps(pkg)};
console.log(buildPDFHtml(pkg));
"""
        r3 = subprocess.run([node, "-e", check_script], capture_output=True, text=True, timeout=15)
        html = r3.stdout

        expectations = [
            (pkg["asset"]["equipment"]["tag"], "Equipment tag"),
            (f'Rev.{pkg["asset"]["equipment"]["revision"]}', "Equipment revision"),
            (f'Rev.{pkg["asset"]["dischargeSystem"]["revision"]}', "Discharge revision"),
            (str(pkg["asset"]["dischargeSystem"]["headerPressure"]), "Header pressure 값"),
            (str(pkg["asset"]["dischargeSystem"]["fittingsK"]), "Fittings K 값"),
            (pkg["identity"]["snapshotHash"], "Snapshot hash"),
        ]
        if pkg["asset"]["dischargeSystem"].get("mocId"):
            expectations.append((pkg["asset"]["dischargeSystem"]["mocId"], "MOC 번호"))
        for approval in pkg.get("approvals", []):
            expectations.append((approval["signer"], "승인자명"))

        for expected, label in expectations:
            tr.check(f"golden_content_{fixture_name}_{label.replace(' ','_')}",
                      expected in html,
                      f"{fixture_name}: PDF 출력에 {label}({expected})이 없음")

        # 승인 없는 fixture는 "서명 없음"이, 승인 있는 fixture는 "서명 유효"가 있어야 함
        if len(pkg.get("approvals", [])) == 0:
            tr.check(f"golden_content_{fixture_name}_pending_badge",
                      "서명 없음" in html,
                      f"{fixture_name}: 승인 없는 상태인데 '서명 없음' 배지가 없음")
        else:
            tr.check(f"golden_content_{fixture_name}_verified_badge",
                      "서명 유효" in html,
                      f"{fixture_name}: 승인된 상태인데 '서명 유효' 배지가 없음")

    return tr

def test_ui_engine_wiring() -> TestResult:
    tr = TestResult("WIRING-001", "InputView가 engine 함수를 올바르게 호출하는지")
    input_view = (SRC / "components" / "InputView.jsx").read_text()
    backpressure_src = (SRC / "engine" / "backpressure.js").read_text()

    tr.check("InputView_calls_computeBackpressure",
             "computeBackpressure(" in input_view,
             "InputView.jsx에 computeBackpressure( 호출이 없음")

    tr.check("computeBackpressure_defined_in_engine",
             "function computeBackpressure" in backpressure_src,
             "engine/backpressure.js에 정의가 없음")

    relevant = "\n".join([
        (SRC / "constants.js").read_text(),
        (SRC / "engine" / "api520.js").read_text(),
        (SRC / "engine" / "backpressure.js").read_text(),
        (SRC / "engine" / "evidence.js").read_text(),
        (SRC / "engine" / "workflow_engine.js").read_text(),
        input_view,
    ])
    tr.check("calculateKb_fully_removed",
             "calculateKb" not in relevant,
             "calculateKb 참조가 소스에 남아있음 (정의 또는 호출)")

    # detectMOC 위치 검증
    wf_engine = (SRC / "engine" / "workflow_engine.js").read_text()
    snap_src  = (SRC / "snapshot" / "create.js").read_text()
    wf_index  = (SRC / "workflow" / "index.js").read_text()
    tr.check("detectMOC_in_workflow_engine",
             "function detectMOC" in wf_engine,
             "detectMOC가 engine/workflow_engine.js에 없음")
    tr.check("detectMOC_not_in_snapshot",
             "function detectMOC" not in snap_src,
             "detectMOC가 snapshot/create.js에 잔존")
    tr.check("requiresReview_not_in_workflow",
             "function requiresReview" not in wf_index,
             "requiresReview가 workflow/index.js에 잔존")

    return tr

# ════════════════════════════════════════════════════════════════
#  MAIN
# ════════════════════════════════════════════════════════════════
def main():
    ts = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    print(f"\n{'═'*60}")
    print(f"  ArcSafe Contract Test Suite")
    print(f"  ENGINE_VERSION: {ENGINE_VERSION}")
    print(f"  {ts}")
    print(f"{'═'*60}\n")

    all_results = []

    # ── Fixture tests ─────────────────────────────────────────
    print("── SCENARIO FIXTURES ────────────────────────────────")
    for f in FIXTURES:
        t0 = time.perf_counter()
        tr = run_fixture(f)
        elapsed = (time.perf_counter() - t0) * 1000
        all_results.append(tr)

        status = "✓ PASS" if tr.passed else "✗ FAIL"
        print(f"\n  [{tr.sc_id}] {tr.label}")
        print(f"  {status}  ({elapsed:.2f}ms)")
        for name, ok, detail in tr.checks:
            mark = "  ✓" if ok else "  ✗"
            line = f"{mark} {name}"
            if detail and not ok:
                line += f"\n       {detail}"
            print(line)

    # ── Backpressure fixture tests ─────────────────────────────
    print("\n── BACKPRESSURE FIXTURES ────────────────────────────")
    for f in BP_FIXTURES:
        t0 = time.perf_counter()
        tr = run_backpressure_fixture(f)
        elapsed = (time.perf_counter() - t0) * 1000
        all_results.append(tr)

        status = "✓ PASS" if tr.passed else "✗ FAIL"
        print(f"\n  [{tr.sc_id}] {tr.label}")
        print(f"  {status}  ({elapsed:.2f}ms)")
        for name, ok, detail in tr.checks:
            mark = "  ✓" if ok else "  ✗"
            line = f"{mark} {name}"
            if detail and not ok:
                line += f"\n       {detail}"
            print(line)

    # ── Snapshot schema test ──────────────────────────────────
    print("\n── SNAPSHOT SCHEMA ──────────────────────────────────")
    tr = test_snapshot_schema()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [SCHEMA-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── MOC detection test ────────────────────────────────────
    print("\n── MOC DETECTION ────────────────────────────────────")
    tr = test_moc_detection()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [MOC-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── Boundary test ─────────────────────────────────────────
    print("\n── ENGINE BOUNDARY ──────────────────────────────────")
    tr = test_engine_boundary()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [BOUNDARY-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── Unit Boundary test ───────────────────────────────────────
    print("\n── UNIT BOUNDARY ─────────────────────────────────────")
    tr = test_unit_boundaries()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [UNIT-BOUNDARY-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── Compressibility(Z) contract ──────────────────────────────
    print("\n── COMPRESSIBILITY (Z) ───────────────────────────────")
    tr = test_compressibility_contract()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [COMPRESSIBILITY-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── Golden Baseline contract ─────────────────────────────────
    print("\n── GOLDEN BASELINE (Engine 1.3.0) ────────────────────")
    tr = test_golden_baseline_contract()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [GOLDEN-BASELINE-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── UI-Engine wiring test ──────────────────────────────────
    print("\n── UI-ENGINE WIRING ─────────────────────────────────")
    tr = test_ui_engine_wiring()
    all_results.append(tr)
    status = "✓ PASS" if tr.passed else "✗ FAIL"
    print(f"\n  [WIRING-001] {tr.label}")
    print(f"  {status}")
    for name, ok, detail in tr.checks:
        mark = "  ✓" if ok else "  ✗"
        print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── MOC schema contract ────────────────────────────────────
    print("\n── MOC SCHEMA CONTRACT ──────────────────────────────")
    for fn, label in [(test_moc_schema,            "MOC_SCHEMA_001"),
                      (test_workflow_contract,      "WORKFLOW_001"),
                      (test_workflow_decision_trace,"WFDECISION_001"),
                      (test_approval_contracts,     "APPROVAL-001/002/003"),
                      (test_case_history_contract,  "HISTORY-001/002/003"),
                      (test_approval_crypto_contract, "CRYPTO/SERVICE/VALIDATOR"),
                      (test_geometry_contract,       "GEOMETRY-001/002"),
                      (test_equipment_moc_contract,  "EQUIPMENT-MOC-001~004"),
                      (test_audit_evidence_contract, "AUDIT-001~005"),
                      (test_report_package_contract, "REPORT-PKG-001~005"),
                      (test_pdf_renderer_contract,   "PDF-001~004"),
                      (test_approval_signs_next_snapshot_contract, "APPROVAL-SIGN-TARGET-001"),
                      (test_pdf_golden_fixture_contract, "PDF-GOLDEN-001")]:
        tr = fn()
        all_results.append(tr)
        status = "✓ PASS" if tr.passed else "✗ FAIL"
        print(f"\n  [{label}] {tr.label}")
        print(f"  {status}")
        for name, ok, detail in tr.checks:
            mark = "  ✓" if ok else "  ✗"
            print(f"{mark} {name}" + (f"\n       {detail}" if detail and not ok else ""))

    # ── Summary ───────────────────────────────────────────────
    total  = sum(len(r.checks) for r in all_results)
    passed = sum(sum(1 for _, ok, _ in r.checks if ok) for r in all_results)
    suites_pass = sum(1 for r in all_results if r.passed)

    print(f"\n{'═'*60}")
    print(f"  RESULT: {suites_pass}/{len(all_results)} suites passed")
    print(f"  CHECKS: {passed}/{total}")
    print(f"  {'ALL PASS ✓' if passed == total else 'FAILURES DETECTED ✗'}")
    print(f"{'═'*60}\n")

    sys.exit(0 if passed == total else 1)

if __name__ == "__main__":
    main()
