// K6 테스트 공통 설정

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

// 부하 테스트 프로필
export const LOAD_PROFILES = {
  // 가벼운 부하 테스트 (개발 중 빠른 확인용)
  smoke: {
    stages: [
      { duration: '30s', target: 10 },
      { duration: '1m', target: 10 },
      { duration: '30s', target: 0 },
    ],
    thresholds: {
      http_req_duration: ['p(95)<500'],
      http_req_failed: ['rate<0.01'],
    },
  },

  // 일반 부하 테스트 (Before/After 비교용)
  load: {
    stages: [
      { duration: '1m', target: 50 },
      { duration: '3m', target: 50 },
      { duration: '1m', target: 100 },
      { duration: '3m', target: 100 },
      { duration: '1m', target: 200 },
      { duration: '3m', target: 200 },
      { duration: '2m', target: 0 },
    ],
    thresholds: {
      http_req_duration: ['p(95)<1000'],
      http_req_failed: ['rate<0.01'],
    },
  },

  // 스트레스 테스트 (임계점 찾기)
  stress: {
    stages: [
      { duration: '2m', target: 50 },
      { duration: '2m', target: 100 },
      { duration: '2m', target: 200 },
      { duration: '3m', target: 300 },
      { duration: '3m', target: 500 },
      { duration: '2m', target: 1000 },
      { duration: '2m', target: 100 },
      { duration: '1m', target: 0 },
    ],
    thresholds: {
      http_req_duration: ['p(95)<5000'],
      http_req_failed: ['rate<0.10'],
    },
  },

  // 스파이크 테스트 (급격한 부하 증가)
  spike: {
    stages: [
      { duration: '30s', target: 50 },
      { duration: '10s', target: 500 },  // 급격한 증가
      { duration: '2m', target: 500 },
      { duration: '10s', target: 50 },   // 급격한 감소
      { duration: '1m', target: 50 },
      { duration: '30s', target: 0 },
    ],
    thresholds: {
      http_req_duration: ['p(95)<2000'],
      http_req_failed: ['rate<0.05'],
    },
  },

  // Soak 테스트 (장시간 안정성)
  soak: {
    stages: [
      { duration: '2m', target: 100 },
      { duration: '30m', target: 100 },  // 30분간 유지
      { duration: '2m', target: 0 },
    ],
    thresholds: {
      http_req_duration: ['p(95)<1000'],
      http_req_failed: ['rate<0.01'],
    },
  },
};

// 테스트 환경별 설정
export const ENVIRONMENTS = {
  local: {
    baseURL: 'http://localhost:8080',
  },
  dev: {
    baseURL: 'http://dev-api.mixchat.com',
  },
  staging: {
    baseURL: 'http://staging-api.mixchat.com',
  },
  prod: {
    baseURL: 'http://api.mixchat.com',
  },
};

// 현재 환경 가져오기
export function getEnvironment() {
  const env = __ENV.ENV || 'local';
  return ENVIRONMENTS[env] || ENVIRONMENTS.local;
}

// 현재 프로필 가져오기
export function getProfile() {
  const profile = __ENV.PROFILE || 'load';
  return LOAD_PROFILES[profile] || LOAD_PROFILES.load;
}
