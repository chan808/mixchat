/**
 * ========================================
 * AI 채팅 집중 스트레스 테스트
 * ========================================
 *
 * 목적: Ollama LLM 서버의 성능 한계 및 병목 지점 파악
 *
 * 테스트 초점:
 * 1. LLM 응답 시간 측정 (P50, P95, P99, Max)
 * 2. 동시 요청 처리 능력 (5명 → 50명까지)
 * 3. 큐잉/타임아웃 발생 임계점 파악
 * 4. AI 채팅방 유형별 성능 차이 (ROLE_PLAY vs TUTOR_PERSONAL vs TUTOR_SIMILAR)
 * 5. Ollama 서버 리소스 사용률 (CPU, GPU, 메모리)
 * 6. 에러율 및 실패 패턴 분석
 *
 * 예상 결과:
 * - Ollama 로컬: 5-10 동시 요청이 한계 (GPU 없으면 더 낮음)
 * - OpenAI API: 수백 동시 요청 가능하지만 비용 문제
 *
 * 부하 프로필:
 * - Warmup: 30초간 2명 (LLM 워밍업)
 * - Light: 1분간 5명 (기본 처리 능력)
 * - Medium: 1분간 10명 (임계점 탐색)
 * - Heavy: 1분간 20명 (큐잉 발생 시작)
 * - Stress: 1분간 30명 (스트레스)
 * - Extreme: 1분간 50명 (극한 테스트)
 * - Recovery: 1분간 5명 (복구 테스트)
 * - Cooldown: 30초간 0명
 *
 * 실행 방법:
 * k6 run chat-ai-stress-test.js \
 *   --env BASE_URL=http://localhost:8080 \
 *   --env AI_TIMEOUT=30000 \
 *   --env TEST_DURATION=full
 *
 * 주의사항:
 * - Ollama 서버를 별도 모니터링 필수 (htop, nvidia-smi)
 * - GPU 없는 환경에서는 부하 낮춰야 함
 * - 테스트 전에 AI 페르소나(UserPrompt) 데이터 필요
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { SharedArray } from "k6/data";
import { Counter, Trend, Rate, Gauge, Histogram } from "k6/metrics";
import { randomItem, randomIntBetween, randomString } from "https://jslib.k6.io/k6-utils/1.2.0/index.js";

// ==================== 커스텀 메트릭 ====================
const aiRoomCreated = new Counter("ai_room_created");
const aiMessagesTotal = new Counter("ai_messages_total");
const aiResponseSuccess = new Counter("ai_response_success");
const aiResponseFailed = new Counter("ai_response_failed");
const aiResponseTimeout = new Counter("ai_response_timeout");

const aiResponseLatency = new Trend("ai_response_latency");
const aiRolePlayLatency = new Trend("ai_roleplay_latency");
const aiTutorPersonalLatency = new Trend("ai_tutor_personal_latency");
const aiTutorSimilarLatency = new Trend("ai_tutor_similar_latency");
const aiFeedbackLatency = new Trend("ai_feedback_latency");

const aiSuccessRate = new Rate("ai_success_rate");
const aiTimeoutRate = new Rate("ai_timeout_rate");
const aiErrorRate = new Rate("ai_error_rate");

const activeAIUsers = new Gauge("active_ai_users");
const queuedRequests = new Gauge("queued_requests"); // 추정치

// 응답 시간 히스토그램 (분포 확인)
const aiLatencyHistogram = new Histogram("ai_latency_histogram", [
  100, 500, 1000, 2000, 3000, 5000, 10000, 15000, 20000, 30000,
]);

// ==================== 테스트 설정 ====================
const TEST_DURATION = __ENV.TEST_DURATION || "full";
const AI_TIMEOUT = parseInt(__ENV.AI_TIMEOUT || "30000", 10); // 30초 타임아웃

const LOAD_PROFILES = {
  light: [
    { duration: "30s", target: 2 },  // Warmup
    { duration: "1m", target: 5 },   // Light
    { duration: "1m", target: 10 },  // Medium
    { duration: "30s", target: 0 },  // Cooldown
  ],
  medium: [
    { duration: "30s", target: 2 },  // Warmup
    { duration: "1m", target: 5 },   // Light
    { duration: "1m", target: 10 },  // Medium
    { duration: "1m", target: 20 },  // Heavy
    { duration: "1m", target: 5 },   // Recovery
    { duration: "30s", target: 0 },  // Cooldown
  ],
  full: [
    { duration: "30s", target: 2 },  // Warmup
    { duration: "1m", target: 5 },   // Light
    { duration: "1m", target: 10 },  // Medium
    { duration: "1m", target: 20 },  // Heavy
    { duration: "1m", target: 30 },  // Stress
    { duration: "1m", target: 50 },  // Extreme
    { duration: "1m", target: 5 },   // Recovery
    { duration: "30s", target: 0 },  // Cooldown
  ],
};

export const options = {
  stages: LOAD_PROFILES[TEST_DURATION],
  thresholds: {
    // AI 전용 임계값 (일반 API보다 훨씬 관대)
    http_req_failed: ["rate<0.05"], // 5% 미만 실패 허용
    "http_req_duration{endpoint:aiChat}": ["p(95)<15000", "p(99)<30000"], // 95%는 15초, 99%는 30초

    // AI 성공률
    ai_success_rate: ["rate>0.90"], // 90% 이상 성공
    ai_timeout_rate: ["rate<0.10"], // 타임아웃 10% 미만
    ai_error_rate: ["rate<0.05"],   // 에러 5% 미만

    // 응답 시간 (유형별)
    ai_response_latency: ["p(50)<5000", "p(95)<15000", "p(99)<30000"],
    ai_roleplay_latency: ["p(95)<10000"], // Role-play는 비교적 빠름
    ai_tutor_personal_latency: ["p(95)<20000"], // RAG 때문에 느림
    ai_tutor_similar_latency: ["p(95)<20000"],
    ai_feedback_latency: ["p(95)<10000"],
  },
  // AI는 응답이 느리므로 타임아웃 증가
  httpDebug: "full",
  timeout: `${AI_TIMEOUT}ms`,
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";

// ==================== 테스트 데이터 ====================
const users = new SharedArray("test users", function () {
  const userList = [];
  for (let i = 1; i <= 50; i++) {
    userList.push({
      email: `test${i}@test.com`,
      password: "test1234",
      id: i,
      nickname: `TestUser${i}`,
    });
  }
  return userList;
});

// AI 페르소나 (실제 DB에 있어야 함)
const AI_PERSONAS = [1, 2, 3, 4, 5];

// AI 채팅방 유형별 테스트 질문
const AI_QUESTIONS = {
  ROLE_PLAY: [
    "Hello! How are you today?",
    "What is your favorite hobby?",
    "Can you tell me about yourself?",
    "What do you think about learning English?",
    "How can I improve my speaking skills?",
  ],
  TUTOR_PERSONAL: [
    "What is a SELECT statement in SQL?",
    "How do I use JOIN in SQL?",
    "Explain the difference between WHERE and HAVING",
    "What is a primary key?",
    "How do I create an index?",
  ],
  TUTOR_SIMILAR: [
    "What is the best way to learn programming?",
    "Explain object-oriented programming",
    "What is a REST API?",
    "How does authentication work?",
    "What is a database transaction?",
  ],
};

const AI_CHAT_ROOM_TYPES = ["ROLE_PLAY", "TUTOR_PERSONAL", "TUTOR_SIMILAR"];

// ==================== 헬퍼 함수 ====================

function login(email, password) {
  const res = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email, password }),
    {
      headers: { "Content-Type": "application/json" },
      tags: { endpoint: "login" },
      timeout: "5s",
    }
  );

  if (res.status === 200) {
    const body = JSON.parse(res.body);
    return body.data;
  }
  return null;
}

/**
 * AI 채팅방 생성
 */
function createAIRoom(token, roomName, personaId, roomType) {
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
      tags: { endpoint: "createAIRoom" },
      timeout: "5s",
    }
  );

  check(res, {
    "AI 채팅방 생성 성공": (r) => r.status === 200,
  });

  if (res.status === 200) {
    aiRoomCreated.add(1);
    const body = JSON.parse(res.body);
    return body.data;
  }
  return null;
}

/**
 * AI 채팅방 목록 조회
 */
function getAIRoomList(token) {
  const res = http.get(`${BASE_URL}/api/v1/chats/rooms/ai`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { endpoint: "getAIRooms" },
    timeout: "5s",
  });

  if (res.status === 200) {
    const body = JSON.parse(res.body);
    return body.data || [];
  }
  return [];
}

/**
 * AI 채팅 메시지 전송 (WebSocket 시뮬레이션)
 * 실제로는 메시지 저장 + AI 응답 생성까지 포함
 */
function sendAIMessage(token, roomId, content, roomType) {
  const startTime = Date.now();

  // AI 메시지는 /rooms/{roomId}/files 엔드포인트 사용
  // 실제로는 WebSocket STOMP를 사용하지만 REST로 시뮬레이션
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
      tags: {
        endpoint: "aiChat",
        roomType: roomType,
      },
      timeout: `${AI_TIMEOUT}ms`,
    }
  );

  const latency = Date.now() - startTime;
  aiMessagesTotal.add(1);

  // 응답 시간 기록
  aiResponseLatency.add(latency);
  aiLatencyHistogram.add(latency);

  // 유형별 응답 시간 기록
  if (roomType === "ROLE_PLAY") {
    aiRolePlayLatency.add(latency);
  } else if (roomType === "TUTOR_PERSONAL") {
    aiTutorPersonalLatency.add(latency);
  } else if (roomType === "TUTOR_SIMILAR") {
    aiTutorSimilarLatency.add(latency);
  }

  const success = check(res, {
    "AI 메시지 전송 성공": (r) => r.status === 200,
    "AI 응답 수신": (r) => {
      if (r.status === 200) {
        try {
          const body = JSON.parse(r.body);
          return body.data !== null;
        } catch (e) {
          return false;
        }
      }
      return false;
    },
  });

  if (success) {
    aiResponseSuccess.add(1);
    aiSuccessRate.add(1);
    aiTimeoutRate.add(0);
    aiErrorRate.add(0);
  } else {
    aiResponseFailed.add(1);
    aiSuccessRate.add(0);

    if (res.timed_out) {
      aiResponseTimeout.add(1);
      aiTimeoutRate.add(1);
      aiErrorRate.add(0);
      console.error(`AI 응답 타임아웃: ${latency}ms (roomId: ${roomId}, type: ${roomType})`);
    } else {
      aiTimeoutRate.add(0);
      aiErrorRate.add(1);
      console.error(`AI 응답 에러: ${res.status} (roomId: ${roomId}, type: ${roomType})`);
    }
  }

  return success;
}

/**
 * AI 메시지 조회
 */
function getAIMessages(token, roomId, cursor = null, size = 10) {
  let url = `${BASE_URL}/api/v1/chats/rooms/${roomId}/messages?chatRoomType=AI&size=${size}`;
  if (cursor !== null) {
    url += `&cursor=${cursor}`;
  }

  const res = http.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { endpoint: "getAIMessages" },
    timeout: "5s",
  });

  if (res.status === 200) {
    const body = JSON.parse(res.body);
    return body.data.messagePageResp || null;
  }
  return null;
}

/**
 * AI 피드백 분석
 */
function analyzeAIFeedback(token, messages, targetLanguage = "en") {
  const startTime = Date.now();

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

  const latency = Date.now() - startTime;
  aiFeedbackLatency.add(latency);

  const success = check(res, {
    "AI 피드백 분석 성공": (r) => r.status === 200,
  });

  if (success) {
    aiResponseSuccess.add(1);
  } else {
    aiResponseFailed.add(1);
    if (res.timed_out) {
      aiResponseTimeout.add(1);
    }
  }

  return success;
}

// ==================== AI 채팅 시나리오 ====================

/**
 * 시나리오 1: ROLE_PLAY AI 채팅 (자유 대화)
 */
function rolePlayScenario(user) {
  group("AI Role-Play - 역할극 학습", () => {
    const token = login(user.email, user.password);
    if (!token) return;

    activeAIUsers.add(1);

    // AI 채팅방 조회 또는 생성
    let aiRooms = getAIRoomList(token);
    let rolePlayRoom = aiRooms.find((r) => r.roomType === "ROLE_PLAY");

    if (!rolePlayRoom) {
      const personaId = randomItem(AI_PERSONAS);
      rolePlayRoom = createAIRoom(
        token,
        `Role-Play ${user.nickname}`,
        personaId,
        "ROLE_PLAY"
      );
    }

    if (!rolePlayRoom) {
      activeAIUsers.add(-1);
      return;
    }

    // AI와 대화 (3-7회)
    const conversations = randomIntBetween(3, 7);
    for (let i = 0; i < conversations; i++) {
      const question = randomItem(AI_QUESTIONS.ROLE_PLAY);
      const success = sendAIMessage(token, rolePlayRoom.id, question, "ROLE_PLAY");

      if (success) {
        // AI 응답 확인
        sleep(randomIntBetween(2, 5));
        getAIMessages(token, rolePlayRoom.id);
      } else {
        // 실패 시 대기 후 재시도
        sleep(2);
      }

      sleep(randomIntBetween(3, 8));
    }

    activeAIUsers.add(-1);
  });
}

/**
 * 시나리오 2: TUTOR_PERSONAL AI 채팅 (SQL 튜터)
 */
function tutorPersonalScenario(user) {
  group("AI Tutor Personal - SQL 학습", () => {
    const token = login(user.email, user.password);
    if (!token) return;

    activeAIUsers.add(1);

    let aiRooms = getAIRoomList(token);
    let tutorRoom = aiRooms.find((r) => r.roomType === "TUTOR_PERSONAL");

    if (!tutorRoom) {
      const personaId = randomItem(AI_PERSONAS);
      tutorRoom = createAIRoom(
        token,
        `SQL Tutor ${user.nickname}`,
        personaId,
        "TUTOR_PERSONAL"
      );
    }

    if (!tutorRoom) {
      activeAIUsers.add(-1);
      return;
    }

    // SQL 관련 질문 (5-10회)
    const questions = randomIntBetween(5, 10);
    for (let i = 0; i < questions; i++) {
      const question = randomItem(AI_QUESTIONS.TUTOR_PERSONAL);
      const success = sendAIMessage(token, tutorRoom.id, question, "TUTOR_PERSONAL");

      if (success) {
        sleep(randomIntBetween(3, 8));
        getAIMessages(token, tutorRoom.id);
      } else {
        sleep(2);
      }

      sleep(randomIntBetween(5, 12));
    }

    activeAIUsers.add(-1);
  });
}

/**
 * 시나리오 3: TUTOR_SIMILAR AI 채팅 (유사도 기반)
 */
function tutorSimilarScenario(user) {
  group("AI Tutor Similar - 유사도 학습", () => {
    const token = login(user.email, user.password);
    if (!token) return;

    activeAIUsers.add(1);

    let aiRooms = getAIRoomList(token);
    let tutorRoom = aiRooms.find((r) => r.roomType === "TUTOR_SIMILAR");

    if (!tutorRoom) {
      const personaId = randomItem(AI_PERSONAS);
      tutorRoom = createAIRoom(
        token,
        `Similar Tutor ${user.nickname}`,
        personaId,
        "TUTOR_SIMILAR"
      );
    }

    if (!tutorRoom) {
      activeAIUsers.add(-1);
      return;
    }

    // 프로그래밍 관련 질문 (3-6회)
    const questions = randomIntBetween(3, 6);
    for (let i = 0; i < questions; i++) {
      const question = randomItem(AI_QUESTIONS.TUTOR_SIMILAR);
      const success = sendAIMessage(token, tutorRoom.id, question, "TUTOR_SIMILAR");

      if (success) {
        sleep(randomIntBetween(3, 8));
        getAIMessages(token, tutorRoom.id);
      } else {
        sleep(2);
      }

      sleep(randomIntBetween(5, 12));
    }

    activeAIUsers.add(-1);
  });
}

/**
 * 시나리오 4: AI 피드백 집중 테스트
 */
function feedbackScenario(user) {
  group("AI Feedback - 피드백 분석", () => {
    const token = login(user.email, user.password);
    if (!token) return;

    activeAIUsers.add(1);

    // 다양한 대화 시나리오로 피드백 분석
    const feedbackTests = [
      {
        messages: [
          { role: "user", content: "I goes to school yesterday" },
          { role: "assistant", content: "I went to school yesterday" },
        ],
      },
      {
        messages: [
          { role: "user", content: "She don't like coffee" },
          { role: "assistant", content: "She doesn't like coffee" },
        ],
      },
      {
        messages: [
          { role: "user", content: "We was happy" },
          { role: "assistant", content: "We were happy" },
        ],
      },
    ];

    for (const test of feedbackTests) {
      analyzeAIFeedback(token, test.messages, "en");
      sleep(randomIntBetween(5, 10));
    }

    activeAIUsers.add(-1);
  });
}

/**
 * 시나리오 5: 혼합 AI 사용 (모든 유형)
 */
function mixedAIScenario(user) {
  group("AI Mixed - 혼합 사용", () => {
    const token = login(user.email, user.password);
    if (!token) return;

    activeAIUsers.add(1);

    // 랜덤하게 3가지 유형 모두 사용
    const roomTypes = [...AI_CHAT_ROOM_TYPES];
    const iterations = randomIntBetween(2, 4);

    for (let i = 0; i < iterations; i++) {
      const roomType = randomItem(roomTypes);
      let aiRooms = getAIRoomList(token);
      let room = aiRooms.find((r) => r.roomType === roomType);

      if (!room) {
        const personaId = randomItem(AI_PERSONAS);
        room = createAIRoom(
          token,
          `Mixed ${roomType} ${user.nickname}`,
          personaId,
          roomType
        );
      }

      if (room) {
        const questions = AI_QUESTIONS[roomType];
        const question = randomItem(questions);
        sendAIMessage(token, room.id, question, roomType);
        sleep(randomIntBetween(5, 12));
      }
    }

    activeAIUsers.add(-1);
  });
}

// ==================== Setup & Teardown ====================

export function setup() {
  console.log("========================================");
  console.log("AI 채팅 집중 스트레스 테스트 시작");
  console.log("========================================");
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Test Duration: ${TEST_DURATION}`);
  console.log(`AI Timeout: ${AI_TIMEOUT}ms`);
  console.log(`Load Profile: ${LOAD_PROFILES[TEST_DURATION].length} stages`);
  console.log("========================================");
  console.log("⚠️  Ollama 서버 모니터링 필수!");
  console.log("   - htop 또는 top으로 CPU 사용률 확인");
  console.log("   - nvidia-smi로 GPU 사용률 확인 (있는 경우)");
  console.log("   - 메모리 사용량 확인");
  console.log("========================================");

  return { startTime: new Date() };
}

export default function () {
  const userIndex = (__VU - 1) % users.length;
  const user = users[userIndex];

  // 시나리오 분포
  const scenarioType = randomIntBetween(0, 99);

  if (scenarioType < 30) {
    // 30%: Role-Play
    rolePlayScenario(user);
  } else if (scenarioType < 55) {
    // 25%: Tutor Personal
    tutorPersonalScenario(user);
  } else if (scenarioType < 75) {
    // 20%: Tutor Similar
    tutorSimilarScenario(user);
  } else if (scenarioType < 90) {
    // 15%: Feedback
    feedbackScenario(user);
  } else {
    // 10%: Mixed
    mixedAIScenario(user);
  }

  sleep(randomIntBetween(2, 5));
}

export function teardown(data) {
  const duration = (new Date() - data.startTime) / 1000 / 60;
  console.log("========================================");
  console.log("AI 채팅 집중 스트레스 테스트 완료");
  console.log(`총 테스트 시간: ${duration.toFixed(2)}분`);
  console.log("========================================");
  console.log("AI 메트릭 요약:");
  console.log(`- AI 채팅방 생성: ${aiRoomCreated || 0}개`);
  console.log(`- AI 메시지 총: ${aiMessagesTotal || 0}개`);
  console.log(`- AI 응답 성공: ${aiResponseSuccess || 0}개`);
  console.log(`- AI 응답 실패: ${aiResponseFailed || 0}개`);
  console.log(`- AI 응답 타임아웃: ${aiResponseTimeout || 0}개`);
  console.log("========================================");
  console.log("⚠️  성능 분석:");
  console.log("   1. Grafana에서 응답 시간 분포 확인");
  console.log("   2. Ollama 로그에서 에러 확인");
  console.log("   3. 타임아웃 발생 시점의 동시 사용자 수 확인");
  console.log("========================================");
}
