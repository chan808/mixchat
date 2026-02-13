/**
 * ========================================
 * 종합 채팅 시스템 부하 테스트
 * ========================================
 *
 * 목적: 모든 채팅 유형(Direct, Group, AI)에 대한 종합적인 성능 검증
 *
 * 테스트 범위:
 * 1. Direct Chat (1:1 채팅): 생성, 조회, 메시지 송수신
 * 2. Group Chat (그룹 채팅): 생성, 참가, 초대, 강퇴, 방장 위임
 * 3. AI Chat: 3가지 타입 (ROLE_PLAY, TUTOR_PERSONAL, TUTOR_SIMILAR)
 * 4. 메시지 CRUD: 조회, 전송, 파일 업로드
 * 5. 권한 검증: 멤버십 체크, 방장 권한
 *
 * 부하 프로필:
 * - Warmup: 1분간 20명
 * - Normal: 2분간 100명 (정상 부하)
 * - Peak: 2분간 300명 (피크 부하)
 * - Stress: 2분간 500명 (스트레스 테스트)
 * - Spike: 30초간 800명 (스파이크 테스트)
 * - Recovery: 1분간 100명 (복구 테스트)
 * - Cooldown: 30초간 0명
 *
 * 실행 방법:
 * k6 run chat-comprehensive-load-test.js \
 *   --env BASE_URL=http://localhost:8080 \
 *   --env TEST_DURATION=short
 */

import http from "k6/http";
import { check, sleep, group, fail } from "k6";
import { SharedArray } from "k6/data";
import { Counter, Trend, Rate, Gauge } from "k6/metrics";
import { randomItem, randomIntBetween, randomString } from "https://jslib.k6.io/k6-utils/1.2.0/index.js";

// ==================== 커스텀 메트릭 정의 ====================
const directChatCreated = new Counter("direct_chat_created");
const groupChatCreated = new Counter("group_chat_created");
const aiChatCreated = new Counter("ai_chat_created");
const messagesReceived = new Counter("messages_received");
const messagesSent = new Counter("messages_sent");
const filesUploaded = new Counter("files_uploaded");

const messageReadLatency = new Trend("message_read_latency");
const messageSendLatency = new Trend("message_send_latency");
const roomListLatency = new Trend("room_list_latency");
const aiResponseLatency = new Trend("ai_response_latency");

const authSuccessRate = new Rate("auth_success_rate");
const messageSuccessRate = new Rate("message_success_rate");
const permissionDeniedRate = new Rate("permission_denied_rate");

const activeUsers = new Gauge("active_users");
const activeRooms = new Gauge("active_rooms");

// ==================== 테스트 설정 ====================
const TEST_DURATION = __ENV.TEST_DURATION || "full"; // short, medium, full

const LOAD_PROFILES = {
  short: [
    { duration: "30s", target: 20 },   // Warmup
    { duration: "1m", target: 50 },    // Normal
    { duration: "1m", target: 100 },   // Peak
    { duration: "30s", target: 0 },    // Cooldown
  ],
  medium: [
    { duration: "1m", target: 20 },    // Warmup
    { duration: "2m", target: 100 },   // Normal
    { duration: "2m", target: 200 },   // Peak
    { duration: "1m", target: 300 },   // Stress
    { duration: "30s", target: 0 },    // Cooldown
  ],
  full: [
    { duration: "1m", target: 20 },    // Warmup
    { duration: "2m", target: 100 },   // Normal
    { duration: "2m", target: 300 },   // Peak
    { duration: "2m", target: 500 },   // Stress
    { duration: "30s", target: 800 },  // Spike
    { duration: "1m", target: 100 },   // Recovery
    { duration: "30s", target: 0 },    // Cooldown
  ],
};

export const options = {
  stages: LOAD_PROFILES[TEST_DURATION],
  thresholds: {
    // HTTP 전체 성공률 및 응답 시간
    http_req_failed: ["rate<0.01"], // 1% 미만 실패율
    http_req_duration: ["p(95)<2000", "p(99)<5000"], // 95%는 2초 이내, 99%는 5초 이내

    // 엔드포인트별 세부 임계값
    "http_req_duration{endpoint:login}": ["p(95)<500"],
    "http_req_duration{endpoint:getRoomList}": ["p(95)<800"],
    "http_req_duration{endpoint:getMessages}": ["p(95)<1000"],
    "http_req_duration{endpoint:sendMessage}": ["p(95)<1500"],
    "http_req_duration{endpoint:createRoom}": ["p(95)<1000"],
    "http_req_duration{endpoint:joinRoom}": ["p(95)<800"],
    "http_req_duration{endpoint:aiChat}": ["p(95)<10000"], // AI는 10초까지 허용

    // 커스텀 메트릭 임계값
    message_success_rate: ["rate>0.99"], // 메시지 성공률 99% 이상
    auth_success_rate: ["rate>0.99"],    // 인증 성공률 99% 이상
    permission_denied_rate: ["rate<0.001"], // 권한 오류 0.1% 미만

    // 응답 시간 임계값
    message_read_latency: ["p(95)<1000"],
    message_send_latency: ["p(95)<1500"],
    room_list_latency: ["p(95)<800"],
    ai_response_latency: ["p(95)<10000"],
  },
  // 최대 동시 연결 제한 (시스템 보호)
  batch: 10,
  batchPerHost: 5,
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";

// ==================== 테스트 데이터 ====================
// 테스트용 사용자 100명 생성 (실제 DB에 존재해야 함)
const users = new SharedArray("test users", function () {
  const userList = [];
  for (let i = 1; i <= 100; i++) {
    userList.push({
      email: `test${i}@test.com`,
      password: "test1234",
      id: i,
      nickname: `TestUser${i}`,
    });
  }
  return userList;
});

// AI 페르소나 ID 목록 (실제 DB에 존재해야 함)
const AI_PERSONAS = [1, 2, 3, 4, 5];

// 채팅방 타입
const CHAT_ROOM_TYPES = ["DIRECT", "GROUP", "AI"];
const AI_CHAT_ROOM_TYPES = ["ROLE_PLAY", "TUTOR_PERSONAL", "TUTOR_SIMILAR"];
const MESSAGE_TYPES = ["TEXT"];

// ==================== 헬퍼 함수 ====================

/**
 * 사용자 로그인
 */
function login(email, password) {
  const startTime = new Date();
  const res = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email, password }),
    {
      headers: { "Content-Type": "application/json" },
      tags: { endpoint: "login" },
    }
  );

  const success = check(res, {
    "로그인 성공": (r) => r.status === 200,
    "토큰 포함": (r) => {
      if (r.status === 200) {
        const body = JSON.parse(r.body);
        return body.data && body.data.length > 0;
      }
      return false;
    },
  });

  authSuccessRate.add(success);

  if (res.status === 200) {
    const body = JSON.parse(res.body);
    return body.data;
  }
  return null;
}

/**
 * 1:1 채팅방 생성 또는 조회
 */
function createOrFindDirectChat(token, partnerId) {
  const res = http.post(
    `${BASE_URL}/api/v1/chats/rooms/direct`,
    JSON.stringify({ partnerId }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      tags: { endpoint: "createRoom" },
    }
  );

  check(res, {
    "Direct 채팅방 생성/조회 성공": (r) => r.status === 200,
  });

  if (res.status === 200) {
    directChatCreated.add(1);
    const body = JSON.parse(res.body);
    return body.data;
  }
  return null;
}

/**
 * 그룹 채팅방 생성
 */
function createGroupChat(token, roomName, memberIds, password = "", description = "", topic = "") {
  const res = http.post(
    `${BASE_URL}/api/v1/chats/rooms/group`,
    JSON.stringify({
      roomName,
      memberIds,
      password,
      description,
      topic,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      tags: { endpoint: "createRoom" },
    }
  );

  check(res, {
    "그룹 채팅방 생성 성공": (r) => r.status === 200,
  });

  if (res.status === 200) {
    groupChatCreated.add(1);
    const body = JSON.parse(res.body);
    return body.data;
  }
  return null;
}

/**
 * AI 채팅방 생성
 */
function createAIChat(token, roomName, personaId, roomType) {
  const res = http.post(
    `${BASE_URL}/api/v1/chats/rooms/ai`,
    JSON.stringify({
      roomName,
      personaId,
      roomType,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      tags: { endpoint: "createRoom" },
    }
  );

  check(res, {
    "AI 채팅방 생성 성공": (r) => r.status === 200,
  });

  if (res.status === 200) {
    aiChatCreated.add(1);
    const body = JSON.parse(res.body);
    return body.data;
  }
  return null;
}

/**
 * 그룹 채팅방 목록 조회
 */
function getGroupRoomList(token) {
  const startTime = new Date();
  const res = http.get(`${BASE_URL}/api/v1/chats/rooms/group`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { endpoint: "getRoomList" },
  });

  roomListLatency.add(new Date() - startTime);

  check(res, {
    "그룹 채팅방 목록 조회 성공": (r) => r.status === 200,
  });

  if (res.status === 200) {
    const body = JSON.parse(res.body);
    return body.data || [];
  }
  return [];
}

/**
 * Direct 채팅방 목록 조회
 */
function getDirectRoomList(token) {
  const startTime = new Date();
  const res = http.get(`${BASE_URL}/api/v1/chats/rooms/direct`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { endpoint: "getRoomList" },
  });

  roomListLatency.add(new Date() - startTime);

  check(res, {
    "Direct 채팅방 목록 조회 성공": (r) => r.status === 200,
  });

  if (res.status === 200) {
    const body = JSON.parse(res.body);
    return body.data || [];
  }
  return [];
}

/**
 * AI 채팅방 목록 조회
 */
function getAIRoomList(token) {
  const startTime = new Date();
  const res = http.get(`${BASE_URL}/api/v1/chats/rooms/ai`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { endpoint: "getRoomList" },
  });

  roomListLatency.add(new Date() - startTime);

  check(res, {
    "AI 채팅방 목록 조회 성공": (r) => r.status === 200,
  });

  if (res.status === 200) {
    const body = JSON.parse(res.body);
    return body.data || [];
  }
  return [];
}

/**
 * 공개 그룹 채팅방 목록 조회
 */
function getPublicGroupRooms(token) {
  const res = http.get(`${BASE_URL}/api/v1/chats/rooms/group/public`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { endpoint: "getRoomList" },
  });

  if (res.status === 200) {
    const body = JSON.parse(res.body);
    return body.data || [];
  }
  return [];
}

/**
 * 그룹 채팅방 참가
 */
function joinGroupRoom(token, roomId, password = null) {
  const payload = password ? JSON.stringify({ password }) : JSON.stringify({});

  const res = http.post(
    `${BASE_URL}/api/v1/chats/rooms/group/${roomId}/join`,
    payload,
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      tags: { endpoint: "joinRoom" },
    }
  );

  const success = check(res, {
    "그룹 채팅방 참가 성공": (r) => r.status === 200 || r.status === 400, // 400은 이미 참가 중
  });

  return success && res.status === 200;
}

/**
 * 메시지 조회 (페이지네이션)
 */
function getMessages(token, roomId, chatRoomType, cursor = null, size = 25) {
  const startTime = new Date();
  let url = `${BASE_URL}/api/v1/chats/rooms/${roomId}/messages?chatRoomType=${chatRoomType}&size=${size}`;
  if (cursor !== null) {
    url += `&cursor=${cursor}`;
  }

  const res = http.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { endpoint: "getMessages" },
  });

  messageReadLatency.add(new Date() - startTime);

  const success = check(res, {
    "메시지 조회 성공": (r) => r.status === 200,
  });

  if (success) {
    messagesReceived.add(1);
    const body = JSON.parse(res.body);
    return body.data.messagePageResp || null;
  }

  return null;
}

/**
 * WebSocket을 통한 메시지 전송 (REST API로 시뮬레이션)
 * 실제 WebSocket STOMP는 별도 테스트에서 진행
 */
function sendMessageViaREST(token, roomId, content, chatRoomType) {
  const startTime = new Date();

  // WebSocket 전송 시뮬레이션을 위해 REST API 사용
  // 실제로는 WebSocket STOMP /app/chats/sendMessage 사용
  const res = http.post(
    `${BASE_URL}/api/v1/chats/rooms/${roomId}/files`,
    JSON.stringify({
      roomId,
      content,
      messageType: "TEXT",
      chatRoomType,
      isTranslateEnabled: false,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      tags: { endpoint: "sendMessage" },
    }
  );

  messageSendLatency.add(new Date() - startTime);

  const success = check(res, {
    "메시지 전송 성공": (r) => r.status === 200,
  });

  messageSuccessRate.add(success);

  if (success) {
    messagesSent.add(1);
  }

  return success;
}

/**
 * 채팅방 나가기
 */
function leaveRoom(token, roomId, chatRoomType) {
  const res = http.del(
    `${BASE_URL}/api/v1/chats/rooms/${roomId}?chatRoomType=${chatRoomType}`,
    null,
    {
      headers: { Authorization: `Bearer ${token}` },
      tags: { endpoint: "leaveRoom" },
    }
  );

  check(res, {
    "채팅방 나가기 성공": (r) => r.status === 200 || r.status === 204,
  });

  return res.status === 200 || res.status === 204;
}

/**
 * 멤버 초대
 */
function inviteMember(token, roomId, targetMemberId) {
  const res = http.post(
    `${BASE_URL}/api/v1/chats/rooms/group/${roomId}/invite`,
    JSON.stringify({ targetMemberId }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      tags: { endpoint: "inviteMember" },
    }
  );

  check(res, {
    "멤버 초대 성공": (r) => r.status === 200,
  });

  return res.status === 200;
}

/**
 * 멤버 강퇴 (방장만 가능)
 */
function kickMember(token, roomId, memberId) {
  const res = http.del(
    `${BASE_URL}/api/v1/chats/rooms/${roomId}/members/${memberId}`,
    null,
    {
      headers: { Authorization: `Bearer ${token}` },
      tags: { endpoint: "kickMember" },
    }
  );

  const success = check(res, {
    "멤버 강퇴 성공": (r) => r.status === 200,
  });

  if (!success && res.status === 403) {
    permissionDeniedRate.add(1);
  } else {
    permissionDeniedRate.add(0);
  }

  return success;
}

/**
 * 방장 위임
 */
function transferOwnership(token, roomId, newOwnerId) {
  const res = http.patch(
    `${BASE_URL}/api/v1/chats/rooms/${roomId}/owner`,
    JSON.stringify({ newOwnerId }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      tags: { endpoint: "transferOwnership" },
    }
  );

  const success = check(res, {
    "방장 위임 성공": (r) => r.status === 200,
  });

  if (!success && res.status === 403) {
    permissionDeniedRate.add(1);
  } else {
    permissionDeniedRate.add(0);
  }

  return success;
}

/**
 * AI 피드백 분석
 */
function analyzeAIFeedback(token, messages, targetLanguage = "en") {
  const startTime = new Date();

  const res = http.post(
    `${BASE_URL}/api/v1/chats/feedback`,
    JSON.stringify({
      messages,
      targetLanguage,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      tags: { endpoint: "aiChat" },
    }
  );

  aiResponseLatency.add(new Date() - startTime);

  check(res, {
    "AI 피드백 분석 성공": (r) => r.status === 200,
  });

  return res.status === 200;
}

// ==================== 시나리오 함수 ====================

/**
 * 시나리오 1: 일반 사용자 (60% - 주로 읽기)
 * - 로그인 → 방 목록 조회 → 메시지 읽기 → 가끔 메시지 전송
 */
function casualUserScenario(user, sharedRooms) {
  group("Casual User - 일반 사용자", () => {
    const token = login(user.email, user.password);
    if (!token) return;

    activeUsers.add(1);

    // 방 목록 조회 (Direct + Group)
    const directRooms = getDirectRoomList(token);
    const groupRooms = getGroupRoomList(token);
    const allRooms = [...directRooms, ...groupRooms];

    if (allRooms.length === 0 && sharedRooms.length > 0) {
      // 공유된 테스트 방에 참가
      const targetRoom = randomItem(sharedRooms);
      joinGroupRoom(token, targetRoom.id, targetRoom.password);
      sleep(1);
    }

    // 70% 확률로 메시지 읽기
    if (Math.random() < 0.7 && allRooms.length > 0) {
      const room = randomItem(allRooms);
      const chatRoomType = room.hasOwnProperty("partner") ? "DIRECT" : "GROUP";
      getMessages(token, room.id, chatRoomType, null, 25);
    }

    sleep(randomIntBetween(2, 5));

    // 30% 확률로 메시지 전송
    if (Math.random() < 0.3 && allRooms.length > 0) {
      const room = randomItem(allRooms);
      const chatRoomType = room.hasOwnProperty("partner") ? "DIRECT" : "GROUP";
      sendMessageViaREST(
        token,
        room.id,
        `테스트 메시지 from ${user.nickname} at ${Date.now()}`,
        chatRoomType
      );
    }

    activeUsers.add(-1);
  });
}

/**
 * 시나리오 2: 활발한 사용자 (30% - 읽기/쓰기 균형)
 * - 로그인 → 그룹 채팅 참가 → 지속적 메시지 송수신
 */
function activeChatScenario(user, sharedRooms) {
  group("Active Chatter - 활발한 채팅 사용자", () => {
    const token = login(user.email, user.password);
    if (!token) return;

    activeUsers.add(1);

    // 그룹 방 목록 조회
    let groupRooms = getGroupRoomList(token);

    // 방이 없으면 공유 방에 참가
    if (groupRooms.length === 0 && sharedRooms.length > 0) {
      const targetRoom = randomItem(sharedRooms);
      joinGroupRoom(token, targetRoom.id, targetRoom.password);
      groupRooms = getGroupRoomList(token);
    }

    if (groupRooms.length === 0) {
      activeUsers.add(-1);
      return;
    }

    const room = randomItem(groupRooms);

    // 지속적 메시지 송수신 (5-10회)
    const iterations = randomIntBetween(5, 10);
    for (let i = 0; i < iterations; i++) {
      // 읽기
      getMessages(token, room.id, "GROUP");
      sleep(randomIntBetween(1, 3));

      // 쓰기
      sendMessageViaREST(
        token,
        room.id,
        `Active message ${i + 1} from ${user.nickname}`,
        "GROUP"
      );
      sleep(randomIntBetween(2, 4));
    }

    activeUsers.add(-1);
  });
}

/**
 * 시나리오 3: AI 사용자 (10% - AI 채팅)
 * - 로그인 → AI 채팅방 생성/조회 → AI와 대화
 */
function aiChatScenario(user) {
  group("AI User - AI 채팅 사용자", () => {
    const token = login(user.email, user.password);
    if (!token) return;

    activeUsers.add(1);

    // AI 채팅방 목록 조회
    let aiRooms = getAIRoomList(token);

    // AI 채팅방이 없으면 생성
    if (aiRooms.length === 0) {
      const personaId = randomItem(AI_PERSONAS);
      const roomType = randomItem(AI_CHAT_ROOM_TYPES);
      const newRoom = createAIChat(
        token,
        `AI Chat ${user.nickname}`,
        personaId,
        roomType
      );

      if (newRoom) {
        aiRooms = [newRoom];
      }
    }

    if (aiRooms.length === 0) {
      activeUsers.add(-1);
      return;
    }

    const aiRoom = randomItem(aiRooms);

    // AI와 대화 (3-5회)
    const conversations = randomIntBetween(3, 5);
    for (let i = 0; i < conversations; i++) {
      // AI 채팅은 메시지 전송 후 AI 응답 대기 시간이 김
      sendMessageViaREST(
        token,
        aiRoom.id,
        `AI question ${i + 1}: What is the best way to learn English?`,
        "AI"
      );

      // AI 응답 대기 (실제로는 WebSocket으로 수신)
      sleep(randomIntBetween(3, 8));

      // 응답 메시지 조회
      getMessages(token, aiRoom.id, "AI");
      sleep(randomIntBetween(2, 5));
    }

    // AI 피드백 분석 테스트 (30% 확률)
    if (Math.random() < 0.3) {
      analyzeAIFeedback(token, [
        { role: "user", content: "I goes to school yesterday" },
        { role: "assistant", content: "I went to school yesterday" },
      ]);
    }

    activeUsers.add(-1);
  });
}

/**
 * 시나리오 4: 방 관리자 (5% - 그룹 관리)
 * - 그룹 방 생성 → 멤버 초대 → 관리 작업
 */
function roomManagerScenario(user, users) {
  group("Room Manager - 방 관리자", () => {
    const token = login(user.email, user.password);
    if (!token) return;

    activeUsers.add(1);

    // 그룹 방 생성
    const inviteMembers = [];
    for (let i = 0; i < 3; i++) {
      const randomUser = randomItem(users);
      if (randomUser.id !== user.id) {
        inviteMembers.push(randomUser.id);
      }
    }

    const room = createGroupChat(
      token,
      `Manager Room ${user.nickname}`,
      inviteMembers,
      "",
      "테스트용 그룹 채팅방",
      "TEST"
    );

    if (room) {
      activeRooms.add(1);
      sleep(1);

      // 추가 멤버 초대 (50% 확률)
      if (Math.random() < 0.5) {
        const newMember = randomItem(users);
        if (newMember.id !== user.id && !inviteMembers.includes(newMember.id)) {
          inviteMember(token, room.id, newMember.id);
          sleep(1);
        }
      }

      // 메시지 전송
      sendMessageViaREST(
        token,
        room.id,
        `Welcome to my room! - ${user.nickname}`,
        "GROUP"
      );
      sleep(2);

      // 방장 위임 (10% 확률)
      if (Math.random() < 0.1 && inviteMembers.length > 0) {
        const newOwner = inviteMembers[0];
        transferOwnership(token, room.id, newOwner);
        sleep(1);
      }

      // 방 나가기 (20% 확률)
      if (Math.random() < 0.2) {
        leaveRoom(token, room.id, "GROUP");
        activeRooms.add(-1);
      }
    }

    activeUsers.add(-1);
  });
}

// ==================== Setup & Teardown ====================

export function setup() {
  console.log("========================================");
  console.log("종합 채팅 시스템 부하 테스트 시작");
  console.log("========================================");
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Test Duration: ${TEST_DURATION}`);
  console.log(`Load Profile: ${LOAD_PROFILES[TEST_DURATION].length} stages`);
  console.log("========================================");

  // 테스트용 공유 그룹 채팅방 생성 (10개)
  const sharedRooms = [];
  const ownerUser = users[0];
  const ownerToken = login(ownerUser.email, ownerUser.password);

  if (!ownerToken) {
    console.error("Setup 실패: 방장 로그인 실패");
    return { sharedRooms: [] };
  }

  for (let i = 0; i < 10; i++) {
    const memberIds = [];
    for (let j = 1; j <= 10; j++) {
      const userId = (i * 10 + j) % users.length + 1;
      if (userId !== ownerUser.id) {
        memberIds.push(userId);
      }
    }

    const room = createGroupChat(
      ownerToken,
      `Shared Test Room ${i + 1}`,
      memberIds.slice(0, 5), // 처음 5명만 초대
      "",
      `공유 테스트 방 ${i + 1}`,
      "LOAD_TEST"
    );

    if (room) {
      sharedRooms.push(room);
      console.log(`공유 방 생성 완료: ${room.id} - ${room.name}`);

      // 초기 메시지 삽입 (각 방에 20개)
      for (let k = 1; k <= 20; k++) {
        sendMessageViaREST(
          ownerToken,
          room.id,
          `Initial message ${k} in room ${room.name}`,
          "GROUP"
        );
      }
    }

    sleep(0.5);
  }

  console.log(`========================================`);
  console.log(`공유 방 생성 완료: ${sharedRooms.length}개`);
  console.log(`========================================`);

  return {
    sharedRooms,
    startTime: new Date(),
  };
}

export default function (data) {
  const { sharedRooms } = data;

  // VU ID 기반 사용자 선택 (순환)
  const userIndex = (__VU - 1) % users.length;
  const user = users[userIndex];

  // 사용자 유형별 비율 (0-99 랜덤)
  const userType = randomIntBetween(0, 99);

  if (userType < 60) {
    // 60%: 일반 사용자
    casualUserScenario(user, sharedRooms);
  } else if (userType < 90) {
    // 30%: 활발한 사용자
    activeChatScenario(user, sharedRooms);
  } else if (userType < 95) {
    // 5%: 방 관리자
    roomManagerScenario(user, users);
  } else {
    // 5%: AI 사용자
    aiChatScenario(user);
  }

  // 사용자 행동 간 대기 시간
  sleep(randomIntBetween(1, 3));
}

export function teardown(data) {
  const duration = (new Date() - data.startTime) / 1000 / 60;
  console.log("========================================");
  console.log("종합 채팅 시스템 부하 테스트 완료");
  console.log(`총 테스트 시간: ${duration.toFixed(2)}분`);
  console.log("========================================");
  console.log("메트릭 요약:");
  console.log(`- Direct 채팅방 생성: ${directChatCreated.value || 0}개`);
  console.log(`- Group 채팅방 생성: ${groupChatCreated.value || 0}개`);
  console.log(`- AI 채팅방 생성: ${aiChatCreated.value || 0}개`);
  console.log(`- 메시지 수신: ${messagesReceived.value || 0}회`);
  console.log(`- 메시지 전송: ${messagesSent.value || 0}회`);
  console.log("========================================");
}
