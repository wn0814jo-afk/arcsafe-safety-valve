//  WORKFLOW STATE MACHINE
//  DRAFT → INSPECTION → REVIEW → APPROVED → CLOSED
//  언제든 MOC 감지 시 → REVIEW_REQUIRED (자동 전환)
// ════════════════════════════════════════════════════════════════
const WF_TRANSITIONS = {
  DRAFT:            ["INSPECTION"],
  INSPECTION:       ["REVIEW", "ACTION_REQUIRED"],
  REVIEW:           ["APPROVED", "ACTION_REQUIRED"],
  ACTION_REQUIRED:  ["INSPECTION"],
  APPROVED:         ["CLOSED"],
  CLOSED:           [],
  // MOC 감지 시 자동 진입 — 어느 상태에서도 전환 가능
  REVIEW_REQUIRED:  ["INSPECTION"],
};

const WF_LABEL = {
  DRAFT:            "초안",
  INSPECTION:       "검토 중",
  REVIEW:           "승인 대기",
  ACTION_REQUIRED:  "조치 필요",
  APPROVED:         "승인 완료",
  CLOSED:           "종결",
  REVIEW_REQUIRED:  "재검토 필요",
};

const WF_COLOR = {
  DRAFT:            "#AFAFAF",
  INSPECTION:       "#1CB0F6",
  REVIEW:           "#FFC800",
  ACTION_REQUIRED:  "#FF4B4B",
  APPROVED:         "#58CC02",
  CLOSED:           "#64748B",
  REVIEW_REQUIRED:  "#FF4B4B",  // 빨간색 — 주의 필요
};

// Review Trigger 판정 → engine/workflow_engine.js 로 이동
// WORKFLOW_TRIGGER_FIELDS + computeWorkflowState() 참조
// workflow/index.js는 상태 정의(레이블/색상/전환)만 담당
