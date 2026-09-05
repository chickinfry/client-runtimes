// Code generated from apps/chickinfry/internal/contract/error-codes.json; DO NOT EDIT.

export const ChikErrorCode = {
  canceled: "canceled",
  unknown: "unknown",
  invalidArgument: "invalid_argument",
  deadlineExceeded: "deadline_exceeded",
  alreadyExists: "already_exists",
  unauthenticated: "unauthenticated",
  permissionDenied: "permission_denied",
  notFound: "not_found",
  failedPrecondition: "failed_precondition",
  aborted: "aborted",
  outOfRange: "out_of_range",
  unimplemented: "unimplemented",
  resourceExhausted: "resource_exhausted",
  internal: "internal",
  unavailable: "unavailable",
  dataLoss: "data_loss",
  networkFailure: "network_error",
  invalidResponse: "invalid_response",
  storageError: "storage_error",
  commitUnknown: "commit_unknown",
  invalidUploadUrl: "invalid_upload_url",
  invalidMultipartPlan: "invalid_multipart_plan",
  multipartBodyRequired: "multipart_body_required",
  invalidMultipartPart: "invalid_multipart_part",
  payloadTooLarge: "payload_too_large",
  responseCredit: "response_credit",
  channelLimit: "channel_limit",
  unauthorized: "unauthorized",
  frameAuth: "frame_auth",
  halfClose: "half_close",
} as const;

export type ChikErrorCode = typeof ChikErrorCode[keyof typeof ChikErrorCode];

export const ChikErrorMessage = {
  authenticationOperationSuperseded: "The authentication operation was superseded by a newer session operation.",
  authenticationSessionChanged: "The authentication session changed.",
  browserSessionCoordinationRequired: "This browser must support same-origin session coordination to use application sessions safely.",
  customerAuthenticationCookieInvalid: "The customer authentication cookie is invalid.",
  customerSessionRequired: "A customer session is required.",
  expectedSessionScopeInvalid: "The expected session scope is invalid.",
  githubOauthBrowserCompletionInvalid: "The GitHub OAuth browser completion is missing or invalid.",
  githubOauthBrowserOriginInvalid: "The GitHub OAuth browser completion must come from the application origin.",
  githubOauthBrowserStateInvalid: "The GitHub OAuth browser state is invalid.",
  githubOauthBrowserTransitionUnavailable: "The GitHub OAuth browser transition is unavailable.",
  githubOauthCallbackInvalid: "The GitHub OAuth callback is invalid.",
  githubOauthNonceCookieRequired: "The GitHub OAuth nonce cookie is required.",
  githubOauthSessionSnapshotInvalid: "The GitHub OAuth session snapshot has an invalid format.",
  githubOauthStateInvalid: "The GitHub OAuth state has an invalid format.",
} as const;

const chikErrorCodeSet: ReadonlySet<string> = new Set(Object.values(ChikErrorCode));
const chikProtocolErrorCodes: ReadonlySet<ChikErrorCode> = new Set([
  ChikErrorCode.canceled,
  ChikErrorCode.unknown,
  ChikErrorCode.invalidArgument,
  ChikErrorCode.deadlineExceeded,
  ChikErrorCode.alreadyExists,
  ChikErrorCode.unauthenticated,
  ChikErrorCode.permissionDenied,
  ChikErrorCode.notFound,
  ChikErrorCode.failedPrecondition,
  ChikErrorCode.aborted,
  ChikErrorCode.outOfRange,
  ChikErrorCode.unimplemented,
  ChikErrorCode.resourceExhausted,
  ChikErrorCode.internal,
  ChikErrorCode.unavailable,
  ChikErrorCode.dataLoss,
]);

export type ChikProtocolErrorCode =
  | typeof ChikErrorCode.canceled
  | typeof ChikErrorCode.unknown
  | typeof ChikErrorCode.invalidArgument
  | typeof ChikErrorCode.deadlineExceeded
  | typeof ChikErrorCode.alreadyExists
  | typeof ChikErrorCode.unauthenticated
  | typeof ChikErrorCode.permissionDenied
  | typeof ChikErrorCode.notFound
  | typeof ChikErrorCode.failedPrecondition
  | typeof ChikErrorCode.aborted
  | typeof ChikErrorCode.outOfRange
  | typeof ChikErrorCode.unimplemented
  | typeof ChikErrorCode.resourceExhausted
  | typeof ChikErrorCode.internal
  | typeof ChikErrorCode.unavailable
  | typeof ChikErrorCode.dataLoss
;

export function isChikErrorCode(value: unknown): value is ChikErrorCode {
  return typeof value === "string" && chikErrorCodeSet.has(value);
}

export function chikErrorCodeFromWire(value: unknown): ChikErrorCode {
  return isChikErrorCode(value) ? value : ChikErrorCode.unknown;
}

export function isChikProtocolErrorCode(value: unknown): value is ChikProtocolErrorCode {
  return isChikErrorCode(value) && chikProtocolErrorCodes.has(value);
}

export function chikErrorDefaultStatus(code: ChikErrorCode): number {
  switch (code) {
    case ChikErrorCode.canceled: return 499;
    case ChikErrorCode.unknown: return 500;
    case ChikErrorCode.invalidArgument: return 400;
    case ChikErrorCode.deadlineExceeded: return 504;
    case ChikErrorCode.alreadyExists: return 409;
    case ChikErrorCode.unauthenticated: return 401;
    case ChikErrorCode.permissionDenied: return 403;
    case ChikErrorCode.notFound: return 404;
    case ChikErrorCode.failedPrecondition: return 412;
    case ChikErrorCode.aborted: return 409;
    case ChikErrorCode.outOfRange: return 416;
    case ChikErrorCode.unimplemented: return 501;
    case ChikErrorCode.resourceExhausted: return 429;
    case ChikErrorCode.internal: return 500;
    case ChikErrorCode.unavailable: return 503;
    case ChikErrorCode.dataLoss: return 500;
    case ChikErrorCode.networkFailure: return 0;
    case ChikErrorCode.invalidResponse: return 502;
    case ChikErrorCode.storageError: return 0;
    case ChikErrorCode.commitUnknown: return 409;
    case ChikErrorCode.invalidUploadUrl: return 502;
    case ChikErrorCode.invalidMultipartPlan: return 502;
    case ChikErrorCode.multipartBodyRequired: return 400;
    case ChikErrorCode.invalidMultipartPart: return 400;
    case ChikErrorCode.payloadTooLarge: return 413;
    case ChikErrorCode.responseCredit: return 502;
    case ChikErrorCode.channelLimit: return 429;
    case ChikErrorCode.unauthorized: return 401;
    case ChikErrorCode.frameAuth: return 401;
    case ChikErrorCode.halfClose: return 400;
  }
}
