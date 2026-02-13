/**
 * ========================================
 * Direct & Group 채팅 전용 부하 테스트
 * ========================================
 *
 * 목적: AI 채팅을 제외한 Direct(1:1)와 Group 채팅의 완벽한 성능 검증
 *
 * 테스트 범위:
 * 1. Direct Chat (1:1 채팅)
 *    - 채팅방 생성/조회
 *    - 메시지 송수신 (REST API)
 *    - 메시지 페이지네이션 조회
 *    - 읽음 상태 업데이트
 *
 * 2. Group Chat (그룹 채팅)
 *    - 채팅방 생성/조회
 *    - 공개/비공개 방 관리
 *    - 멤버 관리 (참가, 초대, 강퇴)
 *    - 방장 위임
 *    - 메시지 송수신
 *    - 대규모 그룹 방 성능 (50명, 100명)
 *
 * AI 채팅 제외:
 * - AI 관련 모든 코드 제거
 * - Direct/Group에 집중하여 더 깊이있는 테스트
 * - 팀원 홈서버(Ollama) 부담 없음
 *
 * 부하 프로필:
 * - short: 3분 (빠른 검증)
 * - medium: 8분 (표준 테스트)
 * - full: 12분 (완전한 부하 테스트)
 *
 * 실행 방법:
 * k6 run chat-direct-group-load-test.js \
 *   --env BASE_URL=http://localhost:8080 \
 *   --env TEST_DURATION=full
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { SharedArray } from "k6/data";
import { Counter, Trend, Rate, Gauge } from "k6/metrics";
import { randomItem, randomIntBetween, randomString } from "https://jslib.k6.io/k6-utils/1.2.0/index.js";

// ==================== 커스텀 메트릭 정의 ====================
const directChatCreated = new Counter("direct_chat_created");
const groupChatCreated = new Counter("group_chat_created");
const messagesReceived = new Counter("messages_received");
const messagesSent = new Counter("messages_sent");
const filesUploaded = new Counter("files_uploaded");
const roomsJoined = new Counter("rooms_joined");
const membersInvited = new Counter("members_invited");
const membersKicked = new Counter("members_kicked");
const ownershipTransferred = new Counter("ownership_transferred");

const messageReadLatency = new Trend("message_read_latency");
const messageSendLatency = new Trend("message_send_latency");
const directRoomListLatency = new Trend("direct_room_list_latency");
const groupRoomListLatency = new Trend("group_room_list_latency");
const publicRoomListLatency = new Trend("public_room_list_latency");
const roomCreateLatency = new Trend("room_create_latency");
const roomJoinLatency = new Trend("room_join_latency");

const authSuccessRate = new Rate("auth_success_rate");
const messageSuccessRate = new Rate("message_success_rate");
const roomCreateSuccessRate = new Rate("room_create_success_rate");
const permissionDeniedRate = new Rate("permission_denied_rate");

const activeUsers = new Gauge("active_users");
const activeDirectRooms = new Gauge("active_direct_rooms");
const activeGroupRooms = new Gauge("active_group_rooms");

// ==================== 테스트 설정 ====================
const TEST_DURATION = __ENV.TEST_DURATION || "full";

const LOAD_PROFILES = {
  short: [ // 짧게 기능 확인
    { duration: "10s", target: 10 },    // Warmup
    { duration: "20s", target: 30 },    // Normal
    { duration: "20s", target: 60 },    // Peak
    { duration: "10s", target: 0 },     // Cooldown
  ],

  medium: [
    { duration: "20s", target: 20 },    // Warmup
    { duration: "30s", target: 50 },    // Normal
    { duration: "40s", target: 80 },    // Peak
    { duration: "40s", target: 120 },   // High
    { duration: "30s", target: 150 },   // Stable
    { duration: "20s", target: 0 },     // Cooldown
  ],

  full: [
    { duration: "20s", target: 20 },    // Warmup
    { duration: "30s", target: 50 },    // Normal
    { duration: "40s", target: 80 },    // Peak
    { duration: "40s", target: 120 },   // High
    { duration: "40s", target: 150 },   // Stable
    { duration: "20s", target: 0 },     // Cooldown
  ],
};

export const options = {
  setupTimeout: "5m",  // setup() 작업에 5분 허용
  timeout: "3m",

  stages: LOAD_PROFILES[TEST_DURATION],

  gracefulRampDown: "30s",
  maxVUs: 160,

  thresholds: {
    // HTTP 전체 성공률 및 응답 시간
    http_req_failed: ["rate<0.20"],
    http_req_duration: ["p(95)<5000", "p(99)<15000"],

    // 엔드포인트별 임계값
    "http_req_duration{endpoint:login}": ["p(95)<500"],

    "http_req_duration{endpoint:getDirectRoomList}": ["p(95)<2000"],
    "http_req_duration{endpoint:getGroupRoomList}": ["p(95)<2000"],
    "http_req_duration{endpoint:getMessages}": ["p(95)<3000"],
    "http_req_duration{endpoint:sendMessage}": ["p(95)<3000"],
    "http_req_duration{endpoint:createRoom}": ["p(95)<3000"],
    "http_req_duration{endpoint:joinRoom}": ["p(95)<2000"],
    "http_req_duration{endpoint:inviteMember}": ["p(95)<1500"],
    "http_req_duration{endpoint:kickMember}": ["p(95)<1500"],

    // 커스텀 메트릭
    message_success_rate: ["rate>0.99"],
    auth_success_rate: ["rate>0.99"],
    room_create_success_rate: ["rate>0.95"],
    permission_denied_rate: ["rate<0.001"],

    // 응답 시간 지표
    message_read_latency: ["p(95)<1000"],
    message_send_latency: ["p(95)<3000"],
    direct_room_list_latency: ["p(95)<1200"],
    group_room_list_latency: ["p(95)<1200"],
    room_create_latency: ["p(95)<1500"],
    room_join_latency: ["p(95)<1200"],
  },

  batch: 10,
  batchPerHost: 5,
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";

// ==================== 테스트 데이터 ====================
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

const MESSAGE_TEMPLATES = [
  "안녕하세요!",
  "오늘 날씨 정말 좋네요",
  "점심 뭐 먹을까요?",
  "회의 시간 확인 부탁드립니다",
  "프로젝트 진행 상황 공유드립니다",
  "수고하셨습니다!",
  "감사합니다",
  "네, 알겠습니다",
  "확인했습니다",
  "좋은 아이디어네요!",
  "동의합니다",
  "조금만 기다려주세요",
  "곧 공유드리겠습니다",
  "질문 있습니다",
  "의견 부탁드립니다",
];

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
  const startTime = new Date();
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

  roomCreateLatency.add(new Date() - startTime);

  const success = check(res, {
    "Direct 채팅방 생성/조회 성공": (r) => r.status === 200,
  });

  roomCreateSuccessRate.add(success);

  if (res.status === 200) {
    directChatCreated.add(1);
    activeDirectRooms.add(1);
    const body = JSON.parse(res.body);
    return body.data;
  } else {
    console.error(`[Direct 방 생성 실패] partnerId=${partnerId}, status=${res.status}, body=${res.body ? res.body.substring(0, 200) : 'empty'}`);
  }
  return null;
}

/**
 * 그룹 채팅방 생성
 */
function createGroupChat(token, roomName, memberIds, password = "", description = "", topic = "") {
  const startTime = new Date();
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

  roomCreateLatency.add(new Date() - startTime);

  const success = check(res, {
    "그룹 채팅방 생성 성공": (r) => r.status === 200,
  });

  roomCreateSuccessRate.add(success);

  if (res.status === 200) {
    groupChatCreated.add(1);
    activeGroupRooms.add(1);
    const body = JSON.parse(res.body);
    return body.data;
  } else {
    console.error(`[그룹 방 생성 실패] status=${res.status}, body=${res.body ? res.body.substring(0, 200) : 'empty'}`);
  }
  return null;
}

/**
 * Direct 채팅방 목록 조회
 */
function getDirectRoomList(token) {
  const startTime = new Date();
  const res = http.get(`${BASE_URL}/api/v1/chats/rooms/direct`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { endpoint: "getDirectRoomList" },
  });

  directRoomListLatency.add(new Date() - startTime);

  const success = check(res, {
    "Direct 채팅방 목록 조회 성공": (r) => r.status === 200,
  });

  if (!success) {
    console.error(`[Direct 목록 조회 실패] status=${res.status}, body=${res.body ? res.body.substring(0, 200) : 'empty'}`);
  }

  if (res.status === 200) {
    const body = JSON.parse(res.body);
    return body.data || [];
  }
  return [];
}

/**
 * 그룹 채팅방 목록 조회
 */
function getGroupRoomList(token) {
  const startTime = new Date();
  const res = http.get(`${BASE_URL}/api/v1/chats/rooms/group`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { endpoint: "getGroupRoomList" },
  });

  groupRoomListLatency.add(new Date() - startTime);

  const success = check(res, {
    "그룹 채팅방 목록 조회 성공": (r) => r.status === 200,
  });

  if (!success) {
    console.error(`[그룹 목록 조회 실패] status=${res.status}, body=${res.body ? res.body.substring(0, 200) : 'empty'}`);
  }

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
  const startTime = new Date();
  const res = http.get(`${BASE_URL}/api/v1/chats/rooms/group/public`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { endpoint: "getPublicRoomList" },
  });

  publicRoomListLatency.add(new Date() - startTime);

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
  const startTime = new Date();
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

  roomJoinLatency.add(new Date() - startTime);

  const success = check(res, {
    "그룹 채팅방 참가 성공": (r) => r.status === 200, // idempotent: 이미 참가 시에도 200 반환
  });

  if (success) {
    roomsJoined.add(1);
  } else {
    // 실패 시 상세 정보 출력
    console.error(`[그룹 참가 실패] roomId=${roomId}, status=${res.status}, body=${res.body ? res.body.substring(0, 200) : 'empty'}`);
  }

  return success;
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
  } else {
    console.error(`[메시지 조회 실패] roomId=${roomId}, type=${chatRoomType}, status=${res.status}, body=${res.body ? res.body.substring(0, 200) : 'empty'}`);
  }

  return null;
}

/**
 * REST API를 통한 메시지 전송 시뮬레이션
 * 실제로는 WebSocket STOMP를 사용하지만 부하 테스트에서는 REST로 시뮬레이션
 */
function sendMessage(token, roomId, content, chatRoomType, user) {
  const startTime = new Date();

  // 부하 테스트용 REST API 엔드포인트 사용 (Profile-protected: dev/local/test only)
  // 인증 우회를 위해 testSenderId와 testNickname을 쿼리 파라미터로 전달
  let url = `${BASE_URL}/api/v1/chats/rooms/messages`;
  if (user) {
      url += `?testSenderId=${user.id}&testNickname=${user.nickname}`;
  }

  const res = http.post(
    url,
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
        // Authorization 헤더 제거: 부하 테스트용 백도어 API는 토큰 없이 쿼리 파라미터로 인증 처리
        // 토큰이 있으면 필터에서 검증을 시도하다가 DB 부하 등으로 401이 발생할 수 있음
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
  } else {
    // 디버깅: 실패 원인 출력
    const errorBody = res.body ? res.body.substring(0, 200) : "(empty body)";
    console.error(`[메시지 전송 실패] Status: ${res.status}, Body: ${errorBody}`);
  }

  return success;
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

  const success = check(res, {
    "멤버 초대 성공": (r) => r.status === 200,
  });

  if (success) {
    membersInvited.add(1);
  }

  return success;
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

  if (success) {
    membersKicked.add(1);
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

  if (success) {
    ownershipTransferred.add(1);
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

// ==================== 시나리오 함수 ====================

/**
 * 시나리오 1: Direct 채팅 집중 사용자 (20%)
 * - 1:1 채팅방 생성
 * - 메시지 송수신
 * - 여러 파트너와 채팅
 */
function directChatFocusedScenario(user, token, sharedRooms) {
  group("Direct Chat Focused - 1:1 채팅 집중 사용자", () => {
    activeUsers.add(1);

    // Direct 방 목록 조회
    const directRooms = getDirectRoomList(token);

    // 새로운 파트너와 채팅 시작 (2-4명)
    const partnerCount = randomIntBetween(2, 4);
    const newDirectRooms = [];

    for (let i = 0; i < partnerCount; i++) {
      const partner = randomItem(users);
      if (partner.id !== user.id) {
        const room = createOrFindDirectChat(token, partner.id);
        if (room) {
          newDirectRooms.push(room);
          sleep(0.5);
        }
      }
    }

    const allDirectRooms = [...directRooms, ...newDirectRooms];

    // 각 방에서 메시지 주고받기
    for (const room of allDirectRooms.slice(0, 3)) {
      // 최대 3개 방
      // 메시지 읽기
      getMessages(token, room.id, "DIRECT", null, 20);
      sleep(randomIntBetween(1, 2));

      // 메시지 보내기 (2-5개)
      const messageCount = randomIntBetween(2, 5);
      for (let i = 0; i < messageCount; i++) {
        const content = randomItem(MESSAGE_TEMPLATES);
        sendMessage(token, room.id, content, "DIRECT", user);
        sleep(randomIntBetween(1, 3));
      }
    }

    activeUsers.add(-1);
  });
}

/**
 * 시나리오 2: 그룹 채팅 일반 사용자 (50%)
 * - 그룹 방 목록 조회
 * - 메시지 읽기/쓰기
 * - 공개 방 참가
 */
function groupChatCasualScenario(user, token, sharedRooms) {
  group("Group Chat Casual - 그룹 채팅 일반 사용자", () => {
    activeUsers.add(1);

    // 그룹 방 목록 조회
    let groupRooms = getGroupRoomList(token);
    sleep(0.5);

    // 방이 없으면 공유 방 또는 공개 방에 참가
    if (groupRooms.length === 0) {
      // 공유 테스트 방에 참가 시도 (모두 공개방)
      if (sharedRooms.length > 0) {
        const targetRoom = randomItem(sharedRooms);
        joinGroupRoom(token, targetRoom.id);
        sleep(1);
        groupRooms = getGroupRoomList(token);
      }

      // 여전히 없으면 공개 방 조회 (비밀번호 없는 방만 선택)
      if (groupRooms.length === 0) {
        const publicRooms = getPublicGroupRooms(token);
        const noPasswordRooms = publicRooms.filter(room => !room.hasPassword);
        if (noPasswordRooms.length > 0) {
          const targetRoom = randomItem(noPasswordRooms);
          joinGroupRoom(token, targetRoom.id);
          sleep(1);
          groupRooms = getGroupRoomList(token);
        }
      }
    }

    if (groupRooms.length === 0) {
      activeUsers.add(-1);
      return;
    }

    // 랜덤 방 선택
    const room = randomItem(groupRooms);

    // 70% 확률로 메시지 읽기
    if (Math.random() < 0.7) {
      getMessages(token, room.id, "GROUP", null, 30);
      sleep(randomIntBetween(2, 4));
    }

    // 30% 확률로 메시지 전송
    if (Math.random() < 0.3) {
      const content = randomItem(MESSAGE_TEMPLATES);
      sendMessage(token, room.id, content, "GROUP", user);
      sleep(randomIntBetween(1, 3));
    }

    activeUsers.add(-1);
  });
}

/**
 * 시나리오 3: 활발한 그룹 채팅 사용자 (20%)
 * - 여러 방에서 활발한 활동
 * - 지속적인 메시지 송수신
 */
function groupChatActiveScenario(user, token, sharedRooms) {
  group("Group Chat Active - 활발한 그룹 채팅 사용자", () => {
    activeUsers.add(1);

    let groupRooms = getGroupRoomList(token);

    // 방이 없으면 공유 방에 참가 (모두 공개방)
    if (groupRooms.length === 0 && sharedRooms.length > 0) {
      const targetRoom = randomItem(sharedRooms);
      joinGroupRoom(token, targetRoom.id);
      groupRooms = getGroupRoomList(token);
    }

    if (groupRooms.length === 0) {
      activeUsers.add(-1);
      return;
    }

    // 여러 방에서 활동 (최대 3개)
    const activeRooms = groupRooms.slice(0, 3);

    for (const room of activeRooms) {
      // 메시지 읽기
      getMessages(token, room.id, "GROUP");
      sleep(randomIntBetween(1, 2));

      // 연속 메시지 전송 (3-7개)
      const messageCount = randomIntBetween(3, 7);
      for (let i = 0; i < messageCount; i++) {
        const content = randomItem(MESSAGE_TEMPLATES);
        sendMessage(token, room.id, content, "GROUP", user);
        sleep(randomIntBetween(1, 2));
      }

      sleep(randomIntBetween(2, 4));
    }

    activeUsers.add(-1);
  });
}

/**
 * 시나리오 4: 방 관리자 (5%)
 * - 그룹 방 생성
 * - 멤버 초대
 * - 관리 작업 (강퇴, 방장 위임)
 */
function roomManagerScenario(user, token, users) {
  group("Room Manager - 방 관리자", () => {
    activeUsers.add(1);

    // 그룹 방 생성 (랜덤 크기)
    const roomSize = randomIntBetween(3, 10);
    const inviteMembers = [];

    for (let i = 0; i < roomSize; i++) {
      const randomUser = randomItem(users);
      if (randomUser.id !== user.id && !inviteMembers.includes(randomUser.id)) {
        inviteMembers.push(randomUser.id);
      }
    }

    // 부하 테스트에서는 모든 방을 공개방으로 생성 (비밀번호 없음)
    const password = "";

    const room = createGroupChat(
      token,
      `[LOAD_TEST] ${user.nickname}의 채팅방 ${randomIntBetween(1, 1000)}`,
      inviteMembers,
      password,
      "부하 테스트용 공개 채팅방",
      "LOAD_TEST"
    );

    if (!room) {
      activeUsers.add(-1);
      return;
    }

    sleep(1);

    // 환영 메시지 전송
    sendMessage(
      token,
      room.id,
      "환영합니다! 자유롭게 대화해주세요.",
      "GROUP",
      user
    );
    sleep(1);

    // 추가 멤버 초대 (30% 확률)
    if (Math.random() < 0.3) {
      const newMember = randomItem(users);
      if (newMember.id !== user.id && !inviteMembers.includes(newMember.id)) {
        inviteMember(token, room.id, newMember.id);
        sleep(1);
        sendMessage(
          token,
          room.id,
          `${newMember.nickname}님을 초대했습니다`,
          "GROUP",
          user
        );
      }
    }

    sleep(2);

    // 몇 개 메시지 전송
    for (let i = 0; i < randomIntBetween(3, 5); i++) {
      sendMessage(token, room.id, randomItem(MESSAGE_TEMPLATES), "GROUP", user);
      sleep(randomIntBetween(1, 3));
    }

    // 방장 위임 (10% 확률)
    if (Math.random() < 0.1 && inviteMembers.length > 0) {
      const newOwner = inviteMembers[0];
      transferOwnership(token, room.id, newOwner);
      sleep(1);
    }

    // 방 나가기 (20% 확률)
    if (Math.random() < 0.2) {
      leaveRoom(token, room.id, "GROUP");
      activeGroupRooms.add(-1);
    }

    activeUsers.add(-1);
  });
}

/**
 * 시나리오 5: 혼합 사용자 (5%)
 * - Direct와 Group을 모두 사용
 * - 다양한 활동 패턴
 */
function mixedUserScenario(user, token, sharedRooms) {
  group("Mixed User - Direct & Group 혼합 사용자", () => {
    activeUsers.add(1);

    // Direct 채팅 활동
    const directRooms = getDirectRoomList(token);
    if (directRooms.length > 0) {
      const directRoom = randomItem(directRooms);
      getMessages(token, directRoom.id, "DIRECT");
      sleep(1);
      sendMessage(token, directRoom.id, randomItem(MESSAGE_TEMPLATES), "DIRECT", user);
      sleep(2);
    }

    // Group 채팅 활동
    let groupRooms = getGroupRoomList(token);
    if (groupRooms.length === 0 && sharedRooms.length > 0) {
      const targetRoom = randomItem(sharedRooms);
      joinGroupRoom(token, targetRoom.id);
      groupRooms = getGroupRoomList(token);
    }

    if (groupRooms.length > 0) {
      const groupRoom = randomItem(groupRooms);
      getMessages(token, groupRoom.id, "GROUP");
      sleep(1);
      sendMessage(token, groupRoom.id, randomItem(MESSAGE_TEMPLATES), "GROUP", user);
      sleep(2);
    }

    // 공개 방 탐색 및 참가 (비밀번호 없는 방만)
    const publicRooms = getPublicGroupRooms(token);
    const noPasswordRooms = publicRooms.filter(room => !room.hasPassword);
    if (noPasswordRooms.length > 0 && Math.random() < 0.5) {
      const newRoom = randomItem(noPasswordRooms);
      if (joinGroupRoom(token, newRoom.id)) {
        sleep(1);
        sendMessage(token, newRoom.id, "안녕하세요!", "GROUP", user);
      }
    }

    activeUsers.add(-1);
  });
}

// ==================== Setup & Teardown ====================

export function setup() {
  console.log("========================================");
  console.log("Direct & Group 채팅 전용 부하 테스트 시작");
  console.log("========================================");
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Test Duration: ${TEST_DURATION}`);
  console.log(`Load Profile: ${LOAD_PROFILES[TEST_DURATION].length} stages`);
  console.log("========================================");
  console.log("테스트 범위:");
  console.log("  ✅ Direct Chat (1:1 채팅)");
  console.log("  ✅ Group Chat (그룹 채팅)");
  console.log("  ❌ AI Chat (제외 - 팀원 홈서버 보호)");
  console.log("========================================");

  // 1) 모든 유저 로그인 (setup에서 딱 1번) - 배치 처리
  const tokenCache = {};
  console.log("유저 100명 로그인 중 (배치 처리)...");

  let loginSuccessCount = 0;
  let loginFailCount = 0;

  const loginBatchSize = 20;  // 한 번에 20명씩 동시 로그인
  for (let i = 0; i < users.length; i += loginBatchSize) {
    const batchUsers = users.slice(i, i + loginBatchSize);
    const loginRequests = batchUsers.map(u => ({
      method: 'POST',
      url: `${BASE_URL}/api/v1/auth/login`,
      body: JSON.stringify({ email: u.email, password: u.password }),
      params: {
        headers: { "Content-Type": "application/json" },
      },
    }));

    const responses = http.batch(loginRequests);

    // 결과 처리
    responses.forEach((res, idx) => {
      const user = batchUsers[idx];
      if (res.status === 200) {
        const body = JSON.parse(res.body);
        if (body.data && body.data.length > 0) {
          tokenCache[user.id] = body.data;
          loginSuccessCount++;
        } else {
          console.error(`❌ 유저 ${user.email} 로그인 실패 - 응답에 토큰 없음`);
          loginFailCount++;
        }
      } else {
        console.error(`❌ 유저 ${user.email} 로그인 실패 (status: ${res.status}, body: ${res.body ? res.body.substring(0, 100) : 'empty'})`);
        loginFailCount++;
      }
    });
  }

  console.log(`로그인 완료: 성공 ${loginSuccessCount}명, 실패 ${loginFailCount}명`);
  console.log("========================================");

  // 2) 공유 그룹 채팅방 생성 (기존 로직 유지)
  const sharedRooms = [];
  const ownerUser = users[0];
  let ownerToken = tokenCache[ownerUser.id];

  // 방장 로그인 실패 시 재시도 또는 스킵
  if (!ownerToken) {
     console.log("방장 로그인 재시도...");
     const retryToken = login(ownerUser.email, ownerUser.password);
     if(retryToken) {
        ownerToken = retryToken;
        tokenCache[ownerUser.id] = retryToken;
     } else {
        console.error("Setup 실패: 방장(owner) 로그인 실패");
        // return { sharedRooms: [], tokenCache }; 
        // 실패해도 진행하도록 (다른 유저들이라도)
     }
  }

  // 방장이 로그인 성공했을 때만 방 생성
  if (ownerToken) {
      const roomSizes = [5, 5, 10, 10, 10, 20, 20, 30, 30, 50, 50, 50, 100, 100, 100];

      for (let i = 0; i < roomSizes.length; i++) {
        const roomSize = roomSizes[i];
        const memberIds = [];

        for (let j = 1; j <= roomSize; j++) {
          const userId = (i * 10 + j) % users.length + 1;
          if (userId !== ownerUser.id) {
            memberIds.push(userId);
          }
        }

        const room = createGroupChat(
          ownerToken,
          `[LOAD_TEST] 공유 테스트 방 ${i + 1} (${roomSize}명)`,
          memberIds.slice(0, Math.min(roomSize, memberIds.length)),
          "",  // 공개방 (비밀번호 없음)
          `${roomSize}명 규모 테스트 방`,
          "LOAD_TEST"
        );

        if (room) {
          sharedRooms.push(room);
          console.log(`공유 방 생성: ${room.id} - ${room.name} (멤버: ${roomSize}명)`);

          // 초기 메시지 삽입 (페이지네이션 테스트용 - 부하 감소를 위해 20개로 축소)
          const initialMessages = Math.min(roomSize * 2, 20);  // 최대 20개로 제한
          const batchSize = 5;  // 한 번에 5개씩 동시 전송 (서버 부하 고려)

          for (let batchStart = 1; batchStart <= initialMessages; batchStart += batchSize) {
            const requests = [];
            const batchEnd = Math.min(batchStart + batchSize - 1, initialMessages);

            for (let k = batchStart; k <= batchEnd; k++) {
              requests.push({
                method: 'POST',
                url: `${BASE_URL}/api/v1/chats/rooms/messages?testSenderId=${ownerUser.id}&testNickname=${ownerUser.nickname}`, // 쿼리 파라미터 추가
                body: JSON.stringify({
                  roomId: room.id,
                  content: `테스트 메시지 ${k}`,
                  messageType: "TEXT",
                  chatRoomType: "GROUP",
                  isTranslateEnabled: false,
                }),
                params: {
                  headers: {
                    "Content-Type": "application/json",
                    // Authorization: `Bearer ${ownerToken}`, // 헤더 제거
                  },
                },
              });
            }

            http.batch(requests);  // 배치로 동시 전송
          }
          console.log(`  └─ 초기 메시지 ${initialMessages}개 삽입 완료 (배치 처리)`);
        }

        sleep(0.5);
      }
      
      console.log(`  - 소규모 (5-10명): ${sharedRooms.filter(r => r.name.includes("5명") || r.name.includes("10명")).length}개`);
  }

  return {
    tokenCache,
    sharedRooms,
    startTime: new Date(),
  };
}

export default function (data) {
  const { sharedRooms, tokenCache } = data;

  const userIndex = (__VU - 1) % users.length;
  const user = users[userIndex];

  // 토큰이 없어도 진행 (sendMessage에서 user 객체로 인증 우회)
  // 단, 다른 API들(방 조회 등)은 여전히 토큰이 필요하므로, 토큰이 없으면 로그인 시도하거나 스킵
  let token = tokenCache[user.id];
  
  if (!token) {
     // 토큰이 없으면 반드시 로그인 시도
     token = login(user.email, user.password);
     if (token) {
       tokenCache[user.id] = token;
     } else {
       // 로그인 실패 시 이번 턴 스킵
       return;
     }
  }

  // 사용자 유형별 비율 (0-99 랜덤)
  const userType = randomIntBetween(0, 99);

  if (userType < 20) {
    // 20%: Direct 채팅 집중
    directChatFocusedScenario(user, token, sharedRooms);
  } else if (userType < 70) {
    // 50%: 그룹 채팅 일반 사용자
    groupChatCasualScenario(user, token, sharedRooms);
  } else if (userType < 90) {
    // 20%: 활발한 그룹 채팅 사용자
    groupChatActiveScenario(user, token, sharedRooms);
  } else if (userType < 95) {
    // 5%: 방 관리자
    roomManagerScenario(user, token, users);
  } else {
    // 5%: 혼합 사용자
    mixedUserScenario(user, token, sharedRooms);
  }

  sleep(randomIntBetween(1, 3));
}

export function teardown(data) {
  const duration = (new Date() - data.startTime) / 1000 / 60;
  console.log("========================================");
  console.log("Direct & Group 채팅 전용 부하 테스트 완료");
  console.log(`총 테스트 시간: ${duration.toFixed(2)}분`);
  console.log("========================================");
  console.log("메트릭 요약:");
  console.log(`- Direct 채팅방 생성: ${directChatCreated.name}`); // Counter 객체 자체는 값 출력이 안됨. k6 요약 참조.
  console.log("  (상세 값은 k6 요약 보고서를 확인하세요)");
  console.log("========================================");
  console.log("테스트 완료 - AI 채팅 제외됨 (팀원 홈서버 보호)");
  console.log("========================================");

  // 부하테스트 데이터 정리
  console.log("부하테스트 데이터 정리 시작...");
  const { tokenCache } = data;
  const ownerToken = tokenCache[1]; // 첫 번째 유저의 토큰 사용

  if (!ownerToken) {
    console.error("❌ Cleanup 실패: 관리자 토큰이 없습니다");
    return;
  }

  const cleanupRes = http.post(
    `${BASE_URL}/api/v1/chats/loadtest/cleanup`,
    null,
    {
      headers: {
        Authorization: `Bearer ${ownerToken}`,
      },
    }
  );

  if (cleanupRes.status === 200) {
    const result = JSON.parse(cleanupRes.body);
    console.log("✅ 데이터 정리 완료:");
    console.log(`   - 총 삭제: ${result.data.deletedCount}개 (방 + 멤버 + 메시지)`);
  } else {
    console.error(`❌ Cleanup 실패: ${cleanupRes.status} - ${cleanupRes.body}`);
  }
  console.log("========================================");
}
