//  CASE REPOSITORY — Device-local persistence (IndexedDB). Sprint C-4.22-B.
// ════════════════════════════════════════════════════════════════
//  PERSISTENCE-001: 이 파일은 순수하게 "바깥 계층"이다. Engine
//  (api520.js/relief_load.js/backpressure.js) / Snapshot(create.js) /
//  Report(createPackage.js 등)는 이 파일을 절대 참조하지 않는다 —
//  참조 방향은 항상 UI(ArcSafe.jsx/CaseView.jsx) → CaseRepository →
//  IndexedDB 한쪽으로만 흐른다. createSnapshot()/api520Engine() 등은
//  이번 스프린트에서 한 글자도 수정하지 않았다.
//
//  PERSISTENCE-002: 저장은 계산의 correctness에 영향을 주지 않는다.
//  모든 메서드는 실패해도 절대 throw하지 않고 {ok:false, error}를
//  반환한다 — 호출부(ArcSafe.jsx/CaseView.jsx)는 이 결과로 저장
//  성공/실패 "표시"만 하고, Engine 계산·화면 렌더링은 저장 성공 여부와
//  무관하게 그대로 진행한다.
//
//  PERSISTENCE-003: 서버로는 아무것도 보내지 않는다. fetch/XHR을
//  이 파일에서 호출하지 않는다 — 전부 브라우저 IndexedDB API만 사용.
//
//  PERSISTENCE-004: CaseRepository는 React state의 또 다른 사본이
//  아니다. 저장/조회 메서드 7개(load/saveCase/saveApproval/saveDraft/
//  loadDraft/saveEquipmentRevision/saveDischargeRevision)만 제공하고,
//  샘플 시드 데이터·UI 정책(몇 개까지 저장할지 등)은 이 파일에 두지
//  않는다 — 그건 ArcSafe.jsx(호출부)의 책임이다.
//
//  PERSISTENCE-005 (소프트 삭제 대비): 이 파일은 지금 삭제 UI/로직을
//  전혀 구현하지 않는다. 다만 saveCase()는 caseObj를 있는 그대로
//  저장하므로, 향후 caseObj에 deletedAt 필드를 얹어 saveCase()를
//  호출하는 것만으로 소프트 삭제를 얹을 수 있다 — load()가 필터링
//  로직을 추가하면 된다. 지금은 그 필터링도 하지 않는다(요구사항 없음).
//  Snapshot을 물리적으로 삭제하는 메서드는 이 파일에 존재하지 않는다.
// ════════════════════════════════════════════════════════════════

const CASE_REPO_DB_NAME    = "arcsafe-safety-valve-db";
const CASE_REPO_DB_VERSION = 1;
// Equipment/DischargeSystem 레코드에 실어보내는 데이터 스키마 버전.
// IndexedDB 자체의 스키마 버전(CASE_REPO_DB_VERSION, onupgradeneeded)과는
// 별개 — 이건 "저장된 값 모양"이 나중에 바뀔 때를 위한 것.
const CASE_REPO_SCHEMA_VERSION = 1;

const CASE_REPO_STORES = Object.freeze({
  EQUIPMENT_HISTORY: "equipmentHistory", // keyPath: _key (`${id}@${revision}`)
  DISCHARGE_HISTORY: "dischargeHistory", // keyPath: _key
  CASES:             "cases",            // keyPath: id — Case 전체(메타+snapshotHistory+approvals) 통짜 저장
  CASE_DRAFTS:       "caseDrafts",       // keyPath: caseId — CaseView 로컬 입력 state
});

function _caseRepoDescribeError(err) {
  if (!err) return "UNKNOWN_ERROR";
  if (typeof err === "string") return err;
  return err.message || err.name || "UNKNOWN_ERROR";
}

// 연결을 매번 새로 열지 않고 하나만 캐싱해서 재사용한다 — 그렇지 않으면
// 연결이 계속 쌓여 나중에 wipeAll()(deleteDatabase)이 "다른 연결이 아직
// 열려있다"는 이유로 막힌다(IndexedDB의 정상 동작 — 실제 버그로 확인,
// 캐싱으로 해결).
let _caseRepoDbPromise = null;
function _caseRepoOpenDb() {
  if (_caseRepoDbPromise) return _caseRepoDbPromise;
  _caseRepoDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      _caseRepoDbPromise = null;
      reject(new Error("INDEXEDDB_UNAVAILABLE"));
      return;
    }
    let req;
    try {
      req = indexedDB.open(CASE_REPO_DB_NAME, CASE_REPO_DB_VERSION);
    } catch (err) {
      _caseRepoDbPromise = null;
      reject(err);
      return;
    }
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(CASE_REPO_STORES.EQUIPMENT_HISTORY)) {
        const s = db.createObjectStore(CASE_REPO_STORES.EQUIPMENT_HISTORY, { keyPath: "_key" });
        s.createIndex("by_id", "id", { unique: false });
      }
      if (!db.objectStoreNames.contains(CASE_REPO_STORES.DISCHARGE_HISTORY)) {
        const s = db.createObjectStore(CASE_REPO_STORES.DISCHARGE_HISTORY, { keyPath: "_key" });
        s.createIndex("by_id", "id", { unique: false });
      }
      if (!db.objectStoreNames.contains(CASE_REPO_STORES.CASES)) {
        db.createObjectStore(CASE_REPO_STORES.CASES, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(CASE_REPO_STORES.CASE_DRAFTS)) {
        db.createObjectStore(CASE_REPO_STORES.CASE_DRAFTS, { keyPath: "caseId" });
      }
    };
    req.onsuccess = () => {
      // 다른 탭에서 DB 버전이 바뀌는 경우(향후 스키마 업그레이드) 이
      // 연결을 닫아서 그쪽의 upgrade가 안 막히게 한다 — 지금 탭은 다음
      // 호출에서 자동으로 새 연결을 다시 연다(캐시가 비워지므로).
      req.result.onversionchange = () => {
        req.result.close();
        _caseRepoDbPromise = null;
      };
      resolve(req.result);
    };
    req.onerror   = () => { _caseRepoDbPromise = null; reject(req.error || new Error("INDEXEDDB_OPEN_FAILED")); };
    req.onblocked = () => { _caseRepoDbPromise = null; reject(new Error("INDEXEDDB_BLOCKED")); };
  });
  return _caseRepoDbPromise;
}
function _caseRepoCloseDb() {
  if (!_caseRepoDbPromise) return Promise.resolve();
  return _caseRepoDbPromise.then(db => { db.close(); _caseRepoDbPromise = null; }).catch(() => { _caseRepoDbPromise = null; });
}

function _caseRepoRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error || new Error("INDEXEDDB_REQUEST_FAILED"));
  });
}

async function _caseRepoPut(storeName, value) {
  const db = await _caseRepoOpenDb();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(storeName, "readwrite");
    } catch (err) { reject(err); return; }
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve(value);
    tx.onerror    = () => reject(tx.error || new Error("INDEXEDDB_TX_FAILED"));
    tx.onabort    = () => reject(tx.error || new Error("INDEXEDDB_TX_ABORTED"));
  });
}

async function _caseRepoGetAll(storeName) {
  const db = await _caseRepoOpenDb();
  const tx = db.transaction(storeName, "readonly");
  return _caseRepoRequest(tx.objectStore(storeName).getAll());
}

async function _caseRepoGet(storeName, key) {
  const db = await _caseRepoOpenDb();
  const tx = db.transaction(storeName, "readonly");
  return _caseRepoRequest(tx.objectStore(storeName).get(key));
}

// ── isAvailable — feature-test. 프라이빗 모드/구형 브라우저 등에서
//    indexedDB.open 자체가 조용히 막히는 경우까지는 여기서 잡지 못하지만
//    (그건 각 메서드의 try/catch가 처리), 최소한 API 존재 여부는 즉시
//    동기적으로 확인해서 UI가 저장 UI를 아예 숨길지 판단할 수 있게 한다.
function isAvailable() {
  return typeof indexedDB !== "undefined";
}

// ── load — 앱 시작 시 1회 호출. equipmentHistory/dischargeHistory/cases
//    전체를 불러온다. Draft는 여기 포함되지 않는다(loadDraft를 Case별로
//    따로 호출) — ArcSafe.jsx는 Draft를 모르는 게 맞다(PERSISTENCE-004).
async function load() {
  try {
    const [rawEquip, rawDischarge, cases] = await Promise.all([
      _caseRepoGetAll(CASE_REPO_STORES.EQUIPMENT_HISTORY),
      _caseRepoGetAll(CASE_REPO_STORES.DISCHARGE_HISTORY),
      _caseRepoGetAll(CASE_REPO_STORES.CASES),
    ]);
    // 저장 포맷 전용 필드(_key, schemaVersion)는 내부 구현 세부사항이라
    // 호출부에 그대로 노출하지 않는다 — 원래 메모리 모양 그대로 복원.
    const strip = (r) => {
      const { _key, schemaVersion, ...rest } = r;
      return Object.freeze(rest);
    };
    return {
      ok: true,
      equipmentHistory: Object.freeze(rawEquip.map(strip)),
      dischargeHistory: Object.freeze(rawDischarge.map(strip)),
      cases,
    };
  } catch (err) {
    return { ok: false, error: _caseRepoDescribeError(err),
             equipmentHistory: [], dischargeHistory: [], cases: [] };
  }
}

// ── saveCase — Case 전체(메타+snapshotHistory+approvals)를 통짜로
//    upsert. Case 생성 직후, Snapshot append 직후, Approval 갱신 직후
//    전부 이 함수 하나로 처리한다 — 별도 saveApproval은 이 함수의 얇은
//    별칭일 뿐 저장 포맷을 분리하지 않는다(관계형으로 안 쪼갬, 최소
//    구조 원칙).
async function saveCase(caseObj) {
  try {
    await _caseRepoPut(CASE_REPO_STORES.CASES, caseObj);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: _caseRepoDescribeError(err) };
  }
}
const saveApproval = saveCase; // 호출부 가독성을 위한 별칭 (요청사항 7-method 목록 반영)

// ── saveDraft / loadDraft — CaseView가 caseId 기준으로 직접 호출.
//    draft는 CaseView 로컬 입력 state(inputs/wInputSource/§5 시나리오
//    입력 등)의 스냅샷일 뿐, Case 객체와 무관한 별도 store다.
async function saveDraft(caseId, draft) {
  try {
    await _caseRepoPut(CASE_REPO_STORES.CASE_DRAFTS,
      { caseId, draft, updatedAt: new Date().toISOString() });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: _caseRepoDescribeError(err) };
  }
}
async function loadDraft(caseId) {
  try {
    const rec = await _caseRepoGet(CASE_REPO_STORES.CASE_DRAFTS, caseId);
    return { ok: true, draft: rec ? rec.draft : null };
  } catch (err) {
    return { ok: false, error: _caseRepoDescribeError(err), draft: null };
  }
}

// ── saveEquipmentRevision / saveDischargeRevision — asset/history.js의
//    appendRevision()과 짝을 이룬다. rev는 이미 Object.freeze()된
//    EquipmentRevision/DischargeSystemRevision — 새 프로퍼티를 얹을 수
//    없으므로 얕은 복사로 저장용 레코드를 새로 만든다.
async function saveEquipmentRevision(rev) {
  try {
    const record = { ...rev, _key: `${rev.id}@${rev.revision}`, schemaVersion: CASE_REPO_SCHEMA_VERSION };
    await _caseRepoPut(CASE_REPO_STORES.EQUIPMENT_HISTORY, record);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: _caseRepoDescribeError(err) };
  }
}
async function saveDischargeRevision(rev) {
  try {
    const record = { ...rev, _key: `${rev.id}@${rev.revision}`, schemaVersion: CASE_REPO_SCHEMA_VERSION };
    await _caseRepoPut(CASE_REPO_STORES.DISCHARGE_HISTORY, record);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: _caseRepoDescribeError(err) };
  }
}

// ── wipeAll — "이 기기의 모든 자료 삭제" 설정 메뉴 전용. 되돌릴 수 없다.
async function wipeAll() {
  try {
    await _caseRepoCloseDb(); // 열린 연결이 있으면 deleteDatabase가 blocked됨 — 반드시 먼저 닫는다
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(CASE_REPO_DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error || new Error("INDEXEDDB_DELETE_FAILED"));
      req.onblocked = () => reject(new Error("INDEXEDDB_DELETE_BLOCKED"));
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: _caseRepoDescribeError(err) };
  }
}

const CaseRepository = Object.freeze({
  isAvailable, load, saveCase, saveApproval, saveDraft, loadDraft,
  saveEquipmentRevision, saveDischargeRevision, wipeAll,
});
