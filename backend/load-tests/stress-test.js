import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Trend, Rate } from 'k6/metrics';

// 커스텀 메트릭
const errorRate = new Rate('error_rate');
const requestDuration = new Trend('request_duration');
const concurrentUsers = new Counter('concurrent_users');

// 스트레스 테스트 설정 - 점진적 부하 증가로 임계점 찾기
export const options = {
  stages: [
    // Phase 1: 워밍업
    { duration: '2m', target: 50 },
    { duration: '2m', target: 50 },

    // Phase 2: 점진적 증가
    { duration: '2m', target: 100 },
    { duration: '2m', target: 100 },

    // Phase 3: 더 높은 부하
    { duration: '2m', target: 200 },
    { duration: '3m', target: 200 },

    // Phase 4: 스트레스 구간
    { duration: '2m', target: 300 },
    { duration: '3m', target: 300 },

    // Phase 5: 극한 스트레스
    { duration: '2m', target: 500 },
    { duration: '3m', target: 500 },

    // Phase 6: 스파이크 테스트
    { duration: '1m', target: 1000 },
    { duration: '2m', target: 1000 },

    // Phase 7: 복구 테스트
    { duration: '2m', target: 100 },
    { duration: '1m', target: 0 },
  ],
  thresholds: {
    // 임계점 파악을 위한 느슨한 임계값
    http_req_duration: ['p(95)<5000'], // 5초 이하
    http_req_failed: ['rate<0.10'],    // 실패율 10% 이하
    error_rate: ['rate<0.10'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

const users = new SharedArray('test users', function () {
  return [
    { email: 'test1@test.com', password: 'test1234', id: 1 },
    { email: 'test2@test.com', password: 'test1234', id: 2 },
    { email: 'test3@test.com', password: 'test1234', id: 3 },
    { email: 'test4@test.com', password: 'test1234', id: 4 },
    { email: 'test5@test.com', password: 'test1234', id: 5 },
  ];
});

function login(email, password) {
  const startTime = new Date();
  const loginRes = http.post(`${BASE_URL}/api/v1/auth/login`, JSON.stringify({
    email: email,
    password: password,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });

  requestDuration.add(new Date() - startTime);

  const success = check(loginRes, {
    'login successful': (r) => r.status === 200,
  });

  errorRate.add(!success);

  if (loginRes.status === 200) {
    const body = JSON.parse(loginRes.body);
    // NOTE: 프로젝트의 로그인 응답은 토큰을 문자열로 직접 반환
    // 일반 규격: { data: { accessToken: "..." } }
    // 현재 구조: { msg: "...", data: "토큰" }
    return body.data;
  }
  return null;
}

function getGroupRoomList(token) {
  const startTime = new Date();
  const res = http.get(`${BASE_URL}/api/v1/chats/rooms/group`, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  requestDuration.add(new Date() - startTime);

  const success = check(res, {
    'room list successful': (r) => r.status === 200,
  });

  errorRate.add(!success);

  if (res.status === 200) {
    const body = JSON.parse(res.body);
    return body.data || [];
  }
  return [];
}

function getMessages(token, roomId, chatRoomType) {
  const startTime = new Date();
  const url = `${BASE_URL}/api/v1/chats/rooms/${roomId}/messages?chatRoomType=${chatRoomType}&size=25`;

  const res = http.get(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  requestDuration.add(new Date() - startTime);

  const success = check(res, {
    'messages retrieved': (r) => r.status === 200,
  });

  errorRate.add(!success);

  return res.status === 200;
}

function getPublicRooms(token) {
  const startTime = new Date();
  const res = http.get(`${BASE_URL}/api/v1/chats/rooms/group/public`, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  requestDuration.add(new Date() - startTime);

  const success = check(res, {
    'public rooms retrieved': (r) => r.status === 200,
  });

  errorRate.add(!success);

  if (res.status === 200) {
    const body = JSON.parse(res.body);
    return body.data || [];
  }
  return [];
}

function joinGroupRoom(token, roomId) {
  const startTime = new Date();
  const res = http.post(`${BASE_URL}/api/v1/chats/rooms/group/${roomId}/join`,
    JSON.stringify({}),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    }
  );

  requestDuration.add(new Date() - startTime);

  const success = check(res, {
    'join group room success': (r) => r.status === 200 || r.status === 400,
  });

  errorRate.add(!success);

  return res.status === 200 || res.status === 400;
}

export default function () {
  concurrentUsers.add(1);

  const userIndex = (__VU - 1) % users.length;
  const user = users[userIndex];

  const token = login(user.email, user.password);

  if (!token) {
    errorRate.add(1);
    sleep(1);
    return;
  }

  sleep(0.5);

  // 채팅방 목록 조회
  getGroupRoomList(token);
  sleep(0.3);

  // 공개 방 조회
  const publicRooms = getPublicRooms(token);
  sleep(0.3);

  // 비밀번호 없는 방만 필터링
  const roomsWithoutPassword = publicRooms.filter(room => !room.hasPassword);

  // 랜덤 방의 메시지 조회
  if (roomsWithoutPassword.length > 0) {
    const randomRoom = roomsWithoutPassword[Math.floor(Math.random() * roomsWithoutPassword.length)];
    // NOTE: API 응답에서 roomId가 아닌 id 필드명 사용
    // 먼저 채팅방에 참여해야 메시지 조회 가능
    const joined = joinGroupRoom(token, randomRoom.id);
    sleep(0.2);

    if (joined) {
      getMessages(token, randomRoom.id, 'GROUP');
    }
  }

  sleep(1);
}

export function setup() {
  console.log('');
  console.log('=== 스트레스 테스트 시작 ===');
  console.log(`대상 서버: ${BASE_URL}`);
  console.log('');
  console.log('목표:');
  console.log('1. 시스템이 정상 작동하는 최대 동시 사용자 수 파악');
  console.log('2. 병목 지점 및 실패 임계점 발견');
  console.log('3. Auto Scaling 기준점 결정을 위한 데이터 수집');
  console.log('');
  console.log('부하 단계:');
  console.log('  50명  (2분) - 워밍업');
  console.log(' 100명  (4분) - 정상 부하');
  console.log(' 200명  (5분) - 높은 부하');
  console.log(' 300명  (5분) - 스트레스');
  console.log(' 500명  (5분) - 극한 스트레스');
  console.log('1000명  (3분) - 스파이크');
  console.log('');
  return { startTime: new Date() };
}

export function teardown(data) {
  console.log('');
  console.log('=== 스트레스 테스트 종료 ===');
  const duration = (new Date() - data.startTime) / 1000 / 60;
  console.log(`총 테스트 시간: ${duration.toFixed(2)}분`);
  console.log('');
  console.log('결과 분석 포인트:');
  console.log('- 에러율이 급증한 시점의 동시 사용자 수 확인');
  console.log('- p95 응답 시간이 1초를 넘는 시점 확인');
  console.log('- CPU/메모리 사용률 급증 시점 확인 (Grafana)');
  console.log('- DB Connection Pool 고갈 시점 확인');
}
