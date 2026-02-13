/**
 * ========================================
 * 완전 종합 채팅 시스템 부하 테스트 (AI 3가지 기능 모두 포함)
 * ========================================
 *
 * 목적: Direct, Group, AI 채팅 + 3가지 AI 기능 완벽 검증
 *
 * AI 기능 3종 완벽 커버리지:
 *
 * 1. 자동 번역 기능 (40% 사용자)
 *    - 적용 범위: 모든 채팅방 (Direct, Group, AI)
 *    - 동작 방식: Ollama → OpenAI fallback
 *    - 테스트: 번역 응답 시간, fallback 성공률
 *
 * 2. AI 피드백/학습노트 기능 (30% 사용자)
 *    - 적용 범위: 모든 채팅방
 *    - 동작 방식: OpenAI 전용 (품질 문제로 Ollama 미사용)
 *    - 테스트: 피드백 생성 시간, 학습노트 저장
 *
 * 3. AI 채팅방 기능 (15% 사용자)
 *    - 적용 범위: AI 채팅방만
 *    - 동작 방식: Ollama (ROLE_PLAY, TUTOR_PERSONAL, TUTOR_SIMILAR)
 *    - 테스트: AI 응답 시간, 타임아웃율
 *
 * Ollama 서버 부하 분석:
 * - 번역 (Ollama 시도): 40% 중 일부
 * - AI 채팅방: 15%
 * - 총 예상 부하: ~40-50%
 *
 * 부하 프로필:
 * - short: 3분 (빠른 검증)
 * - medium: 8분 (표준 테스트)
 * - full: 12분 (완전한 부하 테스트)
 *
 * 실행 방법:
 * k6 run chat-comprehensive-with-ai-load-test.js \
 *   --env BASE_URL=http://localhost:8080 \
 *   --env TEST_DURATION=full \
 *   --env OLLAMA_AVAILABLE=true \
 *   --env OPENAI_AVAILABLE=true
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { SharedArray } from "k6/data";
import { Counter, Trend, Rate, Gauge } from "k6/metrics";
import { randomItem, randomIntBetween, randomString } from "https://jslib.k6.io/k6-utils/1.2.0/index.js";

// ==================== 커스텀 메트릭 정의 ====================

// 채팅 기본 메트릭
const directChatCreated = new Counter("direct_chat_created");
const groupChatCreated = new Counter("group_chat_created");
const aiChatCreated = new Counter("ai_chat_created");
const messagesReceived = new Counter("messages_received");
const messagesSent = new Counter("messages_sent");

// AI 기능 1: 자동 번역
const translationRequested = new Counter("translation_requested");
const translationByOllama = new Counter("translation_by_ollama");
const translationByOpenAI = new Counter("translation_by_openai");
const translationFailed = new Counter("translation_failed");

const translationLatency = new Trend("translation_latency");
const translationOllamaLatency = new Trend("translation_ollama_latency");
const translationOpenAILatency = new Trend("translation_openai_latency");

const translationSuccessRate = new Rate("translation_success_rate");
const translationOllamaSuccessRate = new Rate("translation_ollama_success_rate");
const translationFallbackRate = new Rate("translation_fallback_rate");

// AI 기능 2: AI 피드백/학습노트 (OpenAI 전용)
const feedbackRequested = new Counter("feedback_requested");
const feedbackSuccess = new Counter("feedback_success");
const feedbackFailed = new Counter("feedback_failed");

const feedbackLatency = new Trend("feedback_latency");
const feedbackSuccessRate = new Rate("feedback_success_rate");

// AI 기능 3: AI 채팅방
const aiRoomMessages = new Counter("ai_room_messages");
const aiResponseSuccess = new Counter("ai_response_success");
const aiResponseFailed = new Counter("ai_response_failed");
const aiResponseTimeout = new Counter("ai_response_timeout");

const aiResponseLatency = new Trend("ai_response_latency");
const aiRolePlayLatency = new Trend("ai_roleplay_latency");
const aiTutorPersonalLatency = new Trend("ai_tutor_personal_latency");

const aiSuccessRate = new Rate("ai_success_rate");
const aiTimeoutRate = new Rate("ai_timeout_rate");

// 일반 메트릭
const messageReadLatency = new Trend("message_read_latency");
const messageSendLatency = new Trend("message_send_latency");
const roomListLatency = new Trend("room_list_latency");

const authSuccessRate = new Rate("auth_success_rate");
const messageSuccessRate = new Rate("message_success_rate");

const activeUsers = new Gauge("active_users");
const activeTranslationUsers = new Gauge("active_translation_users");
const activeFeedbackUsers = new Gauge("active_feedback_users");
const activeAIUsers = new Gauge("active_ai_users");

// ==================== 테스트 설정 ====================
const TEST_DURATION = __ENV.TEST_DURATION || "full";
const OLLAMA_AVAILABLE = __ENV.OLLAMA_AVAILABLE !== "false"; // 기본 true
const OPENAI_AVAILABLE = __ENV.OPENAI_AVAILABLE !== "false"; // 기본 true
const AI_TIMEOUT = parseInt(__ENV.AI_TIMEOUT || "30000", 10);

const LOAD_PROFILES = {
  short: [
    { duration: "30s", target: 20 },   // Warmup
    { duration: "1m", target: 50 },    // Normal
    { duration: "1m", target: 100 },   // Peak
    { duration: "30s", target: 0 },    // Cooldown
  ],
  medium: [
    { duration: "1m", target: 30 },    // Warmup
    { duration: "2m", target: 100 },   // Normal
    { duration: "2m", target: 200 },   // Peak
    { duration: "2m", target: 300 },   // Stress
    { duration: "1m", target: 50 },    // Recovery
    { duration: "30s", target: 0 },    // Cooldown
  ],
  full: [
    { duration: "1m", target: 30 },    // Warmup
    { duration: "2m", target: 100 },   // Normal
    { duration: "2m", target: 200 },   // Peak
    { duration: "2m", target: 350 },   // High Stress
    { duration: "2m", target: 500 },   // Very High Stress
    { duration: "1m", target: 700 },   // Spike
    { duration: "1m", target: 100 },   // Recovery
    { duration: "30s", target: 0 },    // Cooldown
  ],
};

export const options = {
  stages: LOAD_PROFILES[TEST_DURATION],
  thresholds: {
    http_req_failed: ["rate<0.02"], // 2% 미만 (AI 고려)
    http_req_duration: ["p(95)<3000", "p(99)<8000"],

    // 엔드포인트별 임계값
    "http_req_duration{endpoint:login}": ["p(95)<500"],
    "http_req_duration{endpoint:getMessages}": ["p(95)<1000"],
    "http_req_duration{endpoint:sendMessage}": ["p(95)<2000"], // 번역 포함

    // AI 기능 1: 번역 (Ollama → OpenAI fallback)
    translation_success_rate: ["rate>0.90"], // 90% 이상 성공
    translation_latency: ["p(95)<3000"], // 번역 3초 이내
    translation_fallback_rate: ["rate<0.5"], // fallback 50% 미만

    // AI 기능 2: 피드백 (OpenAI 전용)
    feedback_success_rate: ["rate>0.95"], // 95% 이상 (OpenAI 안정적)
    feedback_latency: ["p(95)<5000"], // 피드백 5초 이내

    // AI 기능 3: AI 채팅방 (Ollama)
    ai_success_rate: ["rate>0.85"], // 85% 이상
    ai_response_latency: ["p(95)<15000"], // 15초 이내
    ai_timeout_rate: ["rate<0.15"], // 타임아웃 15% 미만

    // 일반 메트릭
    message_success_rate: ["rate>0.98"],
    auth_success_rate: ["rate>0.99"],
  },
  timeout: `${AI_TIMEOUT}ms`,
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

const AI_PERSONAS = [1, 2, 3, 4, 5];
const AI_CHAT_ROOM_TYPES = ["ROLE_PLAY", "TUTOR_PERSONAL", "TUTOR_SIMILAR"];

const MESSAGE_TEMPLATES = [
  "Hello! How are you today?",
  "I'm learning English now",
  "This is a test message",
  "Can you help me?",
  "Thank you very much",
  "See you later",
  "Have a good day",
  "I understand",
  "Let me know",
  "That sounds great!",
];

const AI_QUESTIONS = {
  ROLE_PLAY: [
    "Hello! How are you today?",
    "What's your favorite hobby?",
    "Can you help me practice English?",
  ],
  TUTOR_PERSONAL: [
    "What is a SELECT statement in SQL?",
    "How do I use JOIN in SQL?",
    "Explain primary key to me",
  ],
  TUTOR_SIMILAR: [
    "What is REST API?",
    "Explain object-oriented programming",
    "How does authentication work?",
  ],
};

// ==================== 헬퍼 함수 ====================

function login(email, password) {
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
  });

  authSuccessRate.add(success);

  if (res.status === 200) {
    const body = JSON.parse(res.body);
    return body.data;
  }
  return null;
}

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

  if (res.status === 200) {
    directChatCreated.add(1);
    const body = JSON.parse(res.body);
    return body.data;
  }
  return null;
}

function createGroupChat(token, roomName, memberIds, password = "", description = "", topic = "") {
  const res = http.post(
    `${BASE_URL}/api/v1/chats/rooms/group`,
    JSON.stringify({ roomName, memberIds, password, description, topic }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      tags: { endpoint: "createRoom" },
    }
  );

  if (res.status === 200) {
    groupChatCreated.add(1);
    const body = JSON.parse(res.body);
    return body.data;
  }
  return null;
}

function createAIChat(token, roomName, personaId, roomType) {
  const res = http.post(
    `${BASE_URL}/api/v1/chats/rooms/ai`,
    JSON.stringify({ roomName, personaId, roomType }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      tags: { endpoint: "createRoom" },
    }
  );

  if (res.status === 200) {
    aiChatCreated.add(1);
    const body = JSON.parse(res.body);
    return body.data;
  }
  return null;
}

function getGroupRoomList(token) {
  const startTime = new Date();
  const res = http.get(`${BASE_URL}/api/v1/chats/rooms/group`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { endpoint: "getRoomList" },
  });

  roomListLatency.add(new Date() - startTime);

  if (res.status === 200) {
    const body = JSON.parse(res.body);
    return body.data || [];
  }
  return [];
}

function getDirectRoomList(token) {
  const res = http.get(`${BASE_URL}/api/v1/chats/rooms/direct`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { endpoint: "getRoomList" },
  });

  if (res.status === 200) {
    const body = JSON.parse(res.body);
    return body.data || [];
  }
  return [];
}

function getAIRoomList(token) {
  const res = http.get(`${BASE_URL}/api/v1/chats/rooms/ai`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { endpoint: "getRoomList" },
  });

  if (res.status === 200) {
    const body = JSON.parse(res.body);
    return body.data || [];
  }
  return [];
}

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

  return res.status === 200 || res.status === 400;
}

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

  if (res.status === 200) {
    messagesReceived.add(1);
    const body = JSON.parse(res.body);
    return body.data.messagePageResp || null;
  }
  return null;
}

/**
 * AI 기능 1: 자동 번역이 포함된 메시지 전송
 * - isTranslateEnabled를 동적으로 설정
 * - Ollama → OpenAI fallback (백엔드에서 처리)
 */
function sendMessage(token, roomId, content, chatRoomType, enableTranslation = false) {
  const startTime = new Date();

  const res = http.post(
    `${BASE_URL}/api/v1/chats/rooms/${roomId}/files`,
    JSON.stringify({
      roomId,
      content,
      messageType: "TEXT",
      chatRoomType,
      isTranslateEnabled: enableTranslation, // ← 번역 활성화 여부
    }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      tags: { endpoint: "sendMessage" },
      timeout: enableTranslation ? `${AI_TIMEOUT}ms` : "10s",
    }
  );

  const latency = new Date() - startTime;
  messageSendLatency.add(latency);

  if (enableTranslation) {
    translationRequested.add(1);
    translationLatency.add(latency);

    // 번역 성공 여부 확인
    const success = check(res, {
      "번역 메시지 전송 성공": (r) => r.status === 200,
    });

    translationSuccessRate.add(success);

    if (success) {
      // 응답에서 번역 제공자 확인 (백엔드 응답 구조에 따라 조정 필요)
      try {
        const body = JSON.parse(res.body);
        // 번역 latency로 추정 (3초 미만은 Ollama, 이상은 OpenAI fallback으로 추정)
        if (latency < 3000) {
          translationByOllama.add(1);
          translationOllamaLatency.add(latency);
          translationOllamaSuccessRate.add(1);
          translationFallbackRate.add(0);
        } else {
          translationByOpenAI.add(1);
          translationOpenAILatency.add(latency);
          translationFallbackRate.add(1);
        }
      } catch (e) {
        // JSON 파싱 실패 시 무시
      }
    } else {
      translationFailed.add(1);
    }
  }

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
 * AI 기능 2: AI 피드백/학습노트 (OpenAI 전용)
 * - 품질 문제로 OpenAI만 사용
 * - 번역된 메시지와 원문 비교
 */
function analyzeAIFeedback(token, messages, targetLanguage = "en") {
  const startTime = new Date();
  feedbackRequested.add(1);

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
      tags: { endpoint: "aiFeedback" },
      timeout: `${AI_TIMEOUT}ms`,
    }
  );

  const latency = new Date() - startTime;
  feedbackLatency.add(latency);

  const success = check(res, {
    "AI 피드백 분석 성공": (r) => r.status === 200,
  });

  feedbackSuccessRate.add(success);

  if (success) {
    feedbackSuccess.add(1);
  } else {
    feedbackFailed.add(1);
  }

  return success;
}

/**
 * AI 기능 3: AI 채팅방에서 메시지 전송 (Ollama)
 */
function sendAIMessage(token, roomId, content, roomType) {
  const startTime = new Date();
  aiRoomMessages.add(1);

  const res = http.post(
    `${BASE_URL}/api/v1/chats/rooms/${roomId}/files`,
    JSON.stringify({
      roomId,
      content,
      messageType: "TEXT",
      chatRoomType: "AI",
      isTranslateEnabled: false,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      tags: { endpoint: "aiChat", roomType: roomType },
      timeout: `${AI_TIMEOUT}ms`,
    }
  );

  const latency = new Date() - startTime;
  aiResponseLatency.add(latency);

  // 유형별 latency 기록
  if (roomType === "ROLE_PLAY") {
    aiRolePlayLatency.add(latency);
  } else if (roomType === "TUTOR_PERSONAL") {
    aiTutorPersonalLatency.add(latency);
  }

  const success = check(res, {
    "AI 메시지 전송 성공": (r) => r.status === 200,
  });

  if (success) {
    aiResponseSuccess.add(1);
    aiSuccessRate.add(1);
    aiTimeoutRate.add(0);
  } else {
    aiResponseFailed.add(1);
    aiSuccessRate.add(0);

    if (res.timed_out) {
      aiResponseTimeout.add(1);
      aiTimeoutRate.add(1);
    } else {
      aiTimeoutRate.add(0);
    }
  }

  return success;
}

// ==================== 시나리오 함수 ====================

/**
 * 시나리오 1: 번역 집중 사용자 (20%)
 * - Direct/Group 채팅에서 번역 기능 적극 사용
 */
function translationFocusedScenario(user, sharedRooms) {
  group("Translation Focused - 번역 집중 사용자", () => {
    const token = login(user.email, user.password);
    if (!token) return;

    activeUsers.add(1);
    activeTranslationUsers.add(1);

    // 그룹 방 참가
    let groupRooms = getGroupRoomList(token);
    if (groupRooms.length === 0 && sharedRooms.length > 0) {
      const targetRoom = randomItem(sharedRooms);
      joinGroupRoom(token, targetRoom.id);
      groupRooms = getGroupRoomList(token);
    }

    if (groupRooms.length > 0) {
      const room = randomItem(groupRooms);

      // 번역 활성화해서 메시지 전송 (5-8개)
      const messageCount = randomIntBetween(5, 8);
      for (let i = 0; i < messageCount; i++) {
        const content = randomItem(MESSAGE_TEMPLATES);
        sendMessage(token, room.id, content, "GROUP", true); // 번역 활성화!
        sleep(randomIntBetween(2, 5));
      }
    }

    activeTranslationUsers.add(-1);
    activeUsers.add(-1);
  });
}

/**
 * 시나리오 2: 피드백 집중 사용자 (20%)
 * - 채팅 후 AI 피드백 요청 (OpenAI 전용)
 */
function feedbackFocusedScenario(user, sharedRooms) {
  group("Feedback Focused - AI 피드백 집중 사용자", () => {
    const token = login(user.email, user.password);
    if (!token) return;

    activeUsers.add(1);
    activeFeedbackUsers.add(1);

    // 그룹 방 참가
    let groupRooms = getGroupRoomList(token);
    if (groupRooms.length === 0 && sharedRooms.length > 0) {
      const targetRoom = randomItem(sharedRooms);
      joinGroupRoom(token, targetRoom.id);
      groupRooms = getGroupRoomList(token);
    }

    if (groupRooms.length > 0) {
      const room = randomItem(groupRooms);

      // 일반 메시지 전송 (2-3개)
      for (let i = 0; i < randomIntBetween(2, 3); i++) {
        sendMessage(token, room.id, randomItem(MESSAGE_TEMPLATES), "GROUP", false);
        sleep(randomIntBetween(1, 3));
      }

      // AI 피드백 요청 (OpenAI 전용 - 품질 문제로)
      const feedbackMessages = [
        { role: "user", content: "I goes to school yesterday" },
        { role: "assistant", content: "I went to school yesterday" },
      ];

      analyzeAIFeedback(token, feedbackMessages, "en");
      sleep(randomIntBetween(3, 6));

      // 추가 피드백 요청 (50% 확률)
      if (Math.random() < 0.5) {
        const feedbackMessages2 = [
          { role: "user", content: "She don't like coffee" },
          { role: "assistant", content: "She doesn't like coffee" },
        ];
        analyzeAIFeedback(token, feedbackMessages2, "en");
      }
    }

    activeFeedbackUsers.add(-1);
    activeUsers.add(-1);
  });
}

/**
 * 시나리오 3: AI 채팅 집중 사용자 (15%)
 * - AI 채팅방에서 Ollama와 대화
 */
function aiChatFocusedScenario(user) {
  group("AI Chat Focused - AI 채팅 집중 사용자", () => {
    const token = login(user.email, user.password);
    if (!token) return;

    activeUsers.add(1);
    activeAIUsers.add(1);

    let aiRooms = getAIRoomList(token);

    // AI 채팅방 생성 (없으면)
    if (aiRooms.length === 0) {
      const personaId = randomItem(AI_PERSONAS);
      const roomType = randomItem(AI_CHAT_ROOM_TYPES);
      const newRoom = createAIChat(
        token,
        `[LOAD_TEST] AI Chat ${user.nickname}`,
        personaId,
        roomType
      );

      if (newRoom) {
        aiRooms = [newRoom];
      }
    }

    if (aiRooms.length > 0) {
      const aiRoom = randomItem(aiRooms);
      const roomType = aiRoom.roomType || "ROLE_PLAY";

      // AI와 대화 (3-6회)
      const conversations = randomIntBetween(3, 6);
      for (let i = 0; i < conversations; i++) {
        const questions = AI_QUESTIONS[roomType] || AI_QUESTIONS.ROLE_PLAY;
        const question = randomItem(questions);

        sendAIMessage(token, aiRoom.id, question, roomType);
        sleep(randomIntBetween(4, 10)); // AI 응답 대기

        // 응답 메시지 조회
        getMessages(token, aiRoom.id, "AI");
        sleep(randomIntBetween(2, 5));
      }
    }

    activeAIUsers.add(-1);
    activeUsers.add(-1);
  });
}

/**
 * 시나리오 4: 일반 사용자 (30%)
 * - 번역/피드백 가끔 사용
 */
function casualUserScenario(user, sharedRooms) {
  group("Casual User - 일반 사용자", () => {
    const token = login(user.email, user.password);
    if (!token) return;

    activeUsers.add(1);

    let groupRooms = getGroupRoomList(token);
    if (groupRooms.length === 0 && sharedRooms.length > 0) {
      const targetRoom = randomItem(sharedRooms);
      joinGroupRoom(token, targetRoom.id);
      groupRooms = getGroupRoomList(token);
    }

    if (groupRooms.length > 0) {
      const room = randomItem(groupRooms);

      // 메시지 읽기
      getMessages(token, room.id, "GROUP");
      sleep(randomIntBetween(2, 4));

      // 메시지 전송 (30% 확률로 번역 사용)
      const useTranslation = Math.random() < 0.3;
      if (useTranslation) {
        activeTranslationUsers.add(1);
      }

      sendMessage(token, room.id, randomItem(MESSAGE_TEMPLATES), "GROUP", useTranslation);
      sleep(randomIntBetween(2, 4));

      if (useTranslation) {
        activeTranslationUsers.add(-1);
      }

      // 20% 확률로 피드백 요청
      if (Math.random() < 0.2) {
        activeFeedbackUsers.add(1);
        const feedbackMessages = [
          { role: "user", content: randomItem(MESSAGE_TEMPLATES) },
          { role: "assistant", content: randomItem(MESSAGE_TEMPLATES) },
        ];
        analyzeAIFeedback(token, feedbackMessages);
        activeFeedbackUsers.add(-1);
      }
    }

    activeUsers.add(-1);
  });
}

/**
 * 시나리오 5: 활발한 사용자 (10%)
 * - 여러 방에서 활발히 활동
 */
function activeUserScenario(user, sharedRooms) {
  group("Active User - 활발한 사용자", () => {
    const token = login(user.email, user.password);
    if (!token) return;

    activeUsers.add(1);

    let groupRooms = getGroupRoomList(token);
    if (groupRooms.length === 0 && sharedRooms.length > 0) {
      const targetRoom = randomItem(sharedRooms);
      joinGroupRoom(token, targetRoom.id);
      groupRooms = getGroupRoomList(token);
    }

    if (groupRooms.length > 0) {
      const activeRooms = groupRooms.slice(0, 3);

      for (const room of activeRooms) {
        getMessages(token, room.id, "GROUP");
        sleep(randomIntBetween(1, 2));

        // 연속 메시지 전송 (3-5개)
        const messageCount = randomIntBetween(3, 5);
        for (let i = 0; i < messageCount; i++) {
          sendMessage(token, room.id, randomItem(MESSAGE_TEMPLATES), "GROUP", false);
          sleep(randomIntBetween(1, 2));
        }
      }
    }

    activeUsers.add(-1);
  });
}

/**
 * 시나리오 6: 방 관리자 (5%)
 */
function roomManagerScenario(user, users) {
  group("Room Manager - 방 관리자", () => {
    const token = login(user.email, user.password);
    if (!token) return;

    activeUsers.add(1);

    const roomSize = randomIntBetween(3, 10);
    const inviteMembers = [];
    for (let i = 0; i < roomSize; i++) {
      const randomUser = randomItem(users);
      if (randomUser.id !== user.id && !inviteMembers.includes(randomUser.id)) {
        inviteMembers.push(randomUser.id);
      }
    }

    const room = createGroupChat(
      token,
      `[LOAD_TEST] ${user.nickname}의 방`,
      inviteMembers,
      "",
      "테스트 방",
      "LOAD_TEST"
    );

    if (room) {
      sleep(1);
      sendMessage(token, room.id, "환영합니다!", "GROUP", false);
      sleep(2);

      // 몇 개 메시지 전송
      for (let i = 0; i < randomIntBetween(2, 4); i++) {
        sendMessage(token, room.id, randomItem(MESSAGE_TEMPLATES), "GROUP", false);
        sleep(randomIntBetween(1, 3));
      }
    }

    activeUsers.add(-1);
  });
}

// ==================== Setup & Teardown ====================

export function setup() {
  console.log("========================================");
  console.log("완전 종합 채팅 시스템 부하 테스트 시작");
  console.log("AI 3가지 기능 모두 포함");
  console.log("========================================");
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Test Duration: ${TEST_DURATION}`);
  console.log(`Ollama Available: ${OLLAMA_AVAILABLE}`);
  console.log(`OpenAI Available: ${OPENAI_AVAILABLE}`);
  console.log("========================================");
  console.log("AI 기능 커버리지:");
  console.log("  1. 자동 번역 (40% 사용자)");
  console.log("     - Ollama → OpenAI fallback");
  console.log("     - 모든 채팅방 적용");
  console.log("  2. AI 피드백/학습노트 (30% 사용자)");
  console.log("     - OpenAI 전용 (품질 문제로)");
  console.log("     - 모든 채팅방 적용");
  console.log("  3. AI 채팅방 (15% 사용자)");
  console.log("     - Ollama 사용");
  console.log("     - ROLE_PLAY, TUTOR_PERSONAL, TUTOR_SIMILAR");
  console.log("========================================");

  // 공유 그룹 방 생성
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
      `[LOAD_TEST] 공유 테스트 방 ${i + 1}`,
      memberIds.slice(0, 5),
      "",
      `AI 기능 테스트 방 ${i + 1}`,
      "LOAD_TEST"
    );

    if (room) {
      sharedRooms.push(room);
      console.log(`공유 방 생성: ${room.id} - ${room.name}`);

      // 초기 메시지 삽입
      for (let k = 1; k <= 20; k++) {
        sendMessage(
          ownerToken,
          room.id,
          `테스트 메시지 ${k} - ${randomItem(MESSAGE_TEMPLATES)}`,
          "GROUP",
          false
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
  const userIndex = (__VU - 1) % users.length;
  const user = users[userIndex];

  // 사용자 유형별 비율
  const userType = randomIntBetween(0, 99);

  if (userType < 20) {
    // 20%: 번역 집중
    translationFocusedScenario(user, sharedRooms);
  } else if (userType < 40) {
    // 20%: 피드백 집중
    feedbackFocusedScenario(user, sharedRooms);
  } else if (userType < 55) {
    // 15%: AI 채팅 집중
    aiChatFocusedScenario(user);
  } else if (userType < 85) {
    // 30%: 일반 사용자
    casualUserScenario(user, sharedRooms);
  } else if (userType < 95) {
    // 10%: 활발한 사용자
    activeUserScenario(user, sharedRooms);
  } else {
    // 5%: 방 관리자
    roomManagerScenario(user, users);
  }

  sleep(randomIntBetween(1, 3));
}

export function teardown(data) {
  const duration = (new Date() - data.startTime) / 1000 / 60;
  console.log("========================================");
  console.log("완전 종합 채팅 시스템 부하 테스트 완료");
  console.log(`총 테스트 시간: ${duration.toFixed(2)}분`);
  console.log("========================================");
  console.log("메트릭 요약:");
  console.log(`- Direct 채팅방: ${directChatCreated || 0}개`);
  console.log(`- Group 채팅방: ${groupChatCreated || 0}개`);
  console.log(`- AI 채팅방: ${aiChatCreated || 0}개`);
  console.log(`- 메시지 수신: ${messagesReceived || 0}회`);
  console.log(`- 메시지 전송: ${messagesSent || 0}회`);
  console.log("========================================");
  console.log("AI 기능 요약:");
  console.log(`1. 번역 요청: ${translationRequested || 0}회`);
  console.log(`   - Ollama: ${translationByOllama || 0}회`);
  console.log(`   - OpenAI (fallback): ${translationByOpenAI || 0}회`);
  console.log(`   - 실패: ${translationFailed || 0}회`);
  console.log(`2. AI 피드백 (OpenAI 전용): ${feedbackRequested || 0}회`);
  console.log(`   - 성공: ${feedbackSuccess || 0}회`);
  console.log(`   - 실패: ${feedbackFailed || 0}회`);
  console.log(`3. AI 채팅방 메시지: ${aiRoomMessages || 0}회`);
  console.log(`   - 성공: ${aiResponseSuccess || 0}회`);
  console.log(`   - 실패: ${aiResponseFailed || 0}회`);
  console.log(`   - 타임아웃: ${aiResponseTimeout || 0}회`);
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
