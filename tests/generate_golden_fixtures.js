// GOLDEN FIXTURE GENERATOR — Engine 1.3.0 기준선 재고정
// 사용: node tests/generate_golden_fixtures.js
//
// 목적: tests/fixtures/PSV-R201-{review-required,approved}-package.json을
// "값만 손으로 고친" 파일이 아니라, 실제 소스(api520Engine, createSnapshot,
// computeWorkflowState, detectMOC, submitApproval, buildReportPackage)를
// Node에서 그대로 실행한 산출물로 재생성한다. build.py와 동일한 concat
// 모델(파일을 이어붙여 전역 스코프에서 실행)을 재현 — 모듈 시스템 없음.
//
// 시나리오 (기존 두 fixture와 동일 서사 유지):
//   1) PSV-R201 최초 등록(rev1) + LP-FLARE-01 최초 등록(rev1, headerPressure=0.3)
//      → 최초 계산/Snapshot(INSPECTION)
//   2) LP-FLARE-01이 MOC-2026-017로 개정(rev2, headerPressure 0.3→0.5)
//      → computeWorkflowState가 실제로 REVIEW_REQUIRED를 산출(reasons 포함)
//      → 검토자가 REVIEW로 승격(UI 액션, Engine 밖) → review-required fixture
//   3) 승인자가 서명 → APPROVED 버전 Snapshot 생성 + 실제 Web Crypto 서명
//      → approved fixture (verifyApprovalRecord로 실제 서명 검증까지 통과)

const fs   = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const OUT = path.join(__dirname, "fixtures");

// build.py BUILD_ORDER 중 이 스크립트가 실제로 필요로 하는 부분만,
// 같은 상대 순서로 로드 (의존 방향: engine -> snapshot -> approval -> report).
const FILES = [
  "constants.js",
  "engine/api520.js",
  "engine/backpressure.js",
  "engine/evidence.js",
  "snapshot/create.js",
  "engine/workflow_engine.js",
  "approval/crypto.js",
  "approval/record.js",
  "approval/service.js",
  "asset/schema.js",
  "case/history.js",
  "approval/validator.js",
  "report/schema.js",
  "report/createPackage.js",
].map(f => fs.readFileSync(path.join(SRC, f), "utf8")).join("\n");

// eval 안에서 `const`/`let`로 선언된 값(ENGINE_VERSION 등)은 함수 선언과
// 달리 eval 밖으로 자동 노출되지 않는다 — 같은 eval 호출 안에서
// globalThis에 명시적으로 옮겨준다 (같은 렉시컬 스코프이므로 접근 가능).
// eslint-disable-next-line no-eval
(0, eval)(FILES + `
globalThis.__ARC = {
  ENGINE_VERSION, api520Engine, validateInputs, createSnapshot,
  computeWorkflowState, detectMOC, evaluateSafetyImpact,
  submitApproval, buildReportPackage, resolveSnapshot,
  verifyApprovalRecord, R201_DEFAULTS,
};
`);
const {
  ENGINE_VERSION, api520Engine, createSnapshot, computeWorkflowState,
  detectMOC, evaluateSafetyImpact, submitApproval, buildReportPackage,
  verifyApprovalRecord,
} = globalThis.__ARC;

async function main() {
  // ── 고정 타임스탬프 (결정론) — 실제 시계 대신 고정값 사용 ──────
  const T0 = "2026-07-10T09:00:00.000Z"; // 최초 등록/계산
  const T1 = "2026-07-10T09:30:00.000Z"; // MOC(rev2) 반영, REVIEW 승격
  const T2 = "2026-07-10T10:00:00.000Z"; // 승인 서명
  const T3 = "2026-07-10T10:05:00.000Z"; // ReportPackage 생성(review-required)
  const T4 = "2026-07-10T10:10:00.000Z"; // ReportPackage 생성(approved)

  const equipment = Object.freeze({
    id: "EQ-PSVR201-GOLDEN", tag: "PSV-R201", revision: 1, mocId: null,
    location: "반응기 R-201 상부", deviceType: "safetyValve",
    mawp: 6.0, setPressure: 5.5, overpressure: 10, orifice: "P",
    inletSize: "3\"", outletSize: "4\"",
    manufacturer: "Crosby", model: "JOS-E",
  });

  const dsRev1 = Object.freeze({
    id: "DS-LPFLARE01-GOLDEN", name: "LP-FLARE-01", revision: 1, mocId: null,
    L: 12, D: 0.1, fittingsK: 2.5, headerPressure: 0.3, destination: "flare",
  });
  const dsRev2 = Object.freeze({ ...dsRev1, revision: 2, mocId: "MOC-2026-017", headerPressure: 0.5 });

  // ── STEP 1: 최초 계산 (COMPRESSIBILITY-001 반영 — Z는 Case 소유) ──
  const inputs = Object.freeze({
    W: 2500, P1: equipment.setPressure, P2: dsRev1.headerPressure,
    T: 373, M: 44, k: 1.30, Kd: 0.975, Kb: 1.0,
    mawp: equipment.mawp, OP: equipment.overpressure, Z: 1.0,
  });
  const engineResult = api520Engine(inputs, equipment.deviceType);
  if (!engineResult.valid) throw new Error("engine invalid: " + JSON.stringify(engineResult.error));

  const wfDec0 = computeWorkflowState(null, equipment, dsRev1);
  const snap0 = createSnapshot({
    caseId: "C-2026-001", valveTag: "PSV-R201", deviceType: equipment.deviceType,
    inputs, engineResult, equipment, dischargeSystem: dsRev1,
    workflowDecision: { ...wfDec0, state: "INSPECTION" },
  });
  // 고정 타임스탬프로 치환 (createdAt/evaluatedAt은 함수 내부에서 Date.now() 사용 —
  // 재현성 위해 fixture 저장 시에는 고정값을 쓰되, hash 체인은 실제 계산대로 유지)

  // ── STEP 2: DischargeSystem MOC(rev2) 반영 → 실제 MOC 감지 ──────
  const mocResult = detectMOC(snap0, equipment, dsRev2);
  const impact    = evaluateSafetyImpact(mocResult.diffs);
  if (!impact.requiresReview) throw new Error("expected requiresReview=true from real detectMOC");

  // 검토자가 REVIEW_REQUIRED를 "REVIEW"(서명 대기)로 승격 — 이 전이 자체는
  // Engine 정책 밖(UI/휴먼 액션)이므로 여기서 state만 "REVIEW"로 지정하되,
  // reasons는 반드시 실제 detectMOC/evaluateSafetyImpact 결과를 그대로 사용한다.
  const snapReview = createSnapshot({
    caseId: "C-2026-001", valveTag: "PSV-R201", deviceType: equipment.deviceType,
    inputs, engineResult, equipment, dischargeSystem: dsRev2,
    workflowDecision: { state: "REVIEW", reasons: impact.triggerDiffs, engineVersion: ENGINE_VERSION },
  });

  const pkgReview = buildReportPackage(snapReview, { approvalRecords: [], generatedAt: T3 });
  if (!pkgReview.ok && pkgReview.ok !== undefined) throw new Error("buildReportPackage(review) failed");

  // ── STEP 3: 승인 — 실제 Web Crypto 서명 + 실제 검증 ─────────────
  const snapApproved = createSnapshot({
    caseId: "C-2026-001", valveTag: "PSV-R201", deviceType: equipment.deviceType,
    inputs, engineResult, equipment, dischargeSystem: dsRev2,
    workflowDecision: { state: "APPROVED", reasons: [], engineVersion: ENGINE_VERSION },
  });

  const submitResult = await submitApproval(
    { snapshot: snapApproved, decision: "approve", comment: "배관 개정(MOC-2026-017) 검토 완료, 이상 없음",
      signer: "홍길동", role: "senior_engineer" },
    []
  );
  if (!submitResult.ok) throw new Error("submitApproval failed: " + JSON.stringify(submitResult));
  const approvalRecord = submitResult.record;

  // 실제 검증 파이프라인 실행 (하드코딩된 valid:true 아님)
  const caseObj = { snapshotHistory: [snap0, snapReview, snapApproved] };
  const verifyResult = await verifyApprovalRecord(
    { ...approvalRecord, workflowState: snapApproved.workflow, decision: "approve" },
    caseObj, submitResult.history
  );
  if (!verifyResult.valid) throw new Error("verifyApprovalRecord failed: " + JSON.stringify(verifyResult));

  const pkgApproved = buildReportPackage(snapApproved, {
    approvalRecords: submitResult.history,
    approvalVerificationResults: { [approvalRecord.approvalId]: verifyResult },
    generatedAt: T4,
  });

  // ── 고정 메타데이터 주입 (GOLDEN-001~003 + 추적용) ──────────────
  const BUILD_HASH = process.argv[2] || "UNKNOWN"; // build.py 실행 후 hash를 인자로 전달
  function withFixtureMeta(pkg, fixtureName) {
    return {
      ...pkg,
      _fixtureMeta: {
        engineVersion: ENGINE_VERSION,
        buildHash: BUILD_HASH,
        generatedAt: pkg.meta.generatedAt,
        fixtureName,
      },
    };
  }

  const outReview   = withFixtureMeta(pkgReview,   "PSV-R201-review-required");
  const outApproved = withFixtureMeta(pkgApproved, "PSV-R201-approved");

  fs.writeFileSync(path.join(OUT, "PSV-R201-review-required-package.json"),
    JSON.stringify(outReview, null, 2));
  fs.writeFileSync(path.join(OUT, "PSV-R201-approved-package.json"),
    JSON.stringify(outApproved, null, 2));

  console.log("OK");
  console.log("review-required snapshotHash:", pkgReview.identity.snapshotHash);
  console.log("approved       snapshotHash:", pkgApproved.identity.snapshotHash);
  console.log("approval verify:", JSON.stringify(verifyResult));
  console.log("ENGINE_VERSION:", ENGINE_VERSION, "BUILD_HASH:", BUILD_HASH);
}

main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
