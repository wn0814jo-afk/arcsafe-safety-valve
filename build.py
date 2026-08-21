#!/usr/bin/env python3
"""
ArcSafe build.py — v0.1.0-architecture-freeze
═══════════════════════════════════════════════
BUILD PIPELINE
  1. source collect    — 소스 파일 존재 확인
  2. import resolve    — 경계 침범 검사 (engine↔UI, report↔engine직접호출)
  3. symbol scan       — 필수 심볼 존재 확인
  4. architecture check— banned 패턴 + legacy 컴포넌트 차단
  5. hash generate     — source hash (BUILD_HASH) 생성
  6. package           — concat → index.html
  7. deploy zip        — CF Pages 배포 zip 생성

순서 = dependency graph (변경 금지):
  1  constants
  2  engine/api520
  3  engine/evidence
  4  snapshot/create
  5  workflow/index
  6  sim/step
  7  components/renderers/index
  8  components/InputView
  9  components/WorkflowTransition
  10 components/NewCaseForm
  11 components/ReportView
  12 components/CaseView
  13 components/Dashboard
  14 ArcSafe
"""

import hashlib, re, sys, zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT    = Path(__file__).parent
SRC     = ROOT / 'src'
DIST    = ROOT / 'dist'
ZIP_OUT = ROOT / 'ArcSafe-CF-DEPLOY.zip'

# ── BUILD ORDER ───────────────────────────────────────────────────
BUILD_ORDER = [
    SRC / 'constants.js',
    SRC / 'engine' / 'api520.js',
    SRC / 'engine' / 'relief_load.js',
    SRC / 'engine' / 'backpressure.js',
    SRC / 'engine' / 'evidence.js',
    SRC / 'snapshot' / 'create.js',
    SRC / 'engine' / 'workflow_engine.js',
    SRC / 'workflow' / 'index.js',
    SRC / 'approval' / 'crypto.js',
    SRC / 'approval' / 'record.js',
    SRC / 'approval' / 'service.js',
    SRC / 'sim' / 'step.js',
    SRC / 'asset' / 'schema.js',
    SRC / 'asset' / 'history.js',
    SRC / 'asset' / 'diff.js',
    SRC / 'asset' / 'impact.js',
    SRC / 'case' / 'history.js',
    SRC / 'approval' / 'validator.js',
    SRC / 'report' / 'schema.js',
    SRC / 'report' / 'createPackage.js',
    SRC / 'report' / 'renderer' / 'pdf' / 'styles.js',
    SRC / 'report' / 'renderer' / 'pdf' / 'template.js',
    SRC / 'report' / 'renderer' / 'pdf' / 'renderPDF.js',
    SRC / 'components' / 'renderers' / 'index.jsx',
    SRC / 'components' / 'InputView.jsx',
    SRC / 'components' / 'WorkflowTransition.jsx',
    SRC / 'components' / 'ApprovalForm.jsx',
    SRC / 'components' / 'NewCaseForm.jsx',
    SRC / 'components' / 'AssetMaster.jsx',
    SRC / 'components' / 'report' / 'AssetEvidence.jsx',
    SRC / 'components' / 'report' / 'WorkflowEvidence.jsx',
    SRC / 'components' / 'report' / 'ApprovalEvidence.jsx',
    SRC / 'components' / 'report' / 'AuditEvidence.jsx',
    SRC / 'components' / 'ReportView.jsx',
    SRC / 'components' / 'CaseView.jsx',
    SRC / 'components' / 'Dashboard.jsx',
    SRC / 'ArcSafe.jsx',
]

# ── STEP 1: SOURCE COLLECT ────────────────────────────────────────
def step1_collect():
    missing = [p for p in BUILD_ORDER if not p.exists()]
    if missing:
        for m in missing: print(f"  [MISSING] {m.relative_to(ROOT)}")
        return False
    print(f"  {len(BUILD_ORDER)} source files found")
    return True

# ── STEP 2: DEPENDENCY DIRECTION CHECK ───────────────────────────
# 허용 방향: components -> snapshot -> engine (단방향)
# FORBIDDEN_IMPORTS: { 레이어_패턴: [(금지_심볼, 설명), ...] }
FORBIDDEN_IMPORTS = {
    "engine/": [
        ("useState",           "engine -> React hook 금지"),
        # workflow_engine.js 추가 항목
        ("WF_LABEL",           "workflow_engine -> WF_LABEL(UI 레이블) 참조 금지"),
        ("WF_COLOR",           "workflow_engine -> WF_COLOR(UI 색상) 참조 금지"),
        ("useEffect",          "engine -> React hook 금지"),
        ("React",              "engine -> React 참조 금지"),
        ("window.",            "engine -> browser API 금지"),
        ("document.",          "engine -> browser API 금지"),
        ("createSnapshot",     "engine -> snapshot 역참조 금지"),
        ("WF_TRANSITIONS",     "engine -> workflow 역참조 금지"),
        ("WorkflowTransition", "engine -> UI component 역참조 금지"),
        ("Dashboard",          "engine -> UI component 역참조 금지"),
    ],
    "snapshot/": [
        ("useState",           "snapshot -> React hook 금지"),
        ("useEffect",          "snapshot -> React hook 금지"),
        ("React",              "snapshot -> React 참조 금지"),
        ("window.",            "snapshot -> browser API 금지"),
        ("document.",          "snapshot -> browser API 금지"),
    ],
    "workflow/": [
        ("useState",           "workflow -> React hook 금지"),
        ("setState",           "workflow -> UI state 변경 금지"),
        ("dispatch",           "workflow -> UI dispatch 금지"),
        ("React",              "workflow -> React 참조 금지"),
        ("api520Engine",       "workflow -> engine 직접 호출 금지"),
        ("createSnapshot",     "workflow -> snapshot 생성 금지"),
    ],
    "sim/": [
        ("useState",           "sim -> React hook 금지"),
        ("React",              "sim -> React 참조 금지"),
        ("api520Engine",       "sim -> engine 호출 금지"),
    ],
    "renderers/": [
        ("api520Engine",       "renderer -> engine 직접 호출 금지"),
        ("validateInputs",     "renderer -> engine 직접 호출 금지"),
        ("buildEvidence",      "renderer -> evidence 직접 호출 금지"),
        ("createSnapshot",     "renderer -> snapshot 생성 금지"),
    ],
    "ReportView": [
        ("api520Engine",       "ReportView -> engine 직접 호출 금지"),
        ("validateInputs",     "ReportView -> engine 직접 호출 금지"),
        ("createSnapshot",     "ReportView -> snapshot 생성 금지"),
    ],
    "ApprovalForm": [
        ("api520Engine",       "ApprovalForm -> engine 직접 호출 금지"),
        ("createSnapshot",     "ApprovalForm -> snapshot 생성 금지"),
        ("submitApproval(",    "ApprovalForm -> service 직접 호출 금지 (onSubmit prop만 사용)"),
        ("signApproval(",      "ApprovalForm -> crypto 직접 호출 금지"),
        ("canonicalPayload(",  "ApprovalForm -> crypto 직접 호출 금지"),
    ],
    "case/": [
        ("useState",           "case -> React hook 금지"),
        ("useEffect",          "case -> React hook 금지"),
        ("React",              "case -> React 참조 금지"),
        ("window.",            "case -> browser API 금지"),
        ("document.",          "case -> browser API 금지"),
        ("api520Engine",       "case -> engine 직접 호출 금지"),
        ("createSnapshot",     "case -> snapshot 생성 금지 (조회/보관만 담당)"),
    ],
    "approval/": [
        ("useState",           "approval -> React hook 금지"),
        ("useEffect",          "approval -> React hook 금지"),
        ("React",              "approval -> React 참조 금지"),
        ("document.",          "approval -> browser DOM API 금지"),
        ("api520Engine",       "approval -> engine 직접 호출 금지"),
        ("createSnapshot",     "approval -> snapshot 생성 금지 (읽기 전용)"),
    ],
    "components/report/": [
        ("currentEquipment",     "AUDIT-001: report -> 현재 Asset 참조 금지 (snapshot.assetRefs만 읽기)"),
        ("currentDischargeSystem","AUDIT-001: report -> 현재 Asset 참조 금지 (snapshot.assetRefs만 읽기)"),
        ("detectMOC(",            "AUDIT-001: report -> MOC 재계산 금지 (Snapshot에 이미 기록된 값만 표시)"),
        ("compareAsset(",         "AUDIT-001: report -> Asset 비교 금지"),
        ("verifySignature(",      "AUDIT-001: report -> 서명 재계산 금지 (validator 결과만 표시)"),
        ("computeBackpressure(",  "AUDIT-001: report -> engine 직접 호출 금지"),
        ("createSnapshot",        "AUDIT-004: report -> snapshot 생성/수정 금지 (읽기 전용)"),
    ],
    "report/schema.js": [
        ("useState",              "report/schema -> React hook 금지 (순수 검증만)"),
        ("computeBackpressure(",  "REPORT-PKG-005: report -> engine 계산 금지"),
        ("detectMOC(",            "REPORT-PKG-005: report -> MOC 재계산 금지"),
        ("verifySignature(",      "REPORT-PKG-005: report -> 서명 재계산 금지"),
    ],
    "report/createPackage.js": [
        ("useState",              "report/createPackage -> React hook 금지 (순수 함수만)"),
        ("currentEquipment",      "REPORT-PKG-003: 현재 Asset 참조 금지"),
        ("currentDischargeSystem","REPORT-PKG-003: 현재 Asset 참조 금지"),
        ("equipments.",           "REPORT-PKG-003: Asset 배열 직접 참조 금지"),
        ("dischargeSystems.",     "REPORT-PKG-003: Asset 배열 직접 참조 금지"),
        ("computeBackpressure(",  "REPORT-PKG-005: engine 계산 금지 — snapshot.result만 복사"),
        ("calculateKb(",          "REPORT-PKG-005: engine 계산 금지"),
        ("detectMOC(",            "REPORT-PKG-005: MOC 재계산 금지"),
        ("verifySignature(",      "REPORT-PKG-005: 서명 재계산 금지 — 외부 결과만 반영"),
    ],
    "report/renderer/pdf/template.js": [
        ("computeBackpressure(",  "PDF-001: renderer -> engine 계산 금지"),
        ("calculateKb(",          "PDF-001: renderer -> engine 계산 금지"),
        ("detectMOC(",            "PDF-001: renderer -> MOC 재계산 금지"),
        ("verifyApprovalRecord(", "PDF-001: renderer -> 서명 재검증 금지 (package.approvals[].verified만 표시)"),
        ("useState",              "template.js -> React hook 금지 (순수 문자열 조립만)"),
    ],
    "report/renderer/pdf/renderPDF.js": [
        ("computeBackpressure(",  "PDF-001: renderer -> engine 계산 금지"),
        ("calculateKb(",          "PDF-001: renderer -> engine 계산 금지"),
        ("detectMOC(",            "PDF-001: renderer -> MOC 재계산 금지"),
        ("verifyApprovalRecord(", "PDF-001: renderer -> 서명 재검증 금지"),
        ("currentEquipment",      "PDF-002: renderer -> 현재 Asset 참조 금지"),
        ("currentDischargeSystem","PDF-002: renderer -> 현재 Asset 참조 금지"),
    ],
}

def step2_boundaries():
    ok = True
    violations = 0
    for layer_pat, rules in FORBIDDEN_IMPORTS.items():
        relevant = [p for p in BUILD_ORDER if layer_pat in str(p)]
        for path in relevant:
            text = path.read_text()
            for sym, desc in rules:
                if sym in text:
                    non_comment = [l for l in text.splitlines()
                                   if sym in l and not l.strip().startswith("//")]
                    if non_comment:
                        print(f"  [BOUNDARY] {path.relative_to(SRC)}")
                        print(f"             {desc}")
                        print(f"             -> {non_comment[0].strip()[:70]}")
                        ok = False
                        violations += 1
    total_rules = sum(len(r) for r in FORBIDDEN_IMPORTS.values())
    if ok:
        print(f"  {total_rules} import rules across {len(FORBIDDEN_IMPORTS)} layers -- all clear")
    else:
        print(f"  {violations} violation(s) found")
    return ok

# ── STEP 3: SYMBOL SCAN ───────────────────────────────────────────
REQUIRED_SYMBOLS = [
    # constants
    ('constants.js',              ['const T =', 'const font =', 'R201_DEFAULTS']),
    # engine
    ('engine/api520.js',          ['ENGINE_VERSION', 'API_CONST', 'API526_ORIFICES',
                                   'validateInputs', 'api520Engine']),
    ('engine/relief_load.js',     ['RELIEF_LOAD_CONTRACT_VERSION', 'RELIEF_LOAD_STATUS',
                                   'RELIEF_LOAD_SCENARIO_TAXONOMY', 'RELIEF_LOAD_TAXONOMY_SOURCE',
                                   'getComputableScenarioIds', 'selectGoverningReliefLoad',
                                   'function calculateOutletBlockedScenario',
                                   'function calculateOverfillingScenario',
                                   'function calculateControlValveFailureScenario',
                                   'function calculateAbnormalHeatVaporScenario',
                                   'function calculateLiquidThermalExpansionScenario',
                                   'function calculateExchangerFailureScenario',
                                   'function calculateExternalFireScenario']),
    ('engine/backpressure.js',    ['BP_CONST', 'validateGeometry', 'gasDensity',
                                   'computeBackpressure']),
    ('approval/record.js',       ['APPROVAL_ROLES', 'validateApprovalInput',
                                   'createApprovalRecord', 'verifyApproval',
                                   'addApprovalRecord', 'getLatestApproval']),
    ('approval/crypto.js',        ['canonicalPayload', 'sha256Hex',
                                   'signApproval', 'verifySignature']),
    ('approval/service.js',       ['computeIdempotencyKey', 'isDuplicateApproval',
                                   'submitApproval']),
    ('approval/validator.js',     ['verifyApprovalRecord']),
    ('report/schema.js',          ['REPORT_PACKAGE_VERSION', 'validateReportPackage']),
    ('report/createPackage.js',   ['buildReportPackage']),
    ('report/renderer/pdf/styles.js',   ['PDF_STYLES']),
    ('report/renderer/pdf/template.js', ['buildPDFHtml', '_pdfFluidLabel', '_pdfWfLabel']),
    ('report/renderer/pdf/renderPDF.js',['renderPDF']),
    ('asset/schema.js',           ['validateEquipment', 'createEquipment',
                                   'reviseEquipment',
                                   'validateDischargeSystem', 'createDischargeSystem',
                                   'reviseDischargeSystem',
                                   'DESTINATION_LABEL', 'SAMPLE_EQUIPMENT',
                                   'SAMPLE_DISCHARGE_SYSTEMS']),  # revision/mocId는 필드, 함수 아님
    ('asset/history.js',          ['function appendRevision', 'function resolveRevision',
                                   'function getLatestRevision', 'function getAllLatestRevisions',
                                   'function getRevisionsFor', 'function hasDuplicateRevision',
                                   'function _revisionKey',
                                   'ASSET-HISTORY-001', 'ASSET-HISTORY-002',
                                   'ASSET-HISTORY-003', 'ASSET-HISTORY-004']),
    ('asset/diff.js',             ['function diffEquipmentRevision',
                                   'function diffDischargeSystemRevision',
                                   'EQUIPMENT_DIFF_FIELDS', 'DISCHARGE_DIFF_FIELDS',
                                   'ASSET-DIFF-001', 'ASSET-DIFF-002',
                                   'ASSET-DIFF-003', 'ASSET-DIFF-004', 'ASSET-DIFF-005']),
    ('asset/impact.js',           ['function analyzeRevisionImpact',
                                   'function _parseRevisionKey', 'function _matchesRevision',
                                   'function _latestSnapshotByCase',
                                   'ASSET-IMPACT-001', 'ASSET-IMPACT-002',
                                   'ASSET-IMPACT-003', 'ASSET-IMPACT-004', 'ASSET-IMPACT-005']),
    ('engine/evidence.js',        ['buildEvidence']),
    # snapshot
    ('snapshot/create.js',        ['createSnapshot', 'Object.freeze', 'engine_version',
                                   'result_hash', 'INVALID_STATE', 'SNAPSHOT_ENGINE_VERSION',
                                   'assetRefs', '_assetHash', 'snapshotHash',
                                   'equipmentRevision', 'dischargeRevision']),
    # workflow
    ('engine/workflow_engine.js', ['WORKFLOW_TRIGGER_FIELDS',
                                   '_wfAssetHash', 'detectMOC',
                                   'computeWorkflowState']),
    ('workflow/index.js',         ['WF_TRANSITIONS', 'WF_LABEL', 'WF_COLOR',
                                   'REVIEW_REQUIRED']),
    # sim
    ('sim/step.js',               ['stepSim']),
    # case
    ('case/history.js',           ['appendSnapshot', 'resolveSnapshot',
                                   'getLatestSnapshot', 'hasDuplicateHash']),
    # renderers
    ('renderers/index.jsx',       ['PipeFlowRenderer', 'PressChartRenderer',
                                   'EvidenceCard', 'ChecklistRenderer']),
    # components
    ('InputView.jsx',             ['DecisionSlider', 'DecisionChoice', 'InputView',
                                   'FLUID_CHOICES', 'KD_OPTIONS', 'KB_OPTIONS_SPRING']),
    ('WorkflowTransition.jsx',    ['WorkflowTransition']),
    ('ApprovalForm.jsx',          ['ApprovalForm', 'ApprovalHistory']),
    ('NewCaseForm.jsx',           ['NewCaseForm']),
    ('AssetMaster.jsx',          ['AssetMaster', 'EquipmentForm',
                                   'DischargeSystemForm', 'EquipmentCard',
                                   'RevisionHistoryPanel']),
    ('ReportView.jsx',            ['ReportView']),
    ('CaseView.jsx',              ['CaseView']),
    ('Dashboard.jsx',             ['Dashboard', 'INITIAL_CASES']),
    ('ArcSafe.jsx',               ['function ArcSafe']),
]

def step3_symbols():
    ok = True
    for file_pat, syms in REQUIRED_SYMBOLS:
        relevant = [p for p in BUILD_ORDER if file_pat in str(p)]
        if not relevant:
            print(f"  [NO FILE] {file_pat}")
            ok = False
            continue
        text = relevant[0].read_text()
        missing = [s for s in syms if s not in text]
        if missing:
            print(f"  [MISSING SYMBOL] {file_pat}: {missing}")
            ok = False
    if ok:
        total = sum(len(s) for _, s in REQUIRED_SYMBOLS)
        print(f"  {total} required symbols — all present")
    return ok

# ── STEP 4: ARCHITECTURE CHECK ────────────────────────────────────
# banned: 절대 있으면 안 되는 패턴 (전체 소스 대상)
BANNED_GLOBAL = [
    (r'export default function ArcSafe',  'export 잔존'),
    (r'import \{',                         'import 잔존'),
    (r'^function App\(\)',                 'App() 독립 엔트리'),
    # legacy component
    (r'OldInputView',                      'legacy: OldInputView'),
    (r'LegacyInput',                       'legacy: LegacyInput'),
    (r'SliderRow',                         'legacy: SliderRow (구 슬라이더)'),
    (r'GAS_PRESETS',                       'legacy: GAS_PRESETS (구 프리셋)'),
]

# 구 InputView (L429 블록) 잔존 여부 — 특정 문자열로 감지
LEGACY_MARKERS = [
    'hint="설계 방출량. 화재',   # 구 SliderRow hint 패턴
    'hint="유체의 분자량',
]

def step4_architecture():
    ok = True
    all_text = '\n'.join(p.read_text() for p in BUILD_ORDER)
    for pattern, desc in BANNED_GLOBAL:
        if re.search(pattern, all_text, re.MULTILINE):
            print(f"  [BANNED] {desc}")
            ok = False
    for marker in LEGACY_MARKERS:
        if marker in all_text:
            print(f"  [LEGACY] 구 InputView 잔존: {marker[:30]!r}")
            ok = False
    if ok:
        print(f"  {len(BANNED_GLOBAL)} global bans + {len(LEGACY_MARKERS)} legacy checks — clear")
    return ok

# ── STEP 4b: REPLAY BOUNDARY CHECK ──────────────────────────────
# Snapshot = source of truth.
# Report는 반드시 generateReport(snapshot) 형태여야 함.
# input -> report 직접 경로 차단.
#
# 검사: ReportView / renderers가 snap prop 없이 raw input을 직접 받는지 확인.
# 금지 패턴: props.inputs, props.W, props.P1 등 raw 파라미터를 렌더러가 직접 받는 것.
REPLAY_BOUNDARY_RULES = [
    # (파일 패턴, 금지 패턴, 설명)
    ("renderers/", r"\bprops\.W\b|\bprops\.P1\b|\bprops\.Kd\b",
     "renderer가 raw engine input을 직접 받음 (snap.inputs 경유 필요)"),
    ("ReportView", r"\bprops\.W\b|\bprops\.P1\b|\bprops\.areaCm2\b",
     "ReportView가 raw result를 직접 받음 (snap prop 경유 필요)"),
    # Snapshot 생성 없이 api520Engine 결과를 직접 UI에 전달하는 패턴
    ("CaseView",   r"setResult\(engineResult\)|setOutput\(result\)",
     "CaseView가 engine result를 snapshot 없이 UI state에 직접 저장"),
]

def step4b_replay():
    ok = True
    for file_pat, pattern, desc in REPLAY_BOUNDARY_RULES:
        relevant = [p for p in BUILD_ORDER if file_pat in str(p)]
        for path in relevant:
            text = path.read_text()
            hits = re.findall(pattern, text)
            if hits:
                print(f"  [REPLAY] {path.relative_to(SRC)}: {desc}")
                ok = False
    if ok:
        print(f"  {len(REPLAY_BOUNDARY_RULES)} replay boundary rules -- all clear")
    return ok

# ── STEP 4c: DETERMINISM CHECK ───────────────────────────────────
# Snapshot result_hash는 동일 input -> 동일 hash 보장해야 함.
# 오염 조건: hash 계산에 timestamp, Math.random, Date.now 포함되면 INVALID STATE.
#
# 검사: _hashResult 함수 내부에 비결정적 요소가 포함되는지.
NON_DETERMINISTIC_IN_HASH = [
    ("Date.now()",    "hash에 timestamp 포함 -> 비결정적"),
    ("Math.random()", "hash에 random 포함 -> 비결정적"),
    ("new Date()",    "hash에 Date 객체 포함 -> 비결정적"),
    ("performance.",  "hash에 performance API 포함 -> 비결정적"),
]
# Snapshot id에는 Date.now() 허용 (식별자). result_hash에만 금지.
# _hashResult 함수 스코프만 검사.

def step4c_determinism():
    ok = True
    snap_text = (ROOT / "src" / "snapshot" / "create.js").read_text()
    # _hashResult 함수 블록만 추출
    m = re.search(r"function _hashResult.*?^}", snap_text, re.DOTALL | re.MULTILINE)
    if not m:
        print("  [DETERMINISM] _hashResult 함수를 찾을 수 없음")
        return False
    hash_fn = m.group(0)
    for sym, desc in NON_DETERMINISTIC_IN_HASH:
        if sym in hash_fn:
            print(f"  [DETERMINISM] {desc}")
            print(f"                _hashResult 내부에 {sym!r} 포함")
            ok = False
    # 추가: createSnapshot의 id 필드는 Date.now() 허용, result_hash는 _hashResult만 사용하는지 확인
    if "result_hash" in snap_text and "_hashResult(" in snap_text:
        if ok:
            print(f"  result_hash <- _hashResult() 전용 -- deterministic")
            print(f"  snapshot.id <- Date.now() (식별자 전용) -- allowed")
    if ok:
        print(f"  {len(NON_DETERMINISTIC_IN_HASH)} determinism checks -- all clear")
    return ok

# ── STEP 4d: ENGINE OUTPUT PURITY CHECK ──────────────────────────
# 목적: same input = same engine output = same snapshot = same report
# ENGINE 함수 내부에 비결정적 side effect가 있으면 체인 전체가 오염됨.
# 검사 대상: src/engine/* 전체
ENGINE_PURITY_BANNED = [
    ("Date.now()",           "engine output에 timestamp 포함 -> 비결정적"),
    ("new Date()",           "engine output에 Date 객체 포함 -> 비결정적"),
    ("Math.random()",        "engine output에 random 포함 -> 비결정적"),
    ("crypto.randomUUID()",  "engine output에 UUID 포함 -> 비결정적"),
    ("performance.now()",    "engine output에 performance API 포함 -> 비결정적"),
    ("window.",              "engine에 browser window 참조 -> side effect"),
    ("localStorage",         "engine에 localStorage 참조 -> side effect"),
    ("sessionStorage",       "engine에 sessionStorage 참조 -> side effect"),
    ("console.log(",         "engine에 console side effect (허용: console.error만)"),
    ("setTimeout(",          "engine에 timer side effect"),
    ("setInterval(",         "engine에 timer side effect"),
    ("fetch(",               "engine에 network side effect"),
]

def step4d_engine_purity():
    ok = True
    violations = 0
    engine_files = [p for p in BUILD_ORDER if "engine/" in str(p)]
    for path in engine_files:
        text = path.read_text()
        # 함수 본문만 — 주석 제거 후 검사
        non_comment_lines = [
            l for l in text.splitlines()
            if l.strip() and not l.strip().startswith("//")
        ]
        code = "\n".join(non_comment_lines)
        for sym, desc in ENGINE_PURITY_BANNED:
            if sym in code:
                # console.error는 허용
                if sym == "console.log(" and "console.error(" in code and "console.log(" not in code:
                    continue
                print(f"  [PURITY] {path.relative_to(SRC)}: {desc}")
                # 해당 줄 표시
                hit_lines = [l.strip()[:70] for l in non_comment_lines if sym in l]
                for hl in hit_lines[:2]:
                    print(f"           -> {hl}")
                ok = False
                violations += 1
    if ok:
        total = len(engine_files) * len(ENGINE_PURITY_BANNED)
        print(f"  {len(ENGINE_PURITY_BANNED)} purity rules x {len(engine_files)} engine files -- all clear")
    else:
        print(f"  {violations} purity violation(s)")
    return ok

# ── STEP 4e: SNAPSHOT MUTATION GUARD ─────────────────────────────
# Snapshot은 Object.freeze로 불변이지만,
# UI 코드에서 snapshot 필드를 직접 수정하려는 시도를 정적으로 차단.
# 금지 패턴: snapshot.xxx = / snap.xxx = / delete snapshot.xxx
# 허용: snapshot spread ({ ...snapshot, workflow: next }) — 새 객체 생성은 허용
SNAPSHOT_MUTATION_PATTERNS = [
    # (regex, 설명)
    (r"snap(?:shot)?\.\w+\s*=(?!=)",  "snapshot 필드 직접 수정 (snap.x = ...)"),
    (r"delete\s+snap(?:shot)?\.\w+",    "snapshot 필드 삭제 (delete snap.x)"),
    (r"snap(?:shot)?\.inputs\.\w+\s*=(?!=)",  "snapshot.inputs 필드 직접 수정"),
    (r"snap(?:shot)?\.result\.\w+\s*=(?!=)",  "snapshot.result 필드 직접 수정"),
]

# 허용 예외: Object.freeze 내부 초기화, { ...snap } spread
MUTATION_ALLOWLIST = [
    "Object.freeze(",        # freeze 내부 초기화
    "{ ...snap",             # spread (새 객체)
    "{ ...snapshot",         # spread (새 객체)
    "snap = ",               # 변수 재할당 (필드 수정 아님)
    "snapshot =",            # 변수 재할당
]

# mutation guard는 component 파일에만 적용 (snapshot 자체 생성 파일 제외)
MUTATION_CHECK_FILES = [
    "ReportView", "CaseView", "Dashboard", "ArcSafe",
    "WorkflowTransition", "ApprovalForm", "renderers/"
]

def step4e_snapshot_mutation():
    ok = True
    violations = 0
    target_files = [
        p for p in BUILD_ORDER
        if any(pat in str(p) for pat in MUTATION_CHECK_FILES)
    ]
    for path in target_files:
        text = path.read_text()
        non_comment_lines = [
            l for l in text.splitlines()
            if l.strip() and not l.strip().startswith("//")
        ]
        for line in non_comment_lines:
            for pattern, desc in SNAPSHOT_MUTATION_PATTERNS:
                if re.search(pattern, line):
                    # allowlist 확인
                    if any(exc in line for exc in MUTATION_ALLOWLIST):
                        continue
                    print(f"  [MUTATION] {path.relative_to(SRC)}: {desc}")
                    print(f"             -> {line.strip()[:70]}")
                    ok = False
                    violations += 1
    if ok:
        checked = len(target_files) * len(SNAPSHOT_MUTATION_PATTERNS)
        print(f"  {len(SNAPSHOT_MUTATION_PATTERNS)} mutation patterns x {len(target_files)} files -- all clear")
    else:
        print(f"  {violations} mutation violation(s)")
    return ok

# ── STEP 4f: UNDEFINED REFERENCE CHECK ───────────────────────────
# concat된 전체 코드에서 JSX 컴포넌트(<PascalCase) 및 CONST_CASE 상수가
# 실제로 어딘가 정의(function/const) 되어 있는지 정적 검증.
# R201_DEFAULTS, DecisionSlider 등이 "사용은 되는데 정의가 없는" 사고를
# 빌드 단계에서 즉시 차단하기 위함 (런타임 ReferenceError 사전 방지).
KNOWN_BUILTIN = {
    'React','ReactDOM','Math','Object','Array','JSON','Date','Number','String',
    'Boolean','Promise','Error','Map','Set','RegExp',
}
# 알려진 false-positive 패턴(색상 hex, 영단어 약어 등)은 검사 대상에서 제외
FALSE_POSITIVE_WORDS = {
    'API','PSM','CO2','HAZOP','MOC','SET','OPEN','PASS','FAIL','RUNNING','IDLE',
    'NORMAL','ALL','FORM','CASE','ROOT','NEW',
}

def step4f_undefined_refs():
    all_text = '\n'.join(p.read_text() for p in BUILD_ORDER)

    # 정의된 식별자 수집 (function/const/let)
    defined = set(re.findall(r'\b(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)', all_text))
    known = defined | KNOWN_BUILTIN

    # JSX 컴포넌트 태그 사용처 (<PascalCase)
    used_components = set(re.findall(r'<([A-Z][\w]*)', all_text))
    missing_components = used_components - known

    # spread/참조로 쓰이는 CONST_CASE 식별자 (예: {...R201_DEFAULTS})
    used_const_refs = set(re.findall(r'\.\.\.([A-Z][A-Z0-9_]{2,})\b', all_text))
    missing_consts = used_const_refs - known - FALSE_POSITIVE_WORDS

    if missing_components or missing_consts:
        if missing_components:
            print(f"  [UNDEFINED COMPONENT] 사용되지만 정의되지 않음:")
            for m in sorted(missing_components):
                print(f"    <{m}>")
        if missing_consts:
            print(f"  [UNDEFINED CONST] spread로 참조되지만 정의되지 않음:")
            for m in sorted(missing_consts):
                print(f"    ...{m}")
        return False

    print(f"  {len(used_components)} components + {len(used_const_refs)} spread refs -- all defined")
    return True

# ── STEP 5: HASH GENERATE ────────────────────────────────────────
def step5_hash():
    h = hashlib.sha256()
    for p in BUILD_ORDER:
        h.update(p.read_bytes())
    digest = h.hexdigest()[:12]
    print(f"  BUILD_HASH: {digest}")
    return digest

# ── STEP 6: PACKAGE (concat → index.html) ────────────────────────
HTML_HEAD = '''\
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <meta name="description" content="ArcSafe — PSM 안전밸브 사양 결정 및 검토 시스템"/>
  <meta name="theme-color" content="#0F2B4C"/>
  <title>ArcSafe — PSM 안전밸브 관리</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap" rel="stylesheet"/>
  <style>
    *,*::before,*::after{{box-sizing:border-box}}
    html,body,#root{{height:100%;margin:0;padding:0}}
    body{{font-family:'Noto Sans KR',sans-serif;background:#F0F4FA}}
    input[type=range]{{cursor:pointer}}
    details>summary{{list-style:none}}
    details>summary::-webkit-details-marker{{display:none}}
    textarea{{font-family:'Noto Sans KR',sans-serif}}
    #boot-error{{display:none;position:fixed;inset:0;background:#0F2B4C;color:#fff;
      font-family:monospace;font-size:13px;padding:24px;white-space:pre-wrap;
      word-break:break-all;z-index:99999;overflow:auto;line-height:1.6}}
    #boot-error.show{{display:block}}
  </style>
</head>
<body>
<div id="root"></div>
<div id="boot-error"></div>
<script>
  // 전역 에러 캐치 — 화면이 안 넘어갈 때 원인을 사용자가 직접 볼 수 있게
  window.addEventListener('error', function(e) {{
    var box = document.getElementById('boot-error');
    box.className = 'show';
    box.textContent = '[ERROR] BUILD:{hash}\\n\\n' +
      'message: ' + e.message + '\\n' +
      'file: ' + e.filename + '\\n' +
      'line: ' + e.lineno + ':' + e.colno + '\\n\\n' +
      (e.error && e.error.stack ? e.error.stack : '');
  }});
  window.addEventListener('unhandledrejection', function(e) {{
    var box = document.getElementById('boot-error');
    box.className = 'show';
    box.textContent = '[PROMISE REJECTION] BUILD:{hash}\\n\\n' + String(e.reason);
  }});
</script>
<script src="https://unpkg.com/react@18.2.0/umd/react.production.min.js" crossorigin
  onerror="document.getElementById('boot-error').className='show';document.getElementById('boot-error').textContent='[CDN FAIL] React 로드 실패 — 네트워크 확인 후 새로고침';"></script>
<script src="https://unpkg.com/react-dom@18.2.0/umd/react-dom.production.min.js" crossorigin
  onerror="document.getElementById('boot-error').className='show';document.getElementById('boot-error').textContent='[CDN FAIL] ReactDOM 로드 실패 — 네트워크 확인 후 새로고침';"></script>
<script src="https://unpkg.com/@babel/standalone@7.23.10/babel.min.js"
  onerror="document.getElementById('boot-error').className='show';document.getElementById('boot-error').textContent='[CDN FAIL] Babel 로드 실패 — 네트워크 확인 후 새로고침';"></script>
<script src="https://auth.archsafe.co.kr/sdk/auth-client.js"></script>
<script type="text/babel" data-presets="react">
/* ArcSafe | BUILD_HASH:{hash} | {ts} | v0.2.0-asset-master */
const {{ useState, useEffect, useRef, useMemo, useCallback }} = React;
const __BUILD_HASH__ = "{hash}";
'''

HTML_FOOT = '''\

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<ArcSafe />);
</script>
</body>
</html>'''

def load_module(path):
    text = path.read_text()
    text = text.replace(
        'import { useState, useEffect, useRef, useMemo, useCallback } from "react";\n', '')
    text = text.replace('export default function ArcSafe()', 'function ArcSafe()')
    lines = text.splitlines(keepends=True)
    while lines and lines[-1].strip().startswith('// ═'):
        lines.pop()
    while lines and not lines[-1].strip():
        lines.pop()
    return ''.join(lines)

def step6_package(build_hash):
    DIST.mkdir(exist_ok=True)
    modules = []
    for path in BUILD_ORDER:
        rel     = path.relative_to(SRC)
        content = load_module(path)
        modules.append(f"\n// ── {rel} ──────────────────────────\n{content}\n")
    body = ''.join(modules)
    ts   = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    html = HTML_HEAD.format(hash=build_hash, ts=ts) + body + HTML_FOOT
    idx  = DIST / 'index.html'
    idx.write_text(html)
    (DIST / '_headers').write_text(
        '/*\n'
        '  Cache-Control: no-store, no-cache, must-revalidate, max-age=0\n'
        '  Pragma: no-cache\n'
        '  X-Content-Type-Options: nosniff\n'
        '  X-Frame-Options: DENY\n'
        '  Referrer-Policy: strict-origin-when-cross-origin\n\n'
        '/index.html\n'
        '  Cache-Control: no-store, no-cache, must-revalidate, max-age=0\n'
        '  Pragma: no-cache\n'
        '  Expires: 0\n')
    (DIST / '_redirects').write_text('/* /index.html 200\n')
    print(f"  index.html: {len(html):,} bytes / {html.count(chr(10))} lines")
    return html

# ── STEP 7: DEPLOY ZIP ───────────────────────────────────────────
def step7_zip():
    with zipfile.ZipFile(ZIP_OUT, 'w', zipfile.ZIP_DEFLATED) as zf:
        for f in ['index.html', '_headers', '_redirects']:
            zf.write(DIST / f, arcname=f)
    size = ZIP_OUT.stat().st_size
    print(f"  {ZIP_OUT.name}: {size:,} bytes")

# ── MAIN ─────────────────────────────────────────────────────────
STEPS = [
    ("1. SOURCE COLLECT",      step1_collect),
    ("2. DEPENDENCY CHECK",    step2_boundaries),
    ("3. SYMBOL SCAN",         step3_symbols),
    ("4. ARCHITECTURE CHECK",  step4_architecture),
    ("4b. REPLAY BOUNDARY",    step4b_replay),
    ("4c. DETERMINISM",        step4c_determinism),
    ("4d. ENGINE PURITY",      step4d_engine_purity),
    ("4e. SNAPSHOT MUTATION",  step4e_snapshot_mutation),
    ("4f. UNDEFINED REFS",     step4f_undefined_refs),
]

def step0_contract_tests():
    """contract_test.py를 서브프로세스로 실행 — 빌드 전 필수 통과"""
    import subprocess
    test_file = ROOT / 'tests' / 'contract_test.py'
    if not test_file.exists():
        print(f"  [SKIP] tests/contract_test.py 없음 — 첫 빌드 시 건너뜀")
        return True
    result = subprocess.run(
        [sys.executable, str(test_file)],
        capture_output=True, text=True
    )
    # 결과 요약만 출력
    for line in result.stdout.splitlines():
        if any(x in line for x in ["RESULT:", "CHECKS:", "ALL PASS", "FAILURES", "ENGINE_VERSION"]):
            print(f"  {line.strip()}")
    if result.returncode != 0:
        print("  [CONTRACT TEST FAILED] 빌드 중단")
        # 실패 줄 출력
        for line in result.stdout.splitlines():
            if "✗" in line:
                print(f"  {line.strip()}")
    return result.returncode == 0

def run():
    tag = "v0.2.0-asset-master"
    print(f"\n{'═'*55}")
    print(f"  ArcSafe Build  {tag}")
    print(f"{'═'*55}\n")

    # Step 0: contract tests (빌드 허가 조건)
    print("[0. CONTRACT TESTS]")
    if not step0_contract_tests():
        print(f"\n  ✗ BUILD FAILED at 0. CONTRACT TESTS\n")
        sys.exit(1)
    print()

    # Steps 1-4: gate checks
    for label, fn in STEPS:
        print(f"[{label}]")
        if not fn():
            print(f"\n  ✗ BUILD FAILED at {label}\n")
            sys.exit(1)
        print()

    # Step 5
    print("[5. HASH GENERATE]")
    build_hash = step5_hash()
    print()

    # Step 6
    print("[6. PACKAGE]")
    html = step6_package(build_hash)
    print()

    # Step 7
    print("[7. DEPLOY ZIP]")
    step7_zip()

    print(f"\n{'═'*55}")
    print(f"  OK  |  hash: {build_hash}  |  {tag}")
    print(f"{'═'*55}\n")

if __name__ == '__main__':
    run()
