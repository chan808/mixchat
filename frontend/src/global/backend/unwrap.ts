import { FetchResponse } from "openapi-fetch";

// unwrap.ts
export const unwrap = async <T = unknown, TError = unknown, TStatus extends `${string}/${string}` = `${string}/${string}`>(
  response: FetchResponse<any, TError, TStatus>
): Promise<T> => {
  // 1. 백엔드가 4xx, 5xx 에러를 보내면 response.error 객체가 생성됨.
  // 이 객체를 사용해 명시적인 에러를 발생시킨다.
  if (response.error) {
    // 백엔드의 ApiResponse 형식에 맞게 에러 메시지를 추출
    const apiError = response.error as { msg?: string };
    throw new Error(apiError.msg || 'API 요청 처리 중 오류가 발생했습니다.');
  }

  // 2. 성공 응답(2xx)의 경우, data 필드 안의 실제 데이터를 반환한다.
  // 로그인 성공 시, response.data는 { msg: "...", data: "ey..." } 형태이므로
  // response.data.data를 반환해야 토큰이 반환된다.
  return response.data?.data as T;
};