// Code generated from apps/chickinfry/internal/contract/error-codes.json; DO NOT EDIT.

enum ChikErrorCode {
  canceled("canceled", 499, true),
  unknown("unknown", 500, true),
  invalidArgument("invalid_argument", 400, true),
  deadlineExceeded("deadline_exceeded", 504, true),
  alreadyExists("already_exists", 409, true),
  unauthenticated("unauthenticated", 401, true),
  permissionDenied("permission_denied", 403, true),
  notFound("not_found", 404, true),
  failedPrecondition("failed_precondition", 412, true),
  aborted("aborted", 409, true),
  outOfRange("out_of_range", 416, true),
  unimplemented("unimplemented", 501, true),
  resourceExhausted("resource_exhausted", 429, true),
  internal("internal", 500, true),
  unavailable("unavailable", 503, true),
  dataLoss("data_loss", 500, true),
  networkFailure("network_error", 0, false),
  invalidResponse("invalid_response", 502, false),
  storageError("storage_error", 0, false),
  commitUnknown("commit_unknown", 409, false),
  invalidUploadUrl("invalid_upload_url", 502, false),
  invalidMultipartPlan("invalid_multipart_plan", 502, false),
  multipartBodyRequired("multipart_body_required", 400, false),
  invalidMultipartPart("invalid_multipart_part", 400, false),
  payloadTooLarge("payload_too_large", 413, false),
  responseCredit("response_credit", 502, false),
  channelLimit("channel_limit", 429, false),
  unauthorized("unauthorized", 401, false),
  frameAuth("frame_auth", 401, false),
  halfClose("half_close", 400, false),
  ;

  const ChikErrorCode(this.wireValue, this.defaultHttpStatus, this.isProtocol);

  final String wireValue;
  final int defaultHttpStatus;
  final bool isProtocol;

  static ChikErrorCode fromWire(Object? value) {
    if (value is String) {
      for (final code in values) {
        if (code.wireValue == value) return code;
      }
    }
    return ChikErrorCode.unknown;
  }
}

abstract final class ChikErrorMessage {
  static const String authenticationOperationSuperseded = "The authentication operation was superseded by a newer session operation.";
  static const String authenticationSessionChanged = "The authentication session changed.";
  static const String browserSessionCoordinationRequired = "This browser must support same-origin session coordination to use application sessions safely.";
  static const String customerAuthenticationCookieInvalid = "The customer authentication cookie is invalid.";
  static const String customerSessionRequired = "A customer session is required.";
  static const String expectedSessionScopeInvalid = "The expected session scope is invalid.";
  static const String githubOauthBrowserCompletionInvalid = "The GitHub OAuth browser completion is missing or invalid.";
  static const String githubOauthBrowserOriginInvalid = "The GitHub OAuth browser completion must come from the application origin.";
  static const String githubOauthBrowserStateInvalid = "The GitHub OAuth browser state is invalid.";
  static const String githubOauthBrowserTransitionUnavailable = "The GitHub OAuth browser transition is unavailable.";
  static const String githubOauthCallbackInvalid = "The GitHub OAuth callback is invalid.";
  static const String githubOauthNonceCookieRequired = "The GitHub OAuth nonce cookie is required.";
  static const String githubOauthSessionSnapshotInvalid = "The GitHub OAuth session snapshot has an invalid format.";
  static const String githubOauthStateInvalid = "The GitHub OAuth state has an invalid format.";
}
