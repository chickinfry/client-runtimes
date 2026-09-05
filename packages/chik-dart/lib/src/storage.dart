import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'auth.dart';
import 'error-contract.dart';

/// HTTP error returned by the Chickinfry Storage API.
///
/// In Storage upload commit determinations, commit_unknown means the platform has not yet
/// confirmed safe completion. Do not automatically retry the same PUT or start a new upload intent.
final class ChikStorageApiError implements Exception {
  ChikStorageApiError(
    this.code,
    this.message, {
    this.rawCode,
    this.status,
    this.cause,
  });

  final ChikErrorCode code;
  final String? rawCode;
  final String message;
  final int? status;
  final Object? cause;

  @override
  String toString() => 'ChikStorageApiError($code, $message)';
}

/// Indicates Storage PUT was recorded to provider but version ACK was not received.
/// For single upload, resolve via complete() on the same upload first.
/// For multipart, put() can be called again with the same bytes; committed parts are treated as no-op.
/// Only create a new upload intent after an explicit abort().
final class ChikStorageUploadCommitUnknownError implements Exception {
  final ChikErrorCode code = ChikErrorCode.commitUnknown;
  final String uploadId;
  final String message;
  final int status;
  final Object? cause;

  ChikStorageUploadCommitUnknownError(
    this.uploadId,
    this.message, {
    this.status = 412,
    this.cause,
  });

  @override
  String toString() =>
      'ChikStorageUploadCommitUnknownError($uploadId: $message)';
}

final class ChikStorageCreateUploadInput {
  const ChikStorageCreateUploadInput({
    required this.bucket,
    required this.key,
    required this.contentType,
    required this.size,
    this.contentSha256,
    this.expiresInSeconds,
    this.idempotencyKey,
  });

  final String bucket;
  final String key;
  final String contentType;
  final int size;
  final String? contentSha256;
  final int? expiresInSeconds;
  final String? idempotencyKey;

  Map<String, Object?> toJson() => {
        'bucket': bucket,
        'key': key,
        'contentType': contentType,
        'size': size,
        if (contentSha256 != null) 'contentSha256': contentSha256,
        if (expiresInSeconds != null) 'expiresInSeconds': expiresInSeconds,
        if (idempotencyKey != null) 'idempotencyKey': idempotencyKey,
      };
}

final class ChikStorageDownloadInput {
  const ChikStorageDownloadInput({
    required this.bucket,
    required this.key,
    this.expiresInSeconds,
  });

  final String bucket;
  final String key;
  final int? expiresInSeconds;

  Map<String, Object?> toJson() => {
        'bucket': bucket,
        'key': key,
        if (expiresInSeconds != null) 'expiresInSeconds': expiresInSeconds,
      };
}

/// HTTP response abstraction used by both fetch transport and mocks.
/// Provider upload ID, signed URL, ETag, and credentials are never exposed.
final class ChikStorageResponse {
  const ChikStorageResponse(this.status, {this.bodyBytes, this.headers});

  final int status;
  final Uint8List? bodyBytes;
  final Map<String, String>? headers;

  bool get ok => status >= 200 && status < 300;

  Map<String, dynamic>? json() {
    final bytes = bodyBytes;
    if (bytes == null) return null;
    try {
      return jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }
}

/// Storage HTTP transport. The generated default uses package:http and tests
/// can replace it with canned responses.
typedef ChikStorageFetch = Future<ChikStorageResponse> Function(
  String method,
  String url, {
  Map<String, String>? headers,
  Uint8List? body,
});

/// Upload handle returned by createUpload, providing put, complete, and abort.
final class ChikStorageUpload {
  ChikStorageUpload._({
    required this.id,
    required this.expiresAt,
    required Map<String, dynamic> descriptor,
    required ChikStorageClient client,
  })  : _descriptor = descriptor,
        _client = client;

  final String id;
  final String expiresAt;
  final Map<String, dynamic> _descriptor;
  final ChikStorageClient _client;

  /// Succeeds only after both provider persistence and version record are confirmed.
  /// For multipart descriptors, splits bytes into parts and PUTs to the same origin.
  /// If commit_unknown occurs, can be recovered by calling put() on the same upload again.
  Future<void> put(Uint8List body) => _client._putUpload(_descriptor, body);

  /// Completion step invoked after single upload commit_unknown or multipart part transmission.
  Future<Map<String, dynamic>> complete() => _client._completeUpload(id);

  /// Explicitly aborts the upload intent. Create a new intent only after aborting.
  Future<void> abort() => _client._abortUpload(id);
}

final class ChikStorageClient {
  ChikStorageClient({
    required this.baseUrl,
    this.apiKey,
    this.sessionToken,
    this.sessionTokenProvider,
    this.sessionScopeProvider,
    this.sessionScopeLeaseProvider,
    this.sessionTokenRefresher,
    this.headers = const {},
    ChikStorageFetch? fetch,
  }) : _fetch = fetch ?? _chikStorageHttpFetch;

  final String baseUrl;
  final String? apiKey;
  final String? sessionToken;
  final String? Function()? sessionTokenProvider;
  final ChikSessionScopeProvider? sessionScopeProvider;
  final ChikSessionScopeLeaseProvider? sessionScopeLeaseProvider;
  final ChikSessionTokenRefresher? sessionTokenRefresher;
  final Map<String, String> headers;
  final ChikStorageFetch _fetch;
  late final String _origin = _storageOrigin(baseUrl);

  String? get _currentSessionToken {
    final token =
        sessionTokenProvider == null ? sessionToken : sessionTokenProvider!();
    final normalized = token?.trim();
    return normalized == null || normalized.isEmpty ? null : normalized;
  }

  Future<ChikStorageUpload> createUpload(
    ChikStorageCreateUploadInput input,
  ) async {
    final json = await _storageJson(
      'POST',
      '/api/storage/uploads',
      body: input.toJson(),
    );
    return ChikStorageUpload._(
      id: json['uploadIntentId'] as String,
      expiresAt: json['expiresAt'] as String,
      descriptor: json,
      client: this,
    );
  }

  Future<({String url, String expiresAt})> getDownloadUrl(
    ChikStorageDownloadInput input,
  ) async {
    final json = await _storageJson(
      'POST',
      '/api/storage/download-url',
      body: input.toJson(),
      retryOnAuthenticationFailure: true,
    );
    return (url: json['url'] as String, expiresAt: json['expiresAt'] as String);
  }

  /// Generates a stable public bucket URL synchronously without provider URLs or signatures.
  String getPublicUrl({required String bucket, required String key}) {
    final uri = Uri.parse(_origin).replace(
      path: '/api/storage/public',
      queryParameters: {'bucket': bucket, 'key': key},
    );
    return uri.toString();
  }

  Future<Map<String, dynamic>> _completeUpload(String uploadIntentId) async {
    return _storageJson(
      'POST',
      '/api/storage/uploads/${Uri.encodeComponent(uploadIntentId)}/complete',
      body: <String, Object?>{},
    );
  }

  Future<void> _abortUpload(String uploadIntentId) async {
    await _storageJson(
      'DELETE',
      '/api/storage/uploads/${Uri.encodeComponent(uploadIntentId)}',
    );
  }

  Future<void> _putUpload(
    Map<String, dynamic> descriptor,
    Uint8List body,
  ) async {
    final uploadIntentId = descriptor['uploadIntentId'] as String;
    if (descriptor['uploadMode'] == 'multipart') {
      await _putMultipart(
        descriptor: descriptor,
        uploadIntentId: uploadIntentId,
        body: body,
      );
      return;
    }
    await _putSingle(
      descriptor: descriptor,
      uploadIntentId: uploadIntentId,
      body: body,
    );
  }

  Future<void> _putSingle({
    required Map<String, dynamic> descriptor,
    required String uploadIntentId,
    required Uint8List body,
  }) async {
    final uploadUrl = _sameOriginUploadUrl(
      _origin,
      descriptor['uploadUrl'] as String,
    );
    final rawHeaders =
        descriptor['requiredHeaders'] as Map<String, dynamic>? ?? const {};
    final headers = rawHeaders.map((k, v) => MapEntry(k, v.toString()));
    final response = await _fetch(
      'PUT',
      uploadUrl,
      headers: headers,
      body: body,
    );
    if (response.ok) return;
    final error = await _storageError(response, 'Storage upload');
    if (error.code == ChikErrorCode.commitUnknown) {
      throw ChikStorageUploadCommitUnknownError(
        uploadIntentId,
        'Storage upload commit status could not be verified. Do not re-run upload.put(); verify with complete() first.',
        status: error.status ?? 502,
        cause: error,
      );
    }
    throw error;
  }

  Future<void> _putMultipart({
    required Map<String, dynamic> descriptor,
    required String uploadIntentId,
    required Uint8List body,
  }) async {
    final partSizeBytes = int.parse(descriptor['partSizeBytes'] as String);
    final partCount = descriptor['partCount'] as int;
    final token = descriptor['multipartToken'] as String;
    final contentType =
        descriptor['contentType'] as String? ?? 'application/octet-stream';
    _validateMultipartPlan(
      partSizeBytes: partSizeBytes,
      partCount: partCount,
      size: body.length,
    );
    for (var partNumber = 1; partNumber <= partCount; partNumber++) {
      final start = (partNumber - 1) * partSizeBytes;
      final end = (start + partSizeBytes > body.length)
          ? body.length
          : start + partSizeBytes;
      final part = body.sublist(start, end);
      final url = _multipartPartUrl(
        origin: _origin,
        uploadIntentId: uploadIntentId,
        partNumber: partNumber,
        token: token,
      );
      for (var attempt = 0; attempt < 3; attempt++) {
        final response = await _fetch(
          'PUT',
          url,
          headers: {'content-type': contentType},
          body: part,
        );
        if (response.ok) break;
        final error = await _storageError(
          response,
          'Storage multipart part upload',
        );
        if (error.code == ChikErrorCode.commitUnknown && attempt < 2) continue;
        if (error.code == ChikErrorCode.commitUnknown) {
          throw ChikStorageUploadCommitUnknownError(
            uploadIntentId,
            'Storage multipart part commit status could not be verified. Call upload.put() again to recover.',
            status: error.status ?? 502,
            cause: error,
          );
        }
        throw error;
      }
    }
  }

  Future<Map<String, dynamic>> _storageJson(
    String method,
    String path, {
    Map<String, Object?>? body,
    bool retryOnAuthenticationFailure = false,
  }) async {
    final encodedBody =
        body == null ? null : Uint8List.fromList(utf8.encode(jsonEncode(body)));
    final retryScope = retryOnAuthenticationFailure
        ? _captureAuthenticationRetryScope()
        : null;
    return _storageJsonEncoded(method, path, encodedBody, retryScope, false);
  }

  Future<Map<String, dynamic>> _storageJsonEncoded(
    String method,
    String path,
    Uint8List? encodedBody,
    _StorageAuthenticationRetryScope? retryScope,
    bool retriedAfterAuthenticationFailure,
  ) async {
    final requestHeaders = <String, String>{...headers};
    _storageSetHeader(requestHeaders, 'content-type', 'application/json');
    if (_storageReadHeader(requestHeaders, 'authorization') == null) {
      final token = retryScope == null
          ? _currentSessionToken ?? apiKey
          : retryScope.token;
      if (token != null && token.isNotEmpty)
        _storageSetHeader(requestHeaders, 'authorization', 'Bearer $token');
    }
    final response = await _fetch(
      method,
      '$_origin$path',
      headers: requestHeaders,
      body: encodedBody,
    );
    if (!response.ok) {
      if (!retriedAfterAuthenticationFailure &&
          response.status == 401 &&
          retryScope != null &&
          _authenticationRetryScopeIsCurrent(retryScope)) {
        final token = await sessionTokenRefresher!(
          retryScope.sessionScope,
          retryScope.lease,
        );
        if (token != null &&
            token.trim().isNotEmpty &&
            _authenticationRetryScopeIsCurrent(retryScope)) {
          retryScope.token = token.trim();
          return _storageJsonEncoded(
            method,
            path,
            encodedBody,
            retryScope,
            true,
          );
        }
      }
      throw await _storageError(response, 'Chickinfry Storage API');
    }
    if (response.status == 204) return <String, dynamic>{};
    return response.json() ?? <String, dynamic>{};
  }

  _StorageAuthenticationRetryScope? _captureAuthenticationRetryScope() {
    if (sessionTokenProvider != null &&
        sessionScopeProvider != null &&
        sessionScopeLeaseProvider != null &&
        sessionTokenRefresher != null &&
        _storageReadHeader(headers, 'authorization') == null) {
      final sessionScope = sessionScopeProvider!()?.trim();
      final lease = sessionScopeLeaseProvider!();
      final token = sessionTokenProvider!()?.trim();
      if (sessionScope != null &&
          sessionScope.isNotEmpty &&
          lease != null &&
          lease.isActive &&
          lease.sessionScope == sessionScope) {
        final scope = _StorageAuthenticationRetryScope(
          sessionScope: sessionScope,
          lease: lease,
          token: token,
        );
        return _authenticationRetryScopeIsCurrent(scope) ? scope : null;
      }
    }
    return null;
  }

  bool _authenticationRetryScopeIsCurrent(
    _StorageAuthenticationRetryScope scope,
  ) {
    return scope.lease.isActive &&
        identical(sessionScopeLeaseProvider?.call(), scope.lease) &&
        sessionScopeProvider?.call()?.trim() == scope.sessionScope;
  }

  Future<ChikStorageApiError> _storageError(
    ChikStorageResponse response,
    String action,
  ) async {
    var message = '$action failed with HTTP ${response.status}';
    var code = ChikErrorCode.unknown;
    String? unrecognizedCode;
    final body = response.json();
    if (body != null) {
      final declaredCode = body['code'];
      if (declaredCode is String && declaredCode.isNotEmpty) {
        final parsedCode = ChikErrorCode.fromWire(declaredCode);
        if (parsedCode != ChikErrorCode.unknown ||
            declaredCode == ChikErrorCode.unknown.wireValue) {
          code = parsedCode;
        } else {
          unrecognizedCode = declaredCode;
        }
      }
      final rawMessage = body['message'];
      if (rawMessage is String && rawMessage.isNotEmpty) message = rawMessage;
    }
    return ChikStorageApiError(
      code,
      message,
      rawCode: unrecognizedCode,
      status: response.status,
    );
  }
}

final class _StorageAuthenticationRetryScope {
  _StorageAuthenticationRetryScope({
    required this.sessionScope,
    required this.lease,
    required this.token,
  });

  final String sessionScope;
  final ChikSessionScopeLease lease;
  String? token;
}

void _validateMultipartPlan({
  required int partSizeBytes,
  required int partCount,
  required int size,
}) {
  if (partSizeBytes <= 0 ||
      partCount < 1 ||
      partCount > 10000 ||
      (size / partSizeBytes).ceil() != partCount) {
    throw ChikStorageApiError(
      ChikErrorCode.invalidMultipartPlan,
      'Invalid Storage multipart upload plan.',
      status: 502,
    );
  }
}

String _multipartPartUrl({
  required String origin,
  required String uploadIntentId,
  required int partNumber,
  required String token,
}) {
  if (partNumber < 1 || partNumber > 10000 || token.isEmpty) {
    throw ChikStorageApiError(
      ChikErrorCode.invalidMultipartPart,
      'Invalid Storage multipart part URL.',
      status: 502,
    );
  }
  final uri = Uri.parse(origin).replace(
    path:
        '/api/storage/uploads/${Uri.encodeComponent(uploadIntentId)}/parts/$partNumber',
    queryParameters: {'token': token},
  );
  return uri.toString();
}

String _storageOrigin(String baseUrl) {
  final uri = Uri.parse(baseUrl);
  if (uri.scheme != 'http' && uri.scheme != 'https') {
    throw ArgumentError(
      'Storage baseUrl must be an absolute HTTP(S) deployment URL.',
    );
  }
  if (uri.userInfo.isNotEmpty ||
      uri.query.isNotEmpty ||
      uri.fragment.isNotEmpty) {
    throw ArgumentError(
      'Storage baseUrl must be an absolute HTTP(S) deployment URL.',
    );
  }
  return uri.origin;
}

String _sameOriginUploadUrl(String origin, String value) {
  final uri = Uri.tryParse(value);
  if (uri == null || uri.origin != origin || uri.userInfo.isNotEmpty) {
    throw ChikStorageApiError(
      ChikErrorCode.invalidUploadUrl,
      'Storage upload URL must share the same application origin.',
      status: 502,
    );
  }
  return uri.toString();
}

final _chikStorageHttpClient = http.Client();

Future<ChikStorageResponse> _chikStorageHttpFetch(
  String method,
  String url, {
  Map<String, String>? headers,
  Uint8List? body,
}) async {
  final request = http.Request(method, Uri.parse(url))
    ..followRedirects = false
    ..maxRedirects = 0;
  if (headers != null) request.headers.addAll(headers);
  if (body != null) request.bodyBytes = body;
  final response = await http.Response.fromStream(
    await _chikStorageHttpClient.send(request),
  );
  return ChikStorageResponse(
    response.statusCode,
    bodyBytes: response.bodyBytes,
    headers: response.headers,
  );
}

String? _storageReadHeader(Map<String, String> headers, String name) {
  final lower = name.toLowerCase();
  for (final entry in headers.entries) {
    if (entry.key.toLowerCase() == lower) return entry.value;
  }
  return null;
}

void _storageSetHeader(Map<String, String> headers, String name, String value) {
  final lower = name.toLowerCase();
  headers.removeWhere((key, _) => key.toLowerCase() == lower);
  headers[name] = value;
}
