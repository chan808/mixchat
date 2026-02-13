import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';

// 커스텀 메트릭 정의
const messagesReceived = new Counter('messages_received');
const messageLatency = new Trend('message_latency');
const roomListLatency = new Trend('room_list_latency');

// 테스트 설정
export const options = {
  stages: [
    { duration: '1m', target: 50 },   // 1분간 50명까지 증가
    { duration: '3m', target: 50 },   // 3분간 50명 유지
    { duration: '1m', target: 100 },  // 1분간 100명까지 증가
    { duration: '3m', target: 100 },  // 3분간 100명 유지
    { duration: '1m', target: 200 },  // 1분간 200명까지 증가
    { duration: '3m', target: 200 },  // 3분간 200명 유지 (스트레스)
    { duration: '2m', target: 0 },    // 2분간 종료
  ],
  thresholds: {
    http_req_duration: ['p(95)<1000'], // 95%가 1초 이하
    http_req_failed: ['rate<0.01'],    // 실패율 1% 이하
    'http_req_duration{endpoint:getMessages}': ['p(95)<800'],
    'http_req_duration{endpoint:getRoomList}': ['p(95)<500'],
  },
};

// 환경 변수 설정
const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

// 테스트용 사용자 정보
const users = new SharedArray('test users', function () {
  // test-data/users.json 파일에서 로드하거나 여기서 직접 정의
  return [
    { email: 'test1@test.com', password: 'test1234', id: 1 },
    { email: 'test2@test.com', password: 'test1234', id: 2 },
    { email: 'test3@test.com', password: 'test1234', id: 3 },
    { email: 'test4@test.com', password: 'test1234', id: 4 },
    { email: 'test5@test.com', password: 'test1234', id: 5 },
  ];
});

// 로그인 및 토큰 획득
function login(email, password) {
  const loginRes = http.post(`${BASE_URL}/api/v1/auth/login`, JSON.stringify({
    email: email,
    password: password,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });

  check(loginRes, {
    'login status 200': (r) => r.status === 200,
    'login has token': (r) => {
      if (r.status !== 200) return false;
      const body = JSON.parse(r.body);
      return body.data && typeof body.data === 'string';
    }
  });

  if (loginRes.status === 200) {
    const body = JSON.parse(loginRes.body);
    // NOTE: 현재 프로젝트는 토큰을 문자열로 직접 반환
    // 일반적인 REST API 규격: { data: { accessToken: "...", refreshToken: "..." } }
    // 현재 구조: { msg: "...", data: "토큰 문자열" }
    // 이유: 프로젝트 초기 설계 결정으로 추정 (간소화된 응답 구조)
    return body.data; // 토큰이 문자열로 직접 반환됨
  }
  return null;
}

// 1:1 채팅방 생성 또는 조회
function createOrGetDirectRoom(token, partnerId) {
  const res = http.post(`${BASE_URL}/api/v1/chats/rooms/direct`, JSON.stringify({
    partnerId: partnerId,
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  });

  check(res, {
    'direct room creation status 200': (r) => r.status === 200,
  });

  if (res.status === 200) {
    const body = JSON.parse(res.body);
    return body.data.roomId;
  }
  return null;
}

// 그룹 채팅방 목록 조회
function getGroupRoomList(token) {
  const startTime = new Date();
  const res = http.get(`${BASE_URL}/api/v1/chats/rooms/group`, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
    tags: { endpoint: 'getRoomList' },
  });

  const duration = new Date() - startTime;
  roomListLatency.add(duration);

  check(res, {
    'group room list status 200': (r) => r.status === 200,
  });

  if (res.status === 200) {
    const body = JSON.parse(res.body);
    return body.data || [];
  }
  return [];
}

// 메시지 조회 (페이징) - N+1 문제 측정 포인트
function getMessages(token, roomId, chatRoomType, cursor = null, size = 25) {
  const startTime = new Date();
  let url = `${BASE_URL}/api/v1/chats/rooms/${roomId}/messages?chatRoomType=${chatRoomType}&size=${size}`;
  if (cursor !== null) {
    url += `&cursor=${cursor}`;
  }

  const res = http.get(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
    tags: { endpoint: 'getMessages' },
  });

  const duration = new Date() - startTime;
  messageLatency.add(duration);

  check(res, {
    'get messages status 200': (r) => r.status === 200,
    'get messages response time < 800ms': (r) => r.timings.duration < 800,
  });

  if (res.status === 200) {
    messagesReceived.add(1);
    const body = JSON.parse(res.body);
    return body.data.messagePageResp || null;
  }
  return null;
}

// 공개 그룹 채팅방 조회
function getPublicGroupRooms(token) {
  const res = http.get(`${BASE_URL}/api/v1/chats/rooms/group/public`, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  check(res, {
    'public rooms status 200': (r) => r.status === 200,
  });

  if (res.status === 200) {
    const body = JSON.parse(res.body);
    return body.data || [];
  }
  return [];
}

// 그룹 채팅방 참가
function joinGroupRoom(token, roomId, password = null) {
  const payload = password ? { password: password } : {};
  const res = http.post(`${BASE_URL}/api/v1/chats/rooms/group/${roomId}/join`,
    JSON.stringify(payload),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    }
  );

  check(res, {
    'join group room status 200 or 400': (r) => r.status === 200 || r.status === 400,
  });

  return res.status === 200;
}

// 메인 테스트 시나리오
export default function () {
  // 1. 로그인
  const userIndex = (__VU - 1) % users.length;
  const user = users[userIndex];
  const token = login(user.email, user.password);

  if (!token) {
    console.error(`Login failed for user: ${user.email}`);
    return;
  }

  sleep(1);

  // 2. 그룹 채팅방 목록 조회 (N+1 문제 발생 가능 지점)
  const groupRooms = getGroupRoomList(token);
  sleep(0.5);

  // 3. 공개 그룹 채팅방 조회
  const publicRooms = getPublicGroupRooms(token);
  sleep(0.5);

  // 비밀번호 없는 방만 필터링
  const roomsWithoutPassword = publicRooms.filter(room => !room.hasPassword);

  // 4. 첫 번째 공개 그룹방에 참가 (있다면)
  if (roomsWithoutPassword.length > 0) {
    const randomRoom = roomsWithoutPassword[Math.floor(Math.random() * roomsWithoutPassword.length)];
    // NOTE: API 응답에서 roomId가 아닌 id 필드명 사용
    const joined = joinGroupRoom(token, randomRoom.id);

    if (joined) {
      sleep(1);

      // 5. 참가한 방의 메시지 조회 (N+1 문제 핵심 측정 포인트)
      const messageData = getMessages(token, randomRoom.id, 'GROUP', null, 25);
      sleep(1);

      // 6. 이전 메시지 페이징 조회 (커서 기반)
      if (messageData && messageData.nextCursor && messageData.hasMore) {
        getMessages(token, randomRoom.id, 'GROUP', messageData.nextCursor, 25);
      }
      sleep(1);
    }
  }

  // 7. 1:1 채팅방 생성/조회 (다른 사용자와)
  const partnerIndex = (userIndex + 1) % users.length;
  const partnerId = users[partnerIndex].id;
  const directRoomId = createOrGetDirectRoom(token, partnerId);

  if (directRoomId) {
    sleep(0.5);
    // 8. 1:1 채팅방 메시지 조회 (N+1 문제 측정)
    getMessages(token, directRoomId, 'DIRECT', null, 25);
  }

  sleep(2);
}

// 테스트 시작 시 실행
export function setup() {
  console.log('=== 채팅 도메인 REST API 부하 테스트 시작 ===');
  console.log(`대상 서버: ${BASE_URL}`);
  console.log(`테스트 사용자 수: ${users.length}`);
  console.log('');
  console.log('측정 목표:');
  console.log('- 메시지 조회 API의 N+1 문제 발생 여부');
  console.log('- 채팅방 목록 조회 성능');
  console.log('- 동시 접속자 수에 따른 응답 시간 변화');
  console.log('');
  return { startTime: new Date() };
}

// 테스트 종료 시 실행
export function teardown(data) {
  console.log('');
  console.log('=== 채팅 도메인 REST API 부하 테스트 종료 ===');
  const duration = (new Date() - data.startTime) / 1000;
  console.log(`총 테스트 시간: ${duration.toFixed(2)}초`);
}
