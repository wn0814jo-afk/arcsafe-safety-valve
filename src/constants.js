// ════════════════════════════════════════════════════════════════
//  DESIGN TOKENS
// ════════════════════════════════════════════════════════════════
const T = {
  // 브랜드
  navy:    "#0F2B4C",  navyMid: "#1A3F6F",  navyLight: "#1E4D8C",
  blue:    "#1CB0F6",  blueDk:  "#0A91C7",  blueBg:    "#DDF4FF",
  // 상태
  green:   "#58CC02",  greenDk: "#46A302",  greenBg:   "#D7FFB8",
  red:     "#FF4B4B",  redDk:   "#C0392B",  redBg:     "#FFDFE0",
  orange:  "#FF9600",  orangeBg:"#FFF0D4",
  yellow:  "#FFC800",  yellowBg:"#FFF8CC",
  // 뉴트럴
  white:   "#FFFFFF",  bg:      "#F0F4FA",
  border:  "#E2E8F0",  gray:    "#AFAFAF",
  text:    "#1A2332",  sub:     "#64748B",
  cardBg:  "#FFFFFF",
};

const font = { mono: "'JetBrains Mono','Courier New',monospace", sans: "'Noto Sans KR',sans-serif" };

// R-201 CO2 반응기 — engine input 기본값
// InputView, CaseView 양쪽에서 사용 (constants에 위치해 BUILD_ORDER 최상단 보장)
const R201_DEFAULTS = {
  W:2500, P1:5.5, P2:0.3, T:373, M:44, k:1.3, Kd:0.975, Kb:1.0, mawp:6.0, OP:10, Z:1.0,
  valveType:"SPRING" // VALVE-TYPE-001: 기본값 스프링식 — 기존 케이스와 동일 판정 유지
};

// ════════════════════════════════════════════════════════════════
