// =============================================
// MixChat - 그룹 채팅 메시지 조회 부하 테스트 (5분 버전)
//
// 목적:
//  - 특정 그룹 채팅방의 메시지 조회 API(getMessages) 성능 검증
//  - N+1, 인덱스 문제 여부 확인
//  - 200 VU 기준 p95 응답 시간 확인
//
// 테스트 스펙:
//  - 총 duration: 약 5분
//  - VU 단계:
//      30초 → 50명
//      1분  → 50명 유지
//      30초 → 100명
//      1분  → 100명 유지
//      30초 → 200명
//      1분  → 200명 유지
//      30초 → 0명 (정리 구간)
//  - 대상 API:
//      - POST /api/v1/auth/login
//      - GET  /api/v1/chats/rooms/{roomId}/messages
//
// 전제 조건:
//  - test1@test.com ~ test5@test.com 계정이 DB에 존재
//  - setup()에서 LoadTestRoom 방 자동 생성 + 유저 1~5 참가 + 메시지 100개 삽입
//
// 주요 지표:
//  - http_req_duration p95 < 1000ms
//  - getMessages p95 < 800ms
//  - 오류율(http_req_failed) < 1%
// =============================================

import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import { Counter, Trend } from "k6/metrics";

// 커스텀 메트릭 정의
const messagesReceived = new Counter("messages_received");
const messageLatency = new Trend("message_latency");
const roomListLatency = new Trend("room_list_latency");

// 빠른 테스트 설정 (5분 버전)
export const options = {
  stages: [
    { duration: "30s", target: 50 }, // 30초간 50명까지
    { duration: "1m", target: 50 }, // 1분간 50명 유지
    { duration: "30s", target: 100 }, // 30초간 100명까지
    { duration: "1m", target: 100 }, // 1분간 100명 유지
    { duration: "30s", target: 200 }, // 30초간 200명까지
    { duration: "1m", target: 200 }, // 1분간 200명 유지
    { duration: "30s", target: 0 }, // 30초간 종료
  ],
  thresholds: {
    http_req_duration: ["p(95)<1000"],
    http_req_failed: ["rate<0.01"],
    "http_req_duration{endpoint:getMessages}": ["p(95)<800"],
    "http_req_duration{endpoint:getRoomList}": ["p(95)<500"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";

const users = new SharedArray("test users", function () {
  return [
    { email: "test1@test.com", password: "test1234", id: 1 },
    { email: "test2@test.com", password: "test1234", id: 2 },
    { email: "test3@test.com", password: "test1234", id: 3 },
    { email: "test4@test.com", password: "test1234", id: 4 },
    { email: "test5@test.com", password: "test1234", id: 5 },
  ];
});

function login(email, password) {
  const loginRes = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({
      email: email,
      password: password,
    }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );

  check(loginRes, {
    "login status 200": (r) => r.status === 200,
  });

  if (loginRes.status === 200) {
    const body = JSON.parse(loginRes.body);
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
  check(res, { "group room list status 200": (r) => r.status === 200 });

  if (res.status === 200) {
    const body = JSON.parse(res.body);
    return body.data || [];
  }
  return [];
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

  messageLatency.add(new Date() - startTime);
  check(res, { "get messages status 200": (r) => r.status === 200 });

  if (res.status === 200) {
    messagesReceived.add(1);
    const body = JSON.parse(res.body);
    return body.data.messagePageResp || null;
  }
  return null;
}

function getPublicGroupRooms(token) {
  const res = http.get(`${BASE_URL}/api/v1/chats/rooms/group/public`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 200) {
    const body = JSON.parse(res.body);
    return body.data || [];
  }
  return [];
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
    }
  );

  check(res, {
    "join group room success": (r) => r.status === 200 || r.status === 400,
  });

  // 200: 성공, 400: 이미 참여 중 (둘 다 OK)
  return res.status === 200 || res.status === 400;
}

export default function (data) {
  const roomId = data.testRoomId;

  const userIndex = (__VU - 1) % users.length;
  const user = users[userIndex];
  const token = login(user.email, user.password);
  if (!token) return;

  // 메시지 조회 (핵심 테스트)
  getMessages(token, roomId, "GROUP", null, 25);

  sleep(1);
}

export function setup() {
  console.log("=== Setup: 테스트 환경 준비 ===");

  // 1) 방장(owner) 역할로 user1 사용
  const ownerUser = users[0];
  const ownerToken = login(ownerUser.email, ownerUser.password);

  // 2) 테스트용 그룹 채팅방 생성
  const createRoomReq = {
    roomName: "LoadTestRoom",
    memberIds: [2, 3, 4, 5], // 방장은 user1이므로 제외
    password: "",
    description: "부하 테스트 전용 방",
    topic: "LOAD_TEST",
  };

  const roomRes = http.post(
    `${BASE_URL}/api/v1/chats/rooms/group`,
    JSON.stringify(createRoomReq),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
    }
  );

  console.log("방 생성 응답:", roomRes.body);

  const body = JSON.parse(roomRes.body);

  // 생성 실패 시 테스트 중단
  if (!body.data || !body.data.id) {
    throw new Error("방 생성 실패: " + roomRes.body);
  }

  const roomId = body.data.id;
  console.log(`테스트용 방 생성 성공 → roomId = ${roomId}`);

  // 3) 유저 1~5 모두 방에 참가 처리
  users.forEach((u) => {
    const token = login(u.email, u.password);

    http.post(
      `${BASE_URL}/api/v1/chats/rooms/group/${roomId}/join`,
      JSON.stringify({}),
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );

    console.log(`유저 ${u.id} 참가 완료`);
  });

  // 4) 메시지 100개 삽입 (owner 계정으로 수행)
  for (let i = 1; i <= 100; i++) {
    http.post(
      `${BASE_URL}/api/v1/chats/rooms/${roomId}/messages`,
      JSON.stringify({ content: `load test message ${i}` }),
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ownerToken}`,
        },
      }
    );
  }

  console.log("메시지 100개 삽입 완료");

  // default()에 전달할 데이터
  return { testRoomId: roomId };
}

export function teardown(data) {
  const duration = (new Date() - data.startTime) / 1000 / 60;
  console.log(`총 테스트 시간: ${duration.toFixed(2)}분`);
}