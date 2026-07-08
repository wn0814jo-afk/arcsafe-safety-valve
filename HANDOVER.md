# ArcSafe 인수인계 문서
**버전:** v0.2.0-asset-master  
**BUILD_HASH:** 9a31b718913e  
**Contract Tests:** 199/199 PASS  
**날짜:** 2026-07-05

---

## 1. 제품 정의

ArcSafe는 **PSM 안전밸브 사양 관리 시스템**입니다.  
단순 API 520/526 계산기가 아니라 **"설계 결정을 법적 기록으로 변환하는 시스템"**입니다.

```
Input → Engine → Snapshot → Report
                    ↑
          Asset + MOC + Workflow Decision Trace
```

---

## 2. 핵심 아키텍처 원칙 (절대 변경 불가)

| 원칙 | 내용 |
|------|------|
| Engine = Pure | side effect 0, Date/random/storage 금지 |
| Snapshot = Immutable | Object.freeze 3중, 생성 후 수정 불가 |
| Report = Projection only | Snapshot만 읽음, 계산 금지 |
| Workflow = Engine 단독 결정 | UI가 workflow 상태 변경 금지 |
| ApprovalRecord = 별도 증명 | Snapshot을 수정하지 않고 참조만 |

---

## 3. 소스 구조

```
src/
├── constants.js                 T(색상), font, R201_DEFAULTS
├── engine/
│   ├── api520.js                API 520 기체 방출 계산 (순수함수)
│   ├── backpressure.js          API 521 배압 계산 (순수함수)
│   ├── evidence.js              계산 근거 텍스트 생성
│   └── workflow_engine.js       ★ Workflow 결정 (3계층)
│                                  detectMOC() → Fact
│                                  evaluateSafetyImpact() → Analysis
│                                  computeWorkflowState() → Policy
├── snapshot/
│   └── create.js                createSnapshot() — evaluatedAt, snapshotHash 생성
├── workflow/
│   └── index.js                 WF_TRANSITIONS, WF_LABEL, WF_COLOR, REVIEW_REQUIRED
├── approval/
│   └── record.js                ApprovalRecord — APPROVAL-001/002/003 계약
├── asset/
│   └── schema.js                PSVEquipment, DischargeSystem, SAMPLE_*
├── sim/
│   └── step.js                  압력 시뮬레이션 (시간 전용)
└── components/
    ├── ArcSafe.jsx              Root — 상태 관리
    ├── Dashboard.jsx            대시보드
    ├── AssetMaster.jsx          설비대장 (Equipment + DischargeSystem)
    ├── CaseView.jsx             케이스 뷰 — Engine 호출, Snapshot 생성
    ├── InputView.jsx            사양 결정 UI (파라미터 선택)
    ├── ReportView.jsx           결과 표시 (Snapshot projection만)
    ├── WorkflowTransition.jsx   Workflow 전환 UI
    ├── NewCaseForm.jsx          신규 케이스 등록 폼
    └── renderers/
        └── index.jsx            PipeFlowRenderer, PressChartRenderer 등
```

---

## 4. Snapshot 스키마

```javascript
{
  id,                  // SNAP-{caseId}-{timestamp}
  createdAt,           // evaluatedAt과 동일
  caseId,
  valveTag,
  deviceType,          // "safetyValve" | "ruptureDisk"
  engine_version,      // "1.1.0"
  result_hash,         // engine inputs 기반 hash (결정론 검증)
  snapshotHash,        // Snapshot 전체 fingerprint (Approval 서명 대상)
  
  assetRefs: {         // 검토 시점 Asset 식별자
    equipmentId, equipmentTag, equipmentRevision,
    dischargeSystemId, dischargeSystemName, dischargeRevision,
    assetFingerprint,  // MOC 감지용
  },
  
  workflowDecision: {  // Engine 결정 trace (감사 재현용)
    state,             // 결정된 workflow 상태
    evaluatedAt,       // Snapshot 생성 시점 (Engine이 생성 안 함)
    engineVersion,
    reasons: [...],    // detectMOC() diffs 원본 (재조립 없음)
    triggerFields: [], // 판단 기준 필드 목록
  },
  
  equipment,           // 검토 시점 PSVEquipment 복사본
  dischargeSystem,     // 검토 시점 DischargeSystem 복사본
  inputs,              // 운전 조건 (W, P1, T, M, k, Kd, Kb, mawp)
  result,              // api520Engine() 출력
  evidence,            // buildEvidence() 출력
  workflow,            // 현재 workflow 상태
}
```

---

## 5. ApprovalRecord 스키마 (v0.2.0 추가)

```javascript
// Snapshot을 수정하지 않음 — snapshotHash로 참조만
{
  approvalId,          // APPR-{snapshotId}-{timestamp}
  snapshotId,          // 대상 Snapshot ID
  snapshotHash,        // 서명 대상 fingerprint (APPROVAL-002 검증용)
  approver,            // 승인자 이름
  role,                // engineer | senior_engineer | safety_manager | pss_manager
  approvedAt,          // 승인 시점
  comment,             // 승인 의견
}
```

**3개 계약:**
- **APPROVAL-001:** snapshotHash 없으면 생성 불가
- **APPROVAL-002:** `verifyApproval(record, snap)` — hash 불일치 시 변조 감지
- **APPROVAL-003:** `addApprovalRecord(history, record)` — push만, replace 금지

---

## 6. Workflow 상태 흐름

```
DRAFT → INSPECTION → REVIEW → APPROVED → CLOSED
                   ↘ ACTION_REQUIRED ↗

어느 상태에서든:
  MOC 감지 + trigger field 변경 → REVIEW_REQUIRED → INSPECTION
```

**Trigger Fields (재검토 필수):**  
`headerPressure, L, D, fittingsK, destination, setPressure, mawp, orifice, deviceType`

---

## 7. Build Pipeline (14단계)

```bash
cd arcsafe/
python3 build.py
```

| 단계 | 내용 |
|------|------|
| 0. CONTRACT TESTS | 199개 contract test |
| 1. SOURCE COLLECT | 24개 소스 파일 |
| 2. DEPENDENCY CHECK | 32개 import 방향 규칙 |
| 3. SYMBOL SCAN | 필수 심볼 존재 확인 |
| 4. ARCHITECTURE CHECK | banned 패턴 + legacy |
| 4b. REPLAY BOUNDARY | input→report 직접 경로 차단 |
| 4c. DETERMINISM | _hashResult 비결정적 요소 차단 |
| 4d. ENGINE PURITY | engine 파일 side effect 금지 |
| 4e. SNAPSHOT MUTATION | snap.x = 패턴 차단 |
| 4f. UNDEFINED REFS | JSX 컴포넌트 미정의 감지 |
| 5. HASH GENERATE | 소스 SHA-256 hash |
| 6. PACKAGE | concat → index.html |
| 7. DEPLOY ZIP | CF Pages 배포 zip |

---

## 8. 다음 작업 (미완성)

### 즉시 가능
- **Approval UI** — ApprovalRecord를 생성하는 UI (ApprovalForm 컴포넌트)
- **Report에 Approval 표시** — verifyApproval() 결과 표시
- **Geometry 입력 UI** — InputView에 DischargeSystem geometry 직접 입력 필드

### 다음 스프린트
- **전자서명** — snapshotHash 기반 서명 (Web Crypto API)
- **PDF 출력** — Snapshot → PSM 제출 문서
- **Asset 수정 이력** — revision 증가 + MOC 번호 관리 UI

---

## 9. 배포 방법

**Cloudflare Pages 직접 업로드:**
```
ArcSafe-CF-DEPLOY.zip → CF Pages → 직접 업로드 → zip 드래그
```

배포 확인: 헤더에서 `v0.2.0 · 9a31b718913e` 확인

---

## 10. 샘플 데이터 (초기 로드)

**Equipment 3개:**
- PSV-R201 (CO₂ 반응기, SET 5.5b, Crosby JOS-E)
- PSV-R302 (N₂ 퍼지, SET 12.0b, Anderson Greenwood)
- PSV-S12 (Steam, SET 8.0b, Crosby HB-BP)

**DischargeSystem 3개:**
- LP-FLARE-01 (L=12m, Ø100mm, P_hdr=0.3b) → PSV-R201
- HP-FLARE-01 (L=8m, Ø75mm, P_hdr=0.5b) → PSV-R302
- STM-FLARE-01 (L=25m, Ø100mm, P_hdr=1.2b) → PSV-S12
