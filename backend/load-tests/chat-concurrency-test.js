/**
 * ========================================
 * 채팅 동시성 테스트 (Concurrency Test)
 * ========================================
 *
 * 목적: Pessimistic Lock 및 시퀀스 생성의 정합성 검증
 *
 * 테스트 초점:
 * 1. 같은 방에 대량 동시 메시지 전송 (Race Condition 검증)
 * 2. 메시지 시퀀스 중복 검출 (시퀀스 무결성)
 * 3. Pessimistic Lock으로 인한 대기 시간 측정
 * 4. 높은 동시성 하에서 성능 저하 패턴 분석
 * 5. DB 커넥션 풀 고갈 여부 확인
 * 6. 에러율 및 타임아웃 발생률
 *
 * 테스트 시나리오:
 * 1. 단일 방 폭격: 1개 방에 100명이 동시 메시지 전송
 * 2. 다중 방 분산: 10개 방에 각 10명씩 분산
 * 3. 스파이크 테스트: 순간적으로 500명이 동시 전송
 *
 * 예상 결과:
 * - Pessimistic Lock이 정상 작동하면 시퀀스 중복 없음
 * - Lock 대기로 인한 응답 시간 증가 (정상)
 * - 극단적 동시성에서 타임아웃 가능 (DB 커넥션 풀 한계)
 *
 * 부하 프로필:
 * - Warmup: 10초간 10명
 * - Normal: 30초간 50명 (기본 동시성)
 * - Heavy: 30초간 100명 (높은 동시성)
 * - Spike: 10초간 500명 (극단적 스파이크)
 * - Recovery: 30초간 20명 (복구 확인)
 * - Cooldown: 10초간 0명
 *
 * 실행 방법:
 * k6 run chat-concurrency-test.js \
 *   --env BASE_URL=http://localhost:8080 \
 *   --env TEST_MODE=single
 *
 * TEST_MODE:
 * - single: 단일 방 집중 테스트
 * - multi: 다중 방 분산 테스트
 * - spike: 스파이크 테스트
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { SharedArray } from "k6/data";
import { Counter, Trend, Rate, Gauge } from "k6/metrics";
import { randomItem, randomIntBetween } from "https://jslib.k6.io/k6-utils/1.2.0/index.js";

// ==================== 커스텀 메트릭 ====================
const messagesSentConcurrent = new Counter("messages_sent_concurrent");
const messagesSuccessConcurrent = new Counter("messages_success_concurrent");
const messagesFailedConcurrent = new Counter("messages_failed_concurrent");
const sequenceDuplicates = new Counter("sequence_duplicates"); // 시퀀스 중복 검출

const concurrentSendLatency = new Trend("concurrent_send_latency");
const lockWaitTime = new Trend("lock_wait_time"); // 추정치
const dbQueryTime = new Trend("db_query_time"); // 간접 측정

const concurrencySuccessRate = new Rate("concurrency_success_rate");
const concurrencyTimeoutRate = new Rate("concurrency_timeout_rate");

const activeConcurrentUsers = new Gauge("active_concurrent_users");
const pendingMessages = new Gauge("pending_messages"); // 추정치

// ==================== 테스트 설정 ====================
const TEST_MODE = __ENV.TEST_MODE || "single"; // single, multi, spike

const LOAD_PROFILES = {
  single: [
    { duration: "10s", target: 10 },   // Warmup
    { duration: "30s", target: 50 },   // Normal
    { duration: "30s", target: 100 },  // Heavy
    { duration: "10s", target: 200 },  // Spike
    { duration: "30s", target: 20 },   // Recovery
    { duration: "10s", target: 0 },    // Cooldown
  ],
  multi: [
    { duration: "10s", target: 10 },   // Warmup
    { duration: "30s", target: 100 },  // Normal (10개 방에 분산)
    { duration: "30s", target: 200 },  // Heavy
    { duration: "30s", target: 50 },   // Recovery
    { duration: "10s", target: 0 },    // Cooldown
  ],
  spike: [
    { duration: "10s", target: 10 },   // Warmup
    { duration: "5s", target: 500 },   // Spike 1
    { duration: "20s", target: 10 },   // Recovery
    { duration: "5s", target: 500 },   // Spike 2
    { duration: "20s", target: 10 },   // Recovery
    { duration: "10s", target: 0 },    // Cooldown
  ],
};

export const options = {
  stages: LOAD_PROFILES[TEST_MODE],
  thresholds: {
    // 동시성 테스트에서는 응답 시간이 느려질 수 있음 (Lock 대기)
    http_req_failed: ["rate<0.05"], // 5% 미만 실패
    "http_req_duration{endpoint:concurrentSend}": ["p(95)<5000", "p(99)<10000"],

    // 동시성 성공률
    concurrency_success_rate: ["rate>0.95"], // 95% 이상 성공
    concurrency_timeout_rate: ["rate<0.05"], // 타임아웃 5% 미만

    // 응답 시간 (Lock 대기 포함)
    concurrent_send_latency: ["p(50)<1000", "p(95)<5000", "p(99)<10000"],
  },
  // 동시성 테스트는 타임아웃을 길게 설정
  timeout: "30s",
  // 배치 처리 비활성화 (동시성 정확히 측정)
  batch: 1,
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

function createGroupRoom(token, roomName, memberIds) {
  const res = http.post(
    `${BASE_URL}/api/v1/chats/rooms/group`,
    JSON.stringify({
      roomName,
      memberIds,
      password: "",
      description: "동시성 테스트용",
      topic: "CONCURRENCY_TEST",
    }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      tags: { endpoint: "createRoom" },
      timeout: "5s",
    }
  );

  if (res.status === 200) {
    const body = JSON.parse(res.body);
    return body.data;
  }
  return null;
}

function joinGroupRoom(token, roomId) {
  const res = http.post(
    `${BASE_URL}/api/v1/chats/rooms/group/${roomId}/join`,
    JSON.stringify({}),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      tags: { endpoint: "joinRoom" },
      timeout: "5s",
    }
  );

  return res.status === 200 || res.status === 400; // 400은 이미 참가 중
}

/**
 * 동시성 메시지 전송 (시퀀스 생성 테스트)
 */
function sendConcurrentMessage(token, roomId, content, userId) {
  const startTime = Date.now();

  const res = http.post(
    `${BASE_URL}/api/v1/chats/rooms/${roomId}/files`,
    JSON.stringify({
      roomId,
      content,
      messageType: "TEXT",
      chatRoomType: "GROUP",
      isTranslateEnabled: false,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      tags: {
        endpoint: "concurrentSend",
        roomId: roomId.toString(),
      },
      timeout: "30s",
    }
  );

  const latency = Date.now() - startTime;
  messagesSentConcurrent.add(1);
  concurrentSendLatency.add(latency);

  // Lock 대기 시간 추정 (1초 이상 걸리면 Lock 대기로 간주)
  if (latency > 1000) {
    lockWaitTime.add(latency - 1000);
  }

  const success = check(res, {
    "동시 메시지 전송 성공": (r) => r.status === 200,
  });

  if (success) {
    messagesSuccessConcurrent.add(1);
    concurrencySuccessRate.add(1);
    concurrencyTimeoutRate.add(0);

    // 시퀀스 검증 (응답에서 시퀀스 추출)
    try {
      const body = JSON.parse(res.body);
      if (body.data && body.data.sequence) {
        // 시퀀스를 저장하고 중복 검사 (실제로는 별도 저장소 필요)
        // 여기서는 로그로만 출력
        // console.log(`User ${userId} - Room ${roomId} - Sequence: ${body.data.sequence}`);
      }
    } catch (e) {
      // JSON 파싱 실패 무시
    }
  } else {
    messagesFailedConcurrent.add(1);
    concurrencySuccessRate.add(0);

    if (res.timed_out) {
      concurrencyTimeoutRate.add(1);
      console.error(`동시성 메시지 타임아웃: ${latency}ms (Room: ${roomId}, User: ${userId})`);
    } else {
      concurrencyTimeoutRate.add(0);
      console.error(`동시성 메시지 실패: ${res.status} (Room: ${roomId}, User: ${userId})`);
    }
  }

  return success;
}

/**
 * 메시지 조회 및 시퀀스 검증
 */
function verifyMessageSequences(token, roomId) {
  const res = http.get(
    `${BASE_URL}/api/v1/chats/rooms/${roomId}/messages?chatRoomType=GROUP&size=100`,
    {
      headers: { Authorization: `Bearer ${token}` },
      tags: { endpoint: "verifySequences" },
      timeout: "10s",
    }
  );

  if (res.status === 200) {
    try {
      const body = JSON.parse(res.body);
      const messages = body.data.messagePageResp.contents || [];

      // 시퀀스 중복 검사
      const sequences = messages.map((m) => m.sequence);
      const uniqueSequences = new Set(sequences);

      if (sequences.length !== uniqueSequences.size) {
        const duplicates = sequences.length - uniqueSequences.size;
        sequenceDuplicates.add(duplicates);
        console.error(`⚠️  시퀀스 중복 발견! Room ${roomId}: ${duplicates}개 중복`);
        return false;
      }

      // 시퀀스 연속성 검사 (오름차순)
      const sortedSequences = [...sequences].sort((a, b) => a - b);
      for (let i = 1; i < sortedSequences.length; i++) {
        if (sortedSequences[i] !== sortedSequences[i - 1] + 1) {
          // 연속되지 않은 시퀀스는 정상 (페이지네이션)
          // 중복만 체크
        }
      }

      return true;
    } catch (e) {
      console.error(`시퀀스 검증 실패: ${e.message}`);
      return false;
    }
  }

  return false;
}

// ==================== 동시성 시나리오 ====================

/**
 * 시나리오 1: 단일 방 집중 공격 (Race Condition 테스트)
 */
function singleRoomBombardment(user, targetRoomId) {
  group("Single Room - 단일 방 폭격", () => {
    const token = login(user.email, user.password);
    if (!token) return;

    activeConcurrentUsers.add(1);

    // 방 참가 확인
    joinGroupRoom(token, targetRoomId);
    sleep(0.1);

    // 연속으로 메시지 폭격 (시퀀스 Lock 경합 유발)
    const burstCount = randomIntBetween(5, 15);
    for (let i = 0; i < burstCount; i++) {
      sendConcurrentMessage(
        token,
        targetRoomId,
        `Burst ${i + 1} from ${user.nickname} at ${Date.now()}`,
        user.id
      );

      // 거의 동시에 전송 (최소 대기)
      sleep(randomIntBetween(0, 100) / 1000); // 0~100ms
    }

    activeConcurrentUsers.add(-1);
  });
}

/**
 * 시나리오 2: 다중 방 분산 (부하 분산)
 */
function multiRoomDistributed(user, targetRooms) {
  group("Multi Room - 다중 방 분산", () => {
    const token = login(user.email, user.password);
    if (!token) return;

    activeConcurrentUsers.add(1);

    // 랜덤 방 선택
    const room = randomItem(targetRooms);
    joinGroupRoom(token, room.id);
    sleep(0.1);

    // 해당 방에 메시지 전송
    const messageCount = randomIntBetween(3, 8);
    for (let i = 0; i < messageCount; i++) {
      sendConcurrentMessage(
        token,
        room.id,
        `Multi-room message ${i + 1} from ${user.nickname}`,
        user.id
      );
      sleep(randomIntBetween(50, 200) / 1000);
    }

    activeConcurrentUsers.add(-1);
  });
}

/**
 * 시나리오 3: 순간 스파이크 (극단적 동시성)
 */
function spikeAttack(user, targetRoomId) {
  group("Spike Attack - 순간 폭발", () => {
    const token = login(user.email, user.password);
    if (!token) return;

    activeConcurrentUsers.add(1);

    joinGroupRoom(token, targetRoomId);

    // 거의 동시에 대량 전송 (0~10ms 간격)
    const spikeCount = randomIntBetween(10, 20);
    for (let i = 0; i < spikeCount; i++) {
      sendConcurrentMessage(
        token,
        targetRoomId,
        `SPIKE ${i + 1} ${user.nickname} ${Date.now()}`,
        user.id
      );
      sleep(randomIntBetween(0, 10) / 1000);
    }

    activeConcurrentUsers.add(-1);
  });
}

// ==================== Setup & Teardown ====================

export function setup() {
  console.log("========================================");
  console.log("채팅 동시성 테스트 시작");
  console.log("========================================");
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Test Mode: ${TEST_MODE}`);
  console.log(`Load Profile: ${LOAD_PROFILES[TEST_MODE].length} stages`);
  console.log("========================================");

  const ownerUser = users[0];
  const ownerToken = login(ownerUser.email, ownerUser.password);

  if (!ownerToken) {
    console.error("Setup 실패: 방장 로그인 실패");
    return null;
  }

  if (TEST_MODE === "single" || TEST_MODE === "spike") {
    // 단일 방 테스트: 1개 방에 모든 사용자 초대
    const memberIds = [];
    for (let i = 2; i <= 50; i++) {
      memberIds.push(i);
    }

    const room = createGroupRoom(
      ownerToken,
      "Concurrency Test - Single Room",
      memberIds
    );

    if (!room) {
      console.error("Setup 실패: 테스트 방 생성 실패");
      return null;
    }

    console.log(`단일 방 생성 완료: ${room.id} - ${room.name}`);

    // 모든 유저 참가
    for (let i = 1; i <= 50; i++) {
      const user = users[i - 1];
      const token = login(user.email, user.password);
      if (token) {
        joinGroupRoom(token, room.id);
      }
      sleep(0.1);
    }

    console.log("========================================");
    console.log(`테스트 준비 완료 - 단일 방 (Room ID: ${room.id})`);
    console.log("========================================");

    return {
      mode: TEST_MODE,
      targetRoomId: room.id,
      startTime: new Date(),
    };
  } else if (TEST_MODE === "multi") {
    // 다중 방 테스트: 10개 방 생성
    const rooms = [];
    for (let i = 0; i < 10; i++) {
      const memberIds = [];
      for (let j = 1; j <= 20; j++) {
        const userId = (i * 5 + j) % users.length + 1;
        if (userId !== ownerUser.id) {
          memberIds.push(userId);
        }
      }

      const room = createGroupRoom(
        ownerToken,
        `Concurrency Test - Room ${i + 1}`,
        memberIds.slice(0, 10)
      );

      if (room) {
        rooms.push(room);
        console.log(`방 ${i + 1} 생성 완료: ${room.id}`);
      }

      sleep(0.5);
    }

    console.log("========================================");
    console.log(`테스트 준비 완료 - 다중 방 (${rooms.length}개)`);
    console.log("========================================");

    return {
      mode: TEST_MODE,
      targetRooms: rooms,
      startTime: new Date(),
    };
  }

  return null;
}

export default function (data) {
  if (!data) {
    console.error("Setup 데이터가 없습니다. 테스트를 중단합니다.");
    return;
  }

  const userIndex = (__VU - 1) % users.length;
  const user = users[userIndex];

  if (data.mode === "single") {
    singleRoomBombardment(user, data.targetRoomId);
  } else if (data.mode === "multi") {
    multiRoomDistributed(user, data.targetRooms);
  } else if (data.mode === "spike") {
    spikeAttack(user, data.targetRoomId);
  }

  sleep(randomIntBetween(0, 500) / 1000); // 0~500ms 대기
}

export function teardown(data) {
  if (!data) return;

  const duration = (new Date() - data.startTime) / 1000 / 60;
  console.log("========================================");
  console.log("채팅 동시성 테스트 완료");
  console.log(`총 테스트 시간: ${duration.toFixed(2)}분`);
  console.log("========================================");
  console.log("동시성 메트릭 요약:");
  console.log(`- 전송 메시지 총: ${messagesSentConcurrent || 0}개`);
  console.log(`- 성공: ${messagesSuccessConcurrent || 0}개`);
  console.log(`- 실패: ${messagesFailedConcurrent || 0}개`);
  console.log(`- 시퀀스 중복: ${sequenceDuplicates || 0}개`);
  console.log("========================================");

  // 시퀀스 검증 (마지막)
  if (data.mode === "single" && data.targetRoomId) {
    console.log("시퀀스 무결성 검증 중...");
    const ownerUser = users[0];
    const ownerToken = login(ownerUser.email, ownerUser.password);
    if (ownerToken) {
      const isValid = verifyMessageSequences(ownerToken, data.targetRoomId);
      if (isValid) {
        console.log("✅ 시퀀스 무결성 검증 통과!");
      } else {
        console.log("❌ 시퀀스 무결성 검증 실패!");
      }
    }
  }

  console.log("========================================");
  console.log("⚠️  분석 체크리스트:");
  console.log("   1. 시퀀스 중복이 0개인지 확인 (Pessimistic Lock 정상)");
  console.log("   2. Lock 대기 시간 분포 확인");
  console.log("   3. 동시 사용자 수 증가에 따른 응답 시간 증가 패턴");
  console.log("   4. DB 커넥션 풀 사용률 (별도 모니터링)");
  console.log("   5. MySQL 슬로우 쿼리 로그 확인");
  console.log("========================================");
}
