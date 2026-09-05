import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'error-contract.dart';

/// Supplies the current native application session credential to a client.
///
/// The provider is evaluated for every request and connection attempt so a
/// credential rotation does not require rebuilding generated clients.
typedef ChikSessionTokenProvider = String? Function();

/// Supplies the server-issued opaque scope for local state that must not cross sign-in sessions.
typedef ChikSessionScopeProvider = String? Function();

/// A process-local lease that ends synchronously when its sign-in session changes.
final class ChikSessionScopeLease {
  ChikSessionScopeLease(this.sessionScope);

  final String sessionScope;
  final Set<void Function()> _listeners = <void Function()>{};
  bool _active = true;

  bool get isActive => _active;

  void Function() listen(void Function() listener) {
    if (!_active) {
      listener();
      return () {};
    }
    _listeners.add(listener);
    return () => _listeners.remove(listener);
  }

  void invalidate() {
    if (!_active) return;
    _active = false;
    final listeners = List<void Function()>.of(_listeners);
    _listeners.clear();
    for (final listener in listeners) {
      try {
        listener();
      } catch (_) {
        // One consumer cannot keep another consumer attached to an invalid session.
      }
    }
  }
}

typedef ChikSessionScopeLeaseProvider = ChikSessionScopeLease? Function();

/// Refreshes a native application session and returns its next request credential.
typedef ChikSessionTokenRefresher = Future<String?> Function(
  String expectedSessionScope,
  ChikSessionScopeLease expectedLease,
);

final class ChikAuthError implements Exception {
  ChikAuthError(
    this.code,
    this.message, {
    this.rawCode,
    this.status,
    this.retryAfterSeconds,
    this.details,
    this.cause,
  });

  final ChikErrorCode code;
  final String? rawCode;
  final String message;
  final int? status;
  final int? retryAfterSeconds;
  final Object? details;
  final Object? cause;

  @override
  String toString() => 'ChikAuthError($code, $message)';
}

final class AuthUser {
  const AuthUser({
    required this.userId,
    required this.projectId,
    required this.email,
    required this.emailVerified,
    required this.disabled,
    required this.createdAt,
  });

  final String userId;
  final String projectId;
  final String email;
  final bool emailVerified;
  final bool disabled;
  final String createdAt;

  factory AuthUser.fromJson(Map<String, Object?> json) {
    return AuthUser(
      userId: json['userId'] as String,
      projectId: json['projectId'] as String,
      email: json['email'] as String,
      emailVerified: json['emailVerified'] as bool,
      disabled: json['disabled'] as bool,
      createdAt: json['createdAt'] as String,
    );
  }
}

final class AuthSession {
  const AuthSession({
    required this.user,
    required this.expiresAt,
    this.sessionToken,
    this.refreshToken,
    this.refreshExpiresAt,
  }) : _sessionScope = null;

  const AuthSession._({
    required this.user,
    required this.expiresAt,
    required this.sessionToken,
    required this.refreshToken,
    required this.refreshExpiresAt,
    required String? sessionScope,
  }) : _sessionScope = sessionScope;

  final AuthUser user;
  final String expiresAt;
  final String? sessionToken;
  final String? refreshToken;
  final String? refreshExpiresAt;
  final String? _sessionScope;

  factory AuthSession.fromJson(Map<String, Object?> json) {
    return AuthSession._(
      user: AuthUser.fromJson(_authObject(json['user'])),
      expiresAt: json['expiresAt'] as String,
      sessionToken: json['sessionToken'] as String?,
      refreshToken: json['refreshToken'] as String?,
      refreshExpiresAt: json['refreshExpiresAt'] as String?,
      sessionScope: _optionalNativeResponseSessionScope(json['sessionScope']),
    );
  }

  factory AuthSession._fromNativeJson(Map<String, Object?> json) {
    final session = AuthSession.fromJson(json);
    _requiredNativeResponseSessionScope(session._sessionScope);
    return session;
  }
}

/// The accepted response returned by verification and password-reset requests.
final class ChikAuthActionAccepted {
  const ChikAuthActionAccepted({required this.accepted, this.expiresAt});

  final bool accepted;
  final String? expiresAt;

  factory ChikAuthActionAccepted.fromJson(Map<String, Object?> json) {
    return ChikAuthActionAccepted(
      accepted: json['accepted'] is bool ? json['accepted'] as bool : true,
      expiresAt: json['expiresAt'] as String?,
    );
  }
}

enum ChikPushPlatform { web, apns, fcm }

typedef ChikPushLocalUnsubscribe = Future<void> Function();

final class ChikPushSubscription {
  const ChikPushSubscription({
    required this.platform,
    required this.endpoint,
    this.keys = const {},
    this.deviceLabel,
    this.localUnsubscribe,
  });

  final ChikPushPlatform platform;
  final String endpoint;
  final Map<String, String> keys;
  final String? deviceLabel;
  final ChikPushLocalUnsubscribe? localUnsubscribe;
}

final class ChikPushRegistration {
  const ChikPushRegistration({
    required this.subscriptionId,
    required this.platform,
  });

  final String subscriptionId;
  final ChikPushPlatform platform;
}

/// Compatibility transport for applications that already own HTTP transport.
typedef ChikAuthTransport = Future<Map<String, Object?>> Function(
  String method,
  String path, {
  Map<String, String>? headers,
  Object? body,
});

/// HTTP response abstraction for applications that need to replace auth fetch.
final class ChikAuthResponse {
  const ChikAuthResponse({
    required this.status,
    this.bodyBytes,
    this.headers = const {},
  });

  final int status;
  final Uint8List? bodyBytes;
  final Map<String, String> headers;

  bool get ok => status >= 200 && status < 300;
}

typedef ChikAuthFetch = Future<ChikAuthResponse> Function(
  String method,
  String url, {
  Map<String, String>? headers,
  Uint8List? body,
});

final class _ChikAuthRequester {
  _ChikAuthRequester.legacy(this._legacyTransport)
      : _baseUrl = null,
        _apiKey = null,
        _sessionToken = null,
        _sessionTokenProvider = null,
        _headers = const {},
        _fetch = null;

  _ChikAuthRequester.http({
    required String baseUrl,
    String? apiKey,
    String? sessionToken,
    ChikSessionTokenProvider? sessionTokenProvider,
    Map<String, String> headers = const {},
    ChikAuthFetch? fetch,
  })  : _legacyTransport = null,
        _baseUrl = _authOrigin(baseUrl),
        _apiKey = apiKey,
        _sessionToken = sessionToken,
        _sessionTokenProvider = sessionTokenProvider,
        _headers = headers,
        _fetch = fetch ?? _chikAuthHttpFetch;

  final ChikAuthTransport? _legacyTransport;
  final String? _baseUrl;
  final String? _apiKey;
  final String? _sessionToken;
  final ChikSessionTokenProvider? _sessionTokenProvider;
  final Map<String, String> _headers;
  final ChikAuthFetch? _fetch;

  Future<Map<String, Object?>> call(
    String method,
    String path, {
    Object? body,
  }) async {
    final legacy = _legacyTransport;
    if (legacy != null) {
      try {
        return await legacy(
          method,
          path,
          body: body,
          headers: const {'content-type': 'application/json'},
        );
      } on ChikAuthError {
        rethrow;
      } catch (error) {
        throw ChikAuthError(
          ChikErrorCode.networkFailure,
          error.toString(),
          status: 0,
          cause: error,
        );
      }
    }
    final headers = <String, String>{..._headers};
    _authSetHeader(headers, 'content-type', 'application/json');
    if (_authReadHeader(headers, 'authorization') == null) {
      final token = _sessionTokenProvider == null
          ? _sessionToken ?? _apiKey
          : _sessionTokenProvider() ?? _apiKey;
      if (token != null && token.isNotEmpty)
        _authSetHeader(headers, 'authorization', 'Bearer $token');
    }
    try {
      final response = await _fetch!(
        method,
        '$_baseUrl$path',
        headers: headers,
        body: body == null
            ? null
            : Uint8List.fromList(utf8.encode(jsonEncode(body))),
      );
      if (!response.ok) throw _authErrorFromResponse(response);
      final bytes = response.bodyBytes;
      if (bytes == null || bytes.isEmpty) return <String, Object?>{};
      return _authObject(jsonDecode(utf8.decode(bytes)));
    } on ChikAuthError {
      rethrow;
    } catch (error) {
      throw ChikAuthError(
        ChikErrorCode.networkFailure,
        error.toString(),
        status: 0,
        cause: error,
      );
    }
  }
}

final class ChikPush {
  ChikPush(this._requester);

  final _ChikAuthRequester _requester;
  ChikPushSubscription? _subscription;

  Future<Map<String, String>> getPublicKey() async {
    final json = await _requester.call('GET', '/api/push/public-key');
    return {'publicKey': json['publicKey'] as String};
  }

  Future<ChikPushRegistration> subscribe(
    ChikPushSubscription subscription,
  ) async {
    final json = await _requester.call(
      'POST',
      '/api/push/subscribe',
      body: {
        'platform': subscription.platform.name,
        'endpoint': subscription.endpoint,
        if (subscription.keys.isNotEmpty) 'keys': subscription.keys,
        if (subscription.deviceLabel != null)
          'deviceLabel': subscription.deviceLabel,
      },
    );
    _subscription = subscription;
    return ChikPushRegistration(
      subscriptionId: json['subscriptionId'] as String,
      platform: ChikPushPlatform.values.byName(json['platform'] as String),
    );
  }

  Future<void> unsubscribe([ChikPushSubscription? subscription]) async {
    final active = subscription ?? _subscription;
    if (active == null) return;
    await _requester.call(
      'POST',
      '/api/push/unsubscribe',
      body: {'endpoint': active.endpoint},
    );
    try {
      await active.localUnsubscribe?.call();
    } finally {
      if (active.endpoint == _subscription?.endpoint) _subscription = null;
    }
  }

  Future<void> _unsubscribeLocalBestEffort([
    ChikPushSubscription? subscription,
  ]) async {
    final active = subscription ?? _subscription;
    if (active == null) return;
    try {
      await active.localUnsubscribe?.call();
    } catch (_) {
      // Server state has already changed; local cleanup cannot reverse sign-out.
    } finally {
      if (active.endpoint == _subscription?.endpoint) _subscription = null;
    }
  }
}

final class ChikAuth {
  /// Keeps the existing application-owned transport integration available.
  ChikAuth(ChikAuthTransport transport)
      : this._(_ChikAuthRequester.legacy(transport));

  /// Uses the generated default HTTP path with optional bearer session auth.
  ChikAuth.withOptions({
    required String baseUrl,
    String? apiKey,
    String? sessionToken,
    ChikSessionTokenProvider? sessionTokenProvider,
    Map<String, String> headers = const {},
    ChikAuthFetch? fetch,
  }) : this._(
          _ChikAuthRequester.http(
            baseUrl: baseUrl,
            apiKey: apiKey,
            sessionToken: sessionToken,
            sessionTokenProvider: sessionTokenProvider,
            headers: headers,
            fetch: fetch,
          ),
        );

  ChikAuth._(_ChikAuthRequester requester)
      : _requester = requester,
        push = ChikPush(requester);

  final _ChikAuthRequester _requester;
  final ChikPush push;

  Future<AuthUser> signUp(String email, String password) async {
    final json = await _requester.call(
      'POST',
      '/api/auth/sign-up',
      body: {'email': email, 'password': password},
    );
    return AuthUser.fromJson(_authObject(json['user']));
  }

  Future<AuthSession> signIn(String email, String password) async {
    final json = await _requester.call(
      'POST',
      '/api/auth/sign-in',
      body: {'email': email, 'password': password},
    );
    return AuthSession.fromJson(json);
  }

  /// Low-level native sign-in response.
  ///
  /// Use [ChikNativeAuth.signIn] for the normal application flow so the SDK
  /// stores and rotates the resulting session without manual token handling.
  Future<AuthSession> signInNative(String email, String password) async {
    final json = await _requester.call(
      'POST',
      '/api/auth/native/sign-in',
      body: {'email': email, 'password': password},
    );
    final session = AuthSession._fromNativeJson(json);
    if (session.sessionToken == null || session.sessionToken!.isEmpty) {
      throw ChikAuthError(
        ChikErrorCode.invalidResponse,
        'Native sign-in response did not include a session token.',
      );
    }
    ChikNativeStoredSession.fromAuthSession(session);
    return session;
  }

  Future<void> signOut([ChikPushSubscription? subscription]) async {
    final active = subscription ?? push._subscription;
    await _requester.call(
      'POST',
      '/api/auth/sign-out',
      body: {if (active != null) 'pushEndpoint': active.endpoint},
    );
    await push._unsubscribeLocalBestEffort(active);
  }

  Future<AuthSession> getSession() async {
    final json = await _requester.call('GET', '/api/auth/session');
    return AuthSession.fromJson(json);
  }

  Future<ChikAuthActionAccepted> requestEmailVerification() async {
    final json = await _requester.call(
      'POST',
      '/api/auth/send-verification-email',
      body: {},
    );
    return ChikAuthActionAccepted.fromJson(json);
  }

  Future<AuthUser> verifyEmail(String token) async {
    final json = await _requester.call(
      'POST',
      '/api/auth/verify-email',
      body: {'token': token},
    );
    return AuthUser.fromJson(_authObject(json['user']));
  }

  Future<ChikAuthActionAccepted> requestPasswordReset(String email) async {
    final json = await _requester.call(
      'POST',
      '/api/auth/send-password-reset',
      body: {'email': email},
    );
    return ChikAuthActionAccepted.fromJson(json);
  }

  Future<AuthUser> resetPassword(String token, String password) async {
    final json = await _requester.call(
      'POST',
      '/api/auth/reset-password',
      body: {'token': token, 'password': password},
    );
    return AuthUser.fromJson(_authObject(json['user']));
  }

  Future<Map<String, String>> startGitHub(String returnTo) async {
    final json = await _requester.call(
      'POST',
      '/api/auth/github/start',
      body: {'returnTo': returnTo},
    );
    return {'authorizationUrl': json['authorizationUrl'] as String};
  }

  Future<AuthSession> signInCustom(
    String providerKey,
    String credential,
  ) async {
    final encoded = Uri.encodeComponent(providerKey);
    final json = await _requester.call(
      'POST',
      '/api/auth/custom/$encoded',
      body: {'credential': credential},
    );
    return AuthSession.fromJson(json);
  }
}

/// A native application session record stored in an OS-backed secret store.
///
/// Active records contain Chickinfry application credentials, not provider
/// tokens. Cleanup-only records contain only an opaque session scope and are
/// consumed before credentials, users, or scope leases can be restored.
final class ChikNativeStoredSession {
  const ChikNativeStoredSession({
    required AuthUser user,
    required String sessionToken,
    required String refreshToken,
    required String expiresAt,
    required String refreshExpiresAt,
    required this.sessionScope,
  })  : _user = user,
        _sessionToken = sessionToken,
        _refreshToken = refreshToken,
        _expiresAt = expiresAt,
        _refreshExpiresAt = refreshExpiresAt,
        _cleanupOnly = false;

  const ChikNativeStoredSession._cleanupMarker({
    required this.sessionScope,
  })  : _user = null,
        _sessionToken = null,
        _refreshToken = null,
        _expiresAt = null,
        _refreshExpiresAt = null,
        _cleanupOnly = true;

  final AuthUser? _user;
  final String? _sessionToken;
  final String? _refreshToken;
  final String? _expiresAt;
  final String? _refreshExpiresAt;
  final bool _cleanupOnly;
  final String sessionScope;

  AuthUser get user => _user!;
  String get sessionToken => _sessionToken!;
  String get refreshToken => _refreshToken!;
  String get expiresAt => _expiresAt!;
  String get refreshExpiresAt => _refreshExpiresAt!;

  factory ChikNativeStoredSession.fromAuthSession(
    AuthSession session, {
    String? sessionScope,
  }) {
    final embeddedSessionScope = session._sessionScope;
    if (sessionScope != null &&
        embeddedSessionScope != null &&
        sessionScope != embeddedSessionScope) {
      throw ChikAuthError(
        ChikErrorCode.invalidArgument,
        'The explicit native session scope does not match the session response.',
        status: 400,
      );
    }
    final sessionToken = _requiredNativeCredential(
      session.sessionToken,
      'session token',
    );
    final refreshToken = _requiredNativeCredential(
      session.refreshToken,
      'refresh token',
    );
    final expiresAt =
        _requiredNativeCredential(session.expiresAt, 'expiration');
    final refreshExpiresAt = _requiredNativeCredential(
      session.refreshExpiresAt,
      'refresh expiration',
    );
    return ChikNativeStoredSession(
      user: session.user,
      sessionToken: sessionToken,
      refreshToken: refreshToken,
      expiresAt: expiresAt,
      refreshExpiresAt: refreshExpiresAt,
      sessionScope: _requiredNativeResponseSessionScope(
        sessionScope ?? embeddedSessionScope,
      ),
    );
  }

  factory ChikNativeStoredSession.fromJson(Map<String, Object?> json) {
    final kind = json['kind'];
    if (kind == 'cleanup') {
      return ChikNativeStoredSession._cleanupMarker(
        sessionScope: _requiredNativeSessionScope(json['sessionScope']),
      );
    }
    if (kind != null && kind != 'session') {
      throw ChikAuthError(
        ChikErrorCode.storageError,
        'The stored native session record type is invalid.',
        status: 0,
      );
    }
    return ChikNativeStoredSession(
      user: AuthUser.fromJson(_authObject(json['user'])),
      sessionToken: _requiredNativeCredential(
        json['sessionToken'] as String?,
        'session token',
      ),
      refreshToken: _requiredNativeCredential(
        json['refreshToken'] as String?,
        'refresh token',
      ),
      expiresAt: _requiredNativeCredential(
        json['expiresAt'] as String?,
        'expiration',
      ),
      refreshExpiresAt: _requiredNativeCredential(
        json['refreshExpiresAt'] as String?,
        'refresh expiration',
      ),
      sessionScope: _requiredNativeSessionScope(json['sessionScope']),
    );
  }

  AuthSession toAuthSession() {
    return AuthSession._(
      user: user,
      sessionToken: sessionToken,
      refreshToken: refreshToken,
      expiresAt: expiresAt,
      refreshExpiresAt: refreshExpiresAt,
      sessionScope: sessionScope,
    );
  }

  ChikNativeStoredSession copyWith({
    AuthUser? user,
    String? expiresAt,
  }) {
    return ChikNativeStoredSession(
      user: user ?? this.user,
      sessionToken: sessionToken,
      refreshToken: refreshToken,
      expiresAt: expiresAt ?? this.expiresAt,
      refreshExpiresAt: refreshExpiresAt,
      sessionScope: sessionScope,
    );
  }

  Map<String, Object?> toJson() {
    if (_cleanupOnly) {
      return <String, Object?>{
        'kind': 'cleanup',
        'sessionScope': sessionScope,
      };
    }
    return <String, Object?>{
      'kind': 'session',
      'user': <String, Object?>{
        'userId': user.userId,
        'projectId': user.projectId,
        'email': user.email,
        'emailVerified': user.emailVerified,
        'disabled': user.disabled,
        'createdAt': user.createdAt,
      },
      'sessionToken': sessionToken,
      'refreshToken': refreshToken,
      'expiresAt': expiresAt,
      'refreshExpiresAt': refreshExpiresAt,
      'sessionScope': sessionScope,
    };
  }
}

typedef ChikNativeSessionRead = Future<String?> Function();
typedef ChikNativeSessionWrite = Future<void> Function(String value);
typedef ChikNativeSessionDelete = Future<void> Function();
typedef ChikNativeSessionScopeDelete = Future<void> Function(
  String sessionScope,
);

/// Persists a complete native session in an OS-backed secret store.
///
/// [ChikNativeSessionStore.json] is the supported boundary for Flutter secure
/// storage packages without making one package a dependency of this runtime.
/// Pass the store's read, write, session delete, and scoped-state delete
/// callbacks; the runtime owns the session record and application code never
/// handles individual credentials. Reuse one store object, or pass the same
/// `coordinationKey` to adapters that target the same physical record.
abstract interface class ChikNativeSessionStore {
  factory ChikNativeSessionStore.json({
    required ChikNativeSessionRead read,
    required ChikNativeSessionWrite write,
    required ChikNativeSessionDelete delete,
    required ChikNativeSessionScopeDelete deleteSessionScope,
    Object? coordinationKey,
  }) = _ChikJsonNativeSessionStore;

  Future<ChikNativeStoredSession?> read();
  Future<void> write(ChikNativeStoredSession session);
  Future<void> clear();
  Future<void> clearSessionScope(String sessionScope);
}

/// Lets separate store adapters that target the same physical record share
/// native-auth ordering inside the current Dart isolate.
abstract interface class ChikNativeSessionStoreCoordination {
  /// Returns a shared key, or null to coordinate by store object identity.
  Object? get coordinationKey;
}

/// One native GitHub authorization attempt.
///
/// The transaction keeps OAuth state, the browser nonce, and optional PKCE
/// verifier private. Applications only open [authorizationUrl], pass a
/// received app-link callback to [complete], and receive an application
/// session.
final class ChikNativeGitHubOAuthTransaction {
  ChikNativeGitHubOAuthTransaction._({
    required ChikNativeAuth auth,
    required this.authorizationUrl,
    required this.redirectUri,
    required this.expiresAt,
    required String state,
    required String browserNonce,
    required String? pkceVerifier,
    required _ChikNativeAuthStamp stamp,
  })  : _auth = auth,
        _state = state,
        _browserNonce = browserNonce,
        _pkceVerifier = pkceVerifier,
        _stamp = stamp;

  final ChikNativeAuth _auth;
  final String _state;
  final String _browserNonce;
  final String? _pkceVerifier;
  final _ChikNativeAuthStamp _stamp;
  bool _completed = false;

  final String authorizationUrl;
  final String redirectUri;
  final String expiresAt;

  bool matchesRedirect(String redirectUrl) {
    try {
      _nativeGitHubRedirectValues(redirectUrl, redirectUri, _state);
      return true;
    } on ChikAuthError {
      return false;
    }
  }

  Future<AuthSession> complete(String redirectUrl) async {
    if (_completed) {
      throw ChikAuthError(
        ChikErrorCode.failedPrecondition,
        'The authorization flow is already complete.',
        status: 412,
      );
    }
    final values = _nativeGitHubRedirectValues(
      redirectUrl,
      redirectUri,
      _state,
    );
    _completed = true;
    return _auth._completeGitHubNativeOAuth(
      code: values.code,
      state: values.state,
      browserNonce: _browserNonce,
      pkceVerifier: _pkceVerifier,
      stamp: _stamp,
    );
  }
}

final class _ChikNativeGitHubRedirectValues {
  const _ChikNativeGitHubRedirectValues({
    required this.code,
    required this.state,
  });

  final String code;
  final String state;
}

final class _ChikNativeAuthStamp {
  const _ChikNativeAuthStamp({
    required this.epoch,
    required this.sessionScope,
    required this.sessionScopeLease,
  });

  final int epoch;
  final String? sessionScope;
  final ChikSessionScopeLease? sessionScopeLease;
}

final class _ChikNativeAuthInFlight {
  _ChikNativeAuthInFlight(this.stamp);

  final _ChikNativeAuthStamp stamp;
  late Future<AuthSession?> future;
}

final class _ChikNativeRefreshInFlight {
  _ChikNativeRefreshInFlight(this.reservedEpoch);

  final int reservedEpoch;
  int? epoch;
  late Future<ChikNativeStoredSession?> future;

  bool isCurrent(_ChikNativeSessionCoordinator coordinator) {
    return coordinator.epoch == (epoch ?? reservedEpoch);
  }
}

final class _ChikNativeSessionCoordinator {
  Future<void> tail = Future<void>.value();
  Future<void> refreshDecisionTail = Future<void>.value();
  int epoch = 0;
  _ChikNativeRefreshInFlight? refreshInFlight;
  String? activeSessionScope;
  ChikNativeStoredSession? activeSession;
  int credentialEpoch = 0;
  final List<WeakReference<ChikSessionScopeLease>> _leases =
      <WeakReference<ChikSessionScopeLease>>[];
  final Set<String> pendingSessionScopeCleanups = <String>{};

  int advance() {
    epoch += 1;
    return epoch;
  }

  void registerLease(ChikSessionScopeLease lease) {
    _leases.removeWhere((reference) => reference.target == null);
    _leases.add(WeakReference<ChikSessionScopeLease>(lease));
  }

  void activateSessionScope(String sessionScope) {
    if (activeSessionScope == sessionScope) return;
    invalidateSessionScope();
    activeSessionScope = sessionScope;
  }

  int publishSession(ChikNativeStoredSession session) {
    if (!identical(activeSession, session)) {
      activeSession = session;
      credentialEpoch += 1;
    }
    return credentialEpoch;
  }

  void suspendSessionCredentials(String sessionScope) {
    if (activeSessionScope != null && activeSessionScope != sessionScope) {
      invalidateSessionScope();
      return;
    }
    activeSession = null;
    credentialEpoch += 1;
  }

  void invalidateSessionScope() {
    for (final reference in _leases) {
      reference.target?.invalidate();
    }
    _leases.clear();
    activeSessionScope = null;
    activeSession = null;
    credentialEpoch += 1;
  }
}

final class _ChikNativeSessionCoordinatorEntry {
  _ChikNativeSessionCoordinatorEntry()
      : coordinator = _ChikNativeSessionCoordinator();

  final _ChikNativeSessionCoordinator coordinator;
  int owners = 0;
}

final class _ChikNativeSessionCoordinatorHandle {
  _ChikNativeSessionCoordinatorHandle._({
    required this.entry,
    this.stringKey,
    this.identityKey,
  }) {
    entry.owners += 1;
  }

  final _ChikNativeSessionCoordinatorEntry entry;
  final String? stringKey;
  final Object? identityKey;
  bool _released = false;

  _ChikNativeSessionCoordinator get coordinator => entry.coordinator;

  void release() {
    if (_released) return;
    _released = true;
    entry.owners -= 1;
    if (entry.owners != 0) return;
    final textKey = stringKey;
    if (textKey != null) {
      if (identical(_chikNativeSessionStringCoordinators[textKey], entry)) {
        _chikNativeSessionStringCoordinators.remove(textKey);
      }
      return;
    }
    final objectKey = identityKey;
    if (objectKey != null &&
        identical(_chikNativeSessionIdentityCoordinators[objectKey], entry)) {
      _chikNativeSessionIdentityCoordinators[objectKey] = null;
    }
  }
}

final Expando<_ChikNativeSessionCoordinatorEntry>
    _chikNativeSessionIdentityCoordinators =
    Expando<_ChikNativeSessionCoordinatorEntry>();
final Map<String, _ChikNativeSessionCoordinatorEntry>
    _chikNativeSessionStringCoordinators =
    <String, _ChikNativeSessionCoordinatorEntry>{};
final Finalizer<_ChikNativeSessionCoordinatorHandle>
    _chikNativeSessionCoordinatorFinalizer =
    Finalizer<_ChikNativeSessionCoordinatorHandle>((handle) {
  handle.release();
});

_ChikNativeSessionCoordinatorHandle _nativeSessionCoordinator(
  ChikNativeSessionStore store,
) {
  final coordination = store is ChikNativeSessionStoreCoordination
      ? store as ChikNativeSessionStoreCoordination
      : null;
  final key = coordination?.coordinationKey;
  if (key is String) {
    final entry = _chikNativeSessionStringCoordinators[key] ??=
        _ChikNativeSessionCoordinatorEntry();
    return _ChikNativeSessionCoordinatorHandle._(
      entry: entry,
      stringKey: key,
    );
  }
  final identityKey = key ?? store;
  final entry = _chikNativeSessionIdentityCoordinators[identityKey] ??=
      _ChikNativeSessionCoordinatorEntry();
  return _ChikNativeSessionCoordinatorHandle._(
    entry: entry,
    identityKey: identityKey,
  );
}

final class _ChikJsonNativeSessionStore
    implements ChikNativeSessionStore, ChikNativeSessionStoreCoordination {
  _ChikJsonNativeSessionStore({
    required ChikNativeSessionRead read,
    required ChikNativeSessionWrite write,
    required ChikNativeSessionDelete delete,
    required ChikNativeSessionScopeDelete deleteSessionScope,
    Object? coordinationKey,
  })  : _read = read,
        _write = write,
        _delete = delete,
        _deleteSessionScope = deleteSessionScope {
    _coordinationKey = coordinationKey;
  }

  final ChikNativeSessionRead _read;
  final ChikNativeSessionWrite _write;
  final ChikNativeSessionDelete _delete;
  final ChikNativeSessionScopeDelete _deleteSessionScope;
  late final Object? _coordinationKey;

  @override
  Object? get coordinationKey => _coordinationKey;

  @override
  Future<ChikNativeStoredSession?> read() async {
    final value = await _read();
    if (value == null || value.trim().isEmpty) return null;
    Object? decoded;
    try {
      decoded = jsonDecode(value);
      return ChikNativeStoredSession.fromJson(_authObject(decoded));
    } catch (error) {
      final sessionScope = _storedNativeSessionScope(decoded);
      final cleanupFailures = <Object>[];
      var sessionScopeCleared = sessionScope == null;
      if (sessionScope != null) {
        try {
          await _write(jsonEncode(
            ChikNativeStoredSession._cleanupMarker(
              sessionScope: sessionScope,
            ).toJson(),
          ));
        } catch (cleanupError) {
          cleanupFailures.add(cleanupError);
        }
        if (cleanupFailures.isEmpty) {
          try {
            await _deleteSessionScope(sessionScope);
            sessionScopeCleared = true;
          } catch (cleanupError) {
            cleanupFailures.add(cleanupError);
          }
        }
      }
      if (sessionScopeCleared) {
        try {
          await _delete();
        } catch (cleanupError) {
          cleanupFailures.add(cleanupError);
        }
      }
      if (cleanupFailures.isNotEmpty) {
        throw ChikAuthError(
          ChikErrorCode.storageError,
          'The invalid stored session could not be cleared.',
          status: 0,
          details: cleanupFailures,
          cause: error,
        );
      }
      return null;
    }
  }

  @override
  Future<void> write(ChikNativeStoredSession session) {
    return _write(jsonEncode(session.toJson()));
  }

  @override
  Future<void> clear() => _delete();

  @override
  Future<void> clearSessionScope(String sessionScope) {
    return _deleteSessionScope(sessionScope);
  }
}

/// Native application session lifecycle for Flutter and other Dart clients.
///
/// Call [restoreSession] before constructing authenticated application state,
/// then use `ChikClientOptions.nativeAuth(this)` for generated API, storage,
/// and realtime clients.
final class ChikNativeAuth {
  ChikNativeAuth({
    required String baseUrl,
    required ChikNativeSessionStore sessionStore,
    this.apiKey,
    this.headers = const {},
    this.fetch,
  })  : _baseUrl = baseUrl,
        _sessionStore = sessionStore,
        _coordinatorHandle = _nativeSessionCoordinator(sessionStore) {
    _chikNativeSessionCoordinatorFinalizer.attach(
      this,
      _coordinatorHandle,
      detach: this,
    );
  }

  static const _refreshLeeway = Duration(seconds: 60);

  final String _baseUrl;
  final ChikNativeSessionStore _sessionStore;
  final _ChikNativeSessionCoordinatorHandle _coordinatorHandle;
  final String? apiKey;
  final Map<String, String> headers;
  final ChikAuthFetch? fetch;
  ChikNativeStoredSession? _storedSession;
  bool _sessionStoreLoaded = false;
  int? _sessionStoreEpoch;
  bool _sessionValidated = false;
  int? _credentialEpoch;
  bool _disposed = false;
  _ChikNativeAuthInFlight? _restoreInFlight;
  ChikSessionScopeLease? _sessionScopeLease;
  int _pendingSessionWrites = 0;
  bool _sessionStoreMayContainStaleSession = false;
  String? _pendingCleanupMarkerWrite;

  /// Supplies the latest credential without exposing stored credentials to
  /// normal application code.
  ChikSessionTokenProvider get sessionTokenProvider => _currentSessionToken;

  ChikSessionScopeProvider get sessionScopeProvider => _currentSessionScope;

  ChikSessionScopeLeaseProvider get sessionScopeLeaseProvider =>
      _currentSessionScopeLease;

  ChikSessionTokenRefresher get sessionTokenRefresher => _refreshSessionToken;

  String get baseUrl => _baseUrl;

  bool get hasSession => _isSessionCacheCurrent && _storedSession != null;

  AuthUser? get currentUser =>
      _isSessionCacheCurrent ? _storedSession?.user : null;

  /// Releases this auth object's process-local coordination ownership.
  ///
  /// In-flight shared storage work is allowed to settle before the registry
  /// entry is released. A disposed auth object cannot be used again.
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _sessionValidated = false;
    _credentialEpoch = null;
    _storedSession = null;
    _sessionScopeLease?.invalidate();
    _sessionScopeLease = null;
    _chikNativeSessionCoordinatorFinalizer.detach(this);
    final storeTail = _coordinator.tail;
    final refreshDecisionTail = _coordinator.refreshDecisionTail;
    await Future.wait<void>(<Future<void>>[
      storeTail,
      refreshDecisionTail,
    ]);
    _coordinatorHandle.release();
  }

  _ChikNativeSessionCoordinator get _coordinator =>
      _coordinatorHandle.coordinator;

  Future<AuthSession> signIn(String email, String password) async {
    final stamp = await _beginOperation(prepareReplacement: true);
    Map<String, Object?> json;
    try {
      json = await _requester().call(
        'POST',
        '/api/auth/native/sign-in',
        body: {'email': email, 'password': password},
      );
    } catch (error, stackTrace) {
      _requireCurrent(stamp);
      Error.throwWithStackTrace(error, stackTrace);
    }
    _requireCurrent(stamp);
    return _acceptStoredSession(
      ChikNativeStoredSession.fromAuthSession(
        AuthSession._fromNativeJson(json),
      ),
      stamp,
    );
  }

  /// Starts a GitHub authorization attempt for a native application.
  ///
  /// Open [ChikNativeGitHubOAuthTransaction.authorizationUrl] in the system
  /// browser, then pass the registered HTTPS app-link callback to
  /// [ChikNativeGitHubOAuthTransaction.complete]. Provider credentials never
  /// enter the application process.
  Future<ChikNativeGitHubOAuthTransaction> startGitHubNative() async {
    final stamp = await _beginOperation(prepareReplacement: true);
    Map<String, Object?> json;
    try {
      json = await _requester().call(
        'POST',
        '/api/auth/native/github/start',
        body: const <String, Object?>{},
      );
    } catch (error, stackTrace) {
      _requireCurrent(stamp);
      Error.throwWithStackTrace(error, stackTrace);
    }
    _requireCurrent(stamp);
    final authorizationUrl = _requiredNativeOAuthText(
      json['authorizationUrl'],
      'authorization URL',
    );
    final state = _requiredNativeOAuthText(json['state'], 'state');
    final browserNonce = _requiredNativeOAuthText(
      json['browserNonce'],
      'browser nonce',
    );
    final expiresAt = _requiredNativeOAuthText(json['expiresAt'], 'expiration');
    final redirectUri = _requiredNativeOAuthText(
      json['redirectUri'],
      'redirect URI',
    );
    final rawPkceVerifier = json['pkceVerifier'];
    if (rawPkceVerifier != null && rawPkceVerifier is! String) {
      throw ChikAuthError(
        ChikErrorCode.invalidResponse,
        'Native authorization response contains an invalid PKCE verifier.',
        status: 502,
      );
    }
    final pkceVerifier =
        rawPkceVerifier is String && rawPkceVerifier.trim().isNotEmpty
            ? rawPkceVerifier.trim()
            : null;
    return ChikNativeGitHubOAuthTransaction._(
      auth: this,
      authorizationUrl: authorizationUrl,
      redirectUri: redirectUri,
      expiresAt: expiresAt,
      state: state,
      browserNonce: browserNonce,
      pkceVerifier: pkceVerifier,
      stamp: stamp,
    );
  }

  /// Stores a completed native sign-in, OAuth, identity-credential, or device
  /// approval result as the current application session.
  Future<AuthSession> acceptSession(
    AuthSession session, {
    String? sessionScope,
  }) async {
    final stored = ChikNativeStoredSession.fromAuthSession(
      session,
      sessionScope: sessionScope,
    );
    return _acceptStoredSession(
      stored,
      await _beginOperation(prepareReplacement: true),
    );
  }

  /// Restores the persisted session, refreshing it once when it is near expiry
  /// or no longer accepted by the safe session-read request.
  Future<AuthSession?> restoreSession() async {
    var stamp = await _currentOperationStamp();
    final current = _restoreInFlight;
    if (current != null && _sameStamp(current.stamp, stamp)) {
      return current.future;
    }
    if (_storedSession != null) {
      _sessionValidated = false;
      stamp = _currentStamp();
    }
    final inFlight = _ChikNativeAuthInFlight(stamp);
    inFlight.future = _restoreSession(stamp).whenComplete(() {
      if (identical(_restoreInFlight, inFlight)) _restoreInFlight = null;
    });
    _restoreInFlight = inFlight;
    return inFlight.future;
  }

  /// Restores a session after the application returns to the foreground.
  Future<AuthSession?> onAppForeground() => restoreSession();

  Future<AuthSession?> _restoreSession(_ChikNativeAuthStamp stamp) async {
    _requireCurrent(stamp);
    final stored = _storedSession;
    if (stored == null) return null;
    if (_needsRefresh(stored.expiresAt)) {
      return _refreshSessionForStamp(stamp);
    }
    try {
      return await _readRemoteSession(stored, stamp);
    } on ChikAuthError catch (error) {
      if (error.status == 401) {
        _requireCurrent(stamp);
        return _refreshSessionForStamp(stamp);
      }
      rethrow;
    }
  }

  /// Refreshes the current session once across concurrent callers.
  ///
  /// A failed refresh clears the local session before the error is returned.
  /// This method does not replay application mutations.
  Future<AuthSession?> refreshSession() => _refreshSessionForStamp(null);

  Future<AuthSession?> _refreshSessionForStamp(
    _ChikNativeAuthStamp? stamp,
  ) async {
    return _adoptSharedRefresh(await _selectSharedRefresh(stamp));
  }

  Future<_ChikNativeRefreshInFlight> _selectSharedRefresh(
    _ChikNativeAuthStamp? stamp,
  ) {
    final result = _coordinator.refreshDecisionTail.then((_) {
      _requireNotDisposed();
      final current = _coordinator.refreshInFlight;
      if (current != null && current.isCurrent(_coordinator)) {
        return current;
      }
      if (stamp != null) _requireCurrent(stamp);
      final inFlight = _ChikNativeRefreshInFlight(_coordinator.epoch);
      _coordinator.refreshInFlight = inFlight;
      inFlight.future = _queueSessionStore(
        () {
          _requireEpoch(inFlight.reservedEpoch);
          final epoch = _coordinator.advance();
          inFlight.epoch = epoch;
          return _refreshLatestStoredSessionAtHead(epoch);
        },
      ).whenComplete(() {
        if (identical(_coordinator.refreshInFlight, inFlight)) {
          _coordinator.refreshInFlight = null;
        }
      });
      return inFlight;
    });
    _coordinator.refreshDecisionTail = result.then<void>(
      (_) {},
      onError: (Object _, StackTrace __) {},
    );
    return result;
  }

  Future<AuthSession?> _adoptSharedRefresh(
    _ChikNativeRefreshInFlight inFlight,
  ) async {
    final stored = await inFlight.future;
    _requireNotDisposed();
    final epoch = inFlight.epoch!;
    _requireEpoch(epoch);
    _activateStoredSession(stored, epoch);
    return stored?.toAuthSession();
  }

  Future<ChikNativeStoredSession?> _refreshLatestStoredSessionAtHead(
    int epoch,
  ) async {
    _requireEpoch(epoch);
    late final ChikNativeStoredSession? stored;
    try {
      stored = await _sessionStore.read();
    } catch (error) {
      _requireEpoch(epoch);
      throw ChikAuthError(
        ChikErrorCode.storageError,
        'The stored session could not be read before refresh.',
        status: 0,
        details: error,
      );
    }
    _requireEpoch(epoch);
    if (stored == null) return null;
    if (stored._cleanupOnly) {
      await _clearPersistedCleanupMarkerAtHead(stored.sessionScope, epoch);
      return null;
    }
    if (_isExpired(stored.refreshExpiresAt)) {
      await _clearPersistedSessionAtHead(stored, epoch);
      return null;
    }
    try {
      await _sessionStore.write(
        ChikNativeStoredSession._cleanupMarker(
          sessionScope: stored.sessionScope,
        ),
      );
    } catch (error) {
      _requireEpoch(epoch);
      throw ChikAuthError(
        ChikErrorCode.storageError,
        'The refresh cleanup marker could not be saved securely.',
        status: 0,
        details: error,
      );
    }
    _requireEpoch(epoch);
    _coordinator.suspendSessionCredentials(stored.sessionScope);
    try {
      final json = await _requester().call(
        'POST',
        '/api/auth/refresh',
        body: {'refreshToken': stored.refreshToken},
      );
      _requireEpoch(epoch);
      final refreshed = ChikNativeStoredSession.fromAuthSession(
        AuthSession.fromJson(json),
        sessionScope: stored.sessionScope,
      );
      try {
        await _sessionStore.write(refreshed);
      } catch (error) {
        _requireEpoch(epoch);
        throw ChikAuthError(
          ChikErrorCode.storageError,
          'The refreshed session could not be saved securely.',
          status: 0,
          details: error,
        );
      }
      _requireEpoch(epoch);
      return refreshed;
    } catch (error, stackTrace) {
      _requireEpoch(epoch);
      _coordinator.invalidateSessionScope();
      try {
        await _clearPersistedCleanupMarkerAtHead(stored.sessionScope, epoch);
      } catch (clearError, clearStackTrace) {
        if (clearError is ChikAuthError &&
            clearError.code == ChikErrorCode.aborted) {
          Error.throwWithStackTrace(clearError, clearStackTrace);
        }
        throw ChikAuthError(
          ChikErrorCode.storageError,
          'The local session could not be cleared after refresh failed.',
          status: 0,
          details: clearError,
        );
      }
      _requireEpoch(epoch);
      Error.throwWithStackTrace(error, stackTrace);
    }
  }

  /// Returns the validated current session or throws when no session remains.
  Future<AuthSession> getSession() async {
    final session = await restoreSession();
    if (session != null) return session;
    throw ChikAuthError(
      ChikErrorCode.unauthenticated,
      ChikErrorMessage.customerSessionRequired,
      status: 401,
    );
  }

  /// Persists a cleanup-only marker before revoking the remote session.
  ///
  /// The marker prevents interrupted sign-out from restoring credentials and
  /// retains only the local scope required to resume cleanup.
  Future<void> signOut([ChikPushSubscription? subscription]) async {
    final stamp = await _beginOperation();
    final stored = _storedSession;
    if (stored == null) {
      if (_pendingSessionWrites > 0 || _sessionStoreMayContainStaleSession) {
        final clearedStamp = await _clearStoredSession(stamp);
        _requireCurrent(clearedStamp);
      }
      return;
    }
    late final _ChikNativeAuthStamp cleanupStamp;
    Object? markerError;
    try {
      cleanupStamp = await _stageStoredSessionCleanup(stamp);
    } catch (error, stackTrace) {
      if (error is ChikAuthError && error.code == ChikErrorCode.aborted) {
        Error.throwWithStackTrace(error, stackTrace);
      }
      markerError = error;
      cleanupStamp = _currentStamp();
    }
    final active = subscription;
    Object? revokeError;
    StackTrace? revokeStackTrace;
    try {
      await _requester().call(
        'POST',
        '/api/auth/sign-out',
        body: {
          'refreshToken': stored.refreshToken,
          if (active != null) 'pushEndpoint': active.endpoint,
        },
      );
    } on ChikAuthError catch (error, stackTrace) {
      _requireCurrent(cleanupStamp);
      if (error.status != 401) {
        revokeError = error;
        revokeStackTrace = stackTrace;
      }
      // An already-invalid remote credential still requires local scoped cleanup.
    } catch (error, stackTrace) {
      _requireCurrent(cleanupStamp);
      revokeError = error;
      revokeStackTrace = stackTrace;
    }
    _requireCurrent(cleanupStamp);
    if (markerError == null && revokeError != null) {
      Error.throwWithStackTrace(revokeError, revokeStackTrace!);
    }
    if (revokeError == null) {
      try {
        await active?.localUnsubscribe?.call();
      } catch (_) {
        // Local push cleanup is retryable after the server session is revoked.
      }
    }
    _requireCurrent(cleanupStamp);
    late final _ChikNativeAuthStamp clearedStamp;
    if (markerError == null) {
      clearedStamp = await _reconcileSessionStore(
        cleanupStamp,
        requiredCleanupScope: stored.sessionScope,
      );
    } else {
      try {
        clearedStamp = await _clearAfterCleanupMarkerFailure(
          cleanupStamp,
          stored.sessionScope,
        );
      } catch (clearError, clearStackTrace) {
        if (clearError is ChikAuthError &&
            clearError.code == ChikErrorCode.aborted) {
          Error.throwWithStackTrace(clearError, clearStackTrace);
        }
        throw ChikAuthError(
          ChikErrorCode.storageError,
          'The local session could not be cleared securely.',
          status: 0,
          details: <Object>[
            markerError,
            clearError,
            if (revokeError != null) revokeError,
          ],
        );
      }
    }
    _requireCurrent(clearedStamp);
    if (revokeError != null) {
      Error.throwWithStackTrace(revokeError, revokeStackTrace!);
    }
  }

  Future<AuthSession> _readRemoteSession(
    ChikNativeStoredSession stored,
    _ChikNativeAuthStamp stamp,
  ) async {
    Map<String, Object?> json;
    try {
      json = await _requester(sessionToken: stored.sessionToken)
          .call('GET', '/api/auth/session');
    } catch (error, stackTrace) {
      _requireCurrent(stamp);
      Error.throwWithStackTrace(error, stackTrace);
    }
    _requireCurrent(stamp);
    final remote = AuthSession.fromJson(json);
    return _queueSessionStore(() async {
      _requireCurrent(stamp);
      final current = _storedSession!;
      final updated = current.copyWith(
        user: remote.user,
        expiresAt: remote.expiresAt,
      );
      await _writeStoredSessionAtHead(updated, stamp);
      return updated.toAuthSession();
    });
  }

  Future<AuthSession> _completeGitHubNativeOAuth({
    required String code,
    required String state,
    required String browserNonce,
    required String? pkceVerifier,
    required _ChikNativeAuthStamp stamp,
  }) async {
    _requireCurrent(stamp);
    Map<String, Object?> json;
    try {
      json = await _requester().call(
        'POST',
        '/api/auth/native/github/complete',
        body: <String, Object?>{
          'code': code,
          'state': state,
          'browserNonce': browserNonce,
          if (pkceVerifier != null) 'pkceVerifier': pkceVerifier,
        },
      );
    } catch (error, stackTrace) {
      _requireCurrent(stamp);
      Error.throwWithStackTrace(error, stackTrace);
    }
    _requireCurrent(stamp);
    return _acceptStoredSession(
      ChikNativeStoredSession.fromAuthSession(
        AuthSession._fromNativeJson(json),
      ),
      stamp,
    );
  }

  _ChikAuthRequester _requester({String? sessionToken}) {
    return _ChikAuthRequester.http(
      baseUrl: _baseUrl,
      apiKey: apiKey,
      sessionToken: sessionToken,
      headers: headers,
      fetch: fetch,
    );
  }

  Future<AuthSession> _acceptStoredSession(
    ChikNativeStoredSession stored,
    _ChikNativeAuthStamp stamp,
  ) async {
    _requireCurrent(stamp);
    await _writeStoredSession(stored, stamp);
    return stored.toAuthSession();
  }

  Future<_ChikNativeAuthStamp> _beginOperation({
    bool prepareReplacement = false,
  }) async {
    _requireNotDisposed();
    _coordinator.invalidateSessionScope();
    _sessionScopeLease?.invalidate();
    _sessionValidated = false;
    _credentialEpoch = null;
    final epoch = _coordinator.advance();
    var stamp = await _operationStampAfterLoad(
      epoch,
      allowCleanupDebt: prepareReplacement,
    );
    if (!prepareReplacement &&
        (_pendingSessionWrites > 0 ||
            _sessionStoreMayContainStaleSession ||
            _coordinator.pendingSessionScopeCleanups.isNotEmpty ||
            _pendingCleanupMarkerWrite != null)) {
      stamp = await _reconcileSessionStore(stamp);
    }
    if (prepareReplacement && _storedSession != null) {
      return _stageStoredSessionCleanup(stamp);
    }
    return stamp;
  }

  Future<_ChikNativeAuthStamp> _currentOperationStamp() {
    _requireNotDisposed();
    return _operationStampAfterLoad(_coordinator.epoch);
  }

  Future<_ChikNativeAuthStamp> _operationStampAfterLoad(
    int epoch, {
    bool allowCleanupDebt = false,
  }) async {
    await _loadStoredSession(epoch, allowCleanupDebt: allowCleanupDebt);
    _requireEpoch(epoch);
    return _currentStamp();
  }

  _ChikNativeAuthStamp _currentStamp() {
    return _ChikNativeAuthStamp(
      epoch: _coordinator.epoch,
      sessionScope: _storedSession?.sessionScope,
      sessionScopeLease: _sessionScopeLease,
    );
  }

  bool _sameStamp(
    _ChikNativeAuthStamp first,
    _ChikNativeAuthStamp second,
  ) {
    return first.epoch == second.epoch &&
        first.sessionScope == second.sessionScope &&
        identical(first.sessionScopeLease, second.sessionScopeLease);
  }

  void _requireCurrent(_ChikNativeAuthStamp stamp) {
    _requireNotDisposed();
    if (!_sameStamp(stamp, _currentStamp())) {
      throw ChikAuthError(
        ChikErrorCode.aborted,
        ChikErrorMessage.authenticationOperationSuperseded,
        status: 409,
      );
    }
  }

  void _requireNotDisposed() {
    if (_disposed) {
      throw ChikAuthError(
        ChikErrorCode.failedPrecondition,
        'The native authentication object has been disposed.',
        status: 412,
      );
    }
  }

  void _requireEpoch(int epoch) {
    if (_coordinator.epoch != epoch) {
      throw ChikAuthError(
        ChikErrorCode.aborted,
        ChikErrorMessage.authenticationOperationSuperseded,
        status: 409,
      );
    }
  }

  Future<T> _queueSessionStore<T>(Future<T> Function() operation) {
    final result = _coordinator.tail.then((_) => operation());
    _coordinator.tail = result.then<void>(
      (_) {},
      onError: (Object _, StackTrace __) {},
    );
    return result;
  }

  Future<ChikNativeStoredSession?> _loadStoredSession(
    int epoch, {
    bool allowCleanupDebt = false,
  }) {
    if (_sessionStoreLoaded && _sessionStoreEpoch == epoch) {
      _requireEpoch(epoch);
      return Future<ChikNativeStoredSession?>.value(_storedSession);
    }
    return _queueSessionStore(() async {
      _requireEpoch(epoch);
      if (_sessionStoreLoaded && _sessionStoreEpoch == epoch) {
        return _storedSession;
      }
      ChikNativeStoredSession? stored;
      try {
        stored = await _sessionStore.read();
      } catch (error) {
        _requireEpoch(epoch);
        throw ChikAuthError(
          ChikErrorCode.storageError,
          'The stored session could not be read.',
          status: 0,
          details: error,
        );
      }
      _requireEpoch(epoch);
      var cleanupMarkerDeferred = false;
      if (stored?._cleanupOnly ?? false) {
        if (allowCleanupDebt) {
          await _deferPersistedCleanupMarkerAtHead(stored!.sessionScope, epoch);
          cleanupMarkerDeferred = true;
        } else {
          await _clearPersistedCleanupMarkerAtHead(stored!.sessionScope, epoch);
        }
        stored = null;
      }
      _requireEpoch(epoch);
      if (stored == null ||
          _sessionScopeLease?.sessionScope != stored.sessionScope ||
          !(_sessionScopeLease?.isActive ?? false)) {
        _sessionScopeLease?.invalidate();
        _sessionScopeLease = null;
      }
      _storedSession = stored;
      _sessionValidated = false;
      _credentialEpoch = null;
      _sessionStoreLoaded = true;
      _sessionStoreEpoch = epoch;
      _sessionStoreMayContainStaleSession = cleanupMarkerDeferred;
      return stored;
    });
  }

  Future<void> _clearPersistedCleanupMarkerAtHead(
    String sessionScope,
    int epoch,
  ) async {
    _sessionStoreMayContainStaleSession = true;
    _coordinator.pendingSessionScopeCleanups.add(sessionScope);
    try {
      await _sessionStore.clearSessionScope(sessionScope);
      _coordinator.pendingSessionScopeCleanups.remove(sessionScope);
    } catch (error) {
      _requireEpoch(epoch);
      throw ChikAuthError(
        ChikErrorCode.storageError,
        'The pending session scope could not be cleared.',
        status: 0,
        details: error,
      );
    }
    _requireEpoch(epoch);
    try {
      await _sessionStore.clear();
    } catch (error) {
      _requireEpoch(epoch);
      throw ChikAuthError(
        ChikErrorCode.storageError,
        'The pending session cleanup marker could not be cleared.',
        status: 0,
        details: error,
      );
    }
    _requireEpoch(epoch);
    _sessionStoreMayContainStaleSession = false;
  }

  Future<void> _deferPersistedCleanupMarkerAtHead(
    String sessionScope,
    int epoch,
  ) async {
    _sessionStoreMayContainStaleSession = true;
    _coordinator.pendingSessionScopeCleanups.add(sessionScope);
    try {
      await _sessionStore.clearSessionScope(sessionScope);
      _coordinator.pendingSessionScopeCleanups.remove(sessionScope);
    } catch (_) {
      // The cleanup marker remains until a replacement session is stored.
    }
    _requireEpoch(epoch);
  }

  Future<void> _clearPersistedSessionAtHead(
    ChikNativeStoredSession stored,
    int epoch,
  ) async {
    _requireEpoch(epoch);
    try {
      await _sessionStore.write(
        ChikNativeStoredSession._cleanupMarker(
          sessionScope: stored.sessionScope,
        ),
      );
    } catch (error) {
      _requireEpoch(epoch);
      throw ChikAuthError(
        ChikErrorCode.storageError,
        'The session cleanup marker could not be saved securely.',
        status: 0,
        details: error,
      );
    }
    _requireEpoch(epoch);
    await _clearPersistedCleanupMarkerAtHead(stored.sessionScope, epoch);
  }

  Future<void> _writeStoredSession(
    ChikNativeStoredSession session,
    _ChikNativeAuthStamp stamp,
  ) {
    _pendingSessionWrites += 1;
    final operation = _queueSessionStore(() async {
      _requireCurrent(stamp);
      await _retryPendingSessionScopeCleanupsAtHead(
        stamp,
      );
      await _writeStoredSessionAtHead(session, stamp);
    });
    return operation.whenComplete(() => _pendingSessionWrites -= 1);
  }

  Future<_ChikNativeAuthStamp> _stageStoredSessionCleanup(
    _ChikNativeAuthStamp stamp,
  ) {
    _requireCurrent(stamp);
    final sessionScope = stamp.sessionScope;
    if (sessionScope == null) {
      return Future<_ChikNativeAuthStamp>.value(stamp);
    }
    _coordinator.invalidateSessionScope();
    _sessionScopeLease?.invalidate();
    _sessionScopeLease = null;
    _sessionValidated = false;
    _credentialEpoch = null;
    _storedSession = null;
    _sessionStoreLoaded = true;
    _sessionStoreEpoch = _coordinator.epoch;
    _sessionStoreMayContainStaleSession = true;
    _coordinator.pendingSessionScopeCleanups.add(sessionScope);
    _pendingCleanupMarkerWrite = sessionScope;
    final cleanupStamp = _currentStamp();
    _pendingSessionWrites += 1;
    final operation = _queueSessionStore(() async {
      _requireCurrent(cleanupStamp);
      try {
        await _sessionStore.write(
          ChikNativeStoredSession._cleanupMarker(
            sessionScope: sessionScope,
          ),
        );
        if (_pendingCleanupMarkerWrite == sessionScope) {
          _pendingCleanupMarkerWrite = null;
        }
      } catch (error) {
        _requireCurrent(cleanupStamp);
        throw ChikAuthError(
          ChikErrorCode.storageError,
          'The session cleanup marker could not be saved securely.',
          status: 0,
          details: error,
        );
      }
      _requireCurrent(cleanupStamp);
      return cleanupStamp;
    });
    return operation.whenComplete(() => _pendingSessionWrites -= 1);
  }

  Future<_ChikNativeAuthStamp> _reconcileSessionStore(
    _ChikNativeAuthStamp stamp, {
    String? requiredCleanupScope,
  }) {
    final stored = _storedSession;
    return _queueSessionStore(() async {
      _requireCurrent(stamp);
      _sessionStoreMayContainStaleSession = true;
      await _retryPendingCleanupMarkerWriteAtHead(stamp);
      await _retryPendingSessionScopeCleanupsAtHead(
        stamp,
        requiredScope: requiredCleanupScope,
      );
      try {
        if (stored == null) {
          await _sessionStore.clear();
        } else {
          await _sessionStore.write(stored);
        }
      } catch (error) {
        _requireCurrent(stamp);
        throw ChikAuthError(
          ChikErrorCode.storageError,
          'The stored session could not be reconciled securely.',
          status: 0,
          details: error,
        );
      }
      _requireCurrent(stamp);
      _sessionStoreMayContainStaleSession = false;
      _sessionStoreEpoch = _coordinator.epoch;
      return stamp;
    });
  }

  Future<_ChikNativeAuthStamp> _clearAfterCleanupMarkerFailure(
    _ChikNativeAuthStamp stamp,
    String sessionScope,
  ) {
    return _queueSessionStore(() async {
      _requireCurrent(stamp);
      var markerPersisted = false;
      Object? markerFailure;
      try {
        await _sessionStore.write(
          ChikNativeStoredSession._cleanupMarker(
            sessionScope: sessionScope,
          ),
        );
        markerPersisted = true;
        if (_pendingCleanupMarkerWrite == sessionScope) {
          _pendingCleanupMarkerWrite = null;
        }
      } catch (error) {
        markerFailure = error;
      }

      _requireCurrent(stamp);
      Object? scopeFailure;
      try {
        await _sessionStore.clearSessionScope(sessionScope);
        _coordinator.pendingSessionScopeCleanups.remove(sessionScope);
      } catch (error) {
        scopeFailure = error;
      }

      _requireCurrent(stamp);
      Object? clearFailure;
      if (!markerPersisted || scopeFailure == null) {
        try {
          await _sessionStore.clear();
          if (_pendingCleanupMarkerWrite == sessionScope) {
            _pendingCleanupMarkerWrite = null;
          }
        } catch (error) {
          clearFailure = error;
        }
      }

      _requireCurrent(stamp);
      if (scopeFailure != null || clearFailure != null) {
        throw ChikAuthError(
          ChikErrorCode.storageError,
          'The session cleanup fallback could not be completed.',
          status: 0,
          details: <Object>[
            if (markerFailure != null) markerFailure,
            if (scopeFailure != null) scopeFailure,
            if (clearFailure != null) clearFailure,
          ],
        );
      }
      _sessionStoreMayContainStaleSession = false;
      _sessionStoreEpoch = _coordinator.epoch;
      return stamp;
    });
  }

  Future<void> _retryPendingCleanupMarkerWriteAtHead(
    _ChikNativeAuthStamp stamp,
  ) async {
    final sessionScope = _pendingCleanupMarkerWrite;
    if (sessionScope == null) return;
    _requireCurrent(stamp);
    try {
      await _sessionStore.write(
        ChikNativeStoredSession._cleanupMarker(
          sessionScope: sessionScope,
        ),
      );
      if (_pendingCleanupMarkerWrite == sessionScope) {
        _pendingCleanupMarkerWrite = null;
      }
    } catch (error) {
      _requireCurrent(stamp);
      throw ChikAuthError(
        ChikErrorCode.storageError,
        'The session cleanup marker could not be saved securely.',
        status: 0,
        details: error,
      );
    }
    _requireCurrent(stamp);
  }

  Future<void> _retryPendingSessionScopeCleanupsAtHead(
    _ChikNativeAuthStamp stamp, {
    String? requiredScope,
  }) async {
    final failures = <Object>[];
    var requiredScopeFailed = false;
    for (final sessionScope
        in List<String>.of(_coordinator.pendingSessionScopeCleanups)) {
      _requireCurrent(stamp);
      try {
        await _sessionStore.clearSessionScope(sessionScope);
        _coordinator.pendingSessionScopeCleanups.remove(sessionScope);
      } catch (error) {
        failures.add(error);
        if (sessionScope == requiredScope) requiredScopeFailed = true;
      }
    }
    _requireCurrent(stamp);
    if (requiredScopeFailed) {
      throw ChikAuthError(
        ChikErrorCode.storageError,
        'Pending session scope cleanup could not be completed.',
        status: 0,
        details: failures,
      );
    }
  }

  Future<void> _writeStoredSessionAtHead(
    ChikNativeStoredSession session,
    _ChikNativeAuthStamp stamp,
  ) async {
    _requireCurrent(stamp);
    _sessionStoreMayContainStaleSession = true;
    try {
      await _sessionStore.write(session);
    } catch (error) {
      _requireCurrent(stamp);
      throw ChikAuthError(
        ChikErrorCode.storageError,
        'The session could not be saved securely.',
        status: 0,
        details: error,
      );
    }
    _requireCurrent(stamp);
    _pendingCleanupMarkerWrite = null;
    _activateStoredSession(session, _coordinator.epoch);
  }

  void _activateStoredSession(
    ChikNativeStoredSession? session,
    int epoch,
  ) {
    _requireEpoch(epoch);
    var registerLease = false;
    if (session == null) {
      _coordinator.invalidateSessionScope();
      _sessionScopeLease?.invalidate();
      _sessionScopeLease = null;
      _credentialEpoch = _coordinator.credentialEpoch;
    } else {
      _coordinator.activateSessionScope(session.sessionScope);
      if (_sessionScopeLease == null ||
          !_sessionScopeLease!.isActive ||
          _sessionScopeLease!.sessionScope != session.sessionScope) {
        _sessionScopeLease?.invalidate();
        _sessionScopeLease = ChikSessionScopeLease(session.sessionScope);
        registerLease = true;
      }
      _credentialEpoch = _coordinator.publishSession(session);
    }
    final lease = _sessionScopeLease;
    if (registerLease && lease != null) _coordinator.registerLease(lease);
    _storedSession = session;
    _sessionValidated = session != null;
    _sessionStoreLoaded = true;
    _sessionStoreEpoch = epoch;
    _sessionStoreMayContainStaleSession = false;
  }

  Future<_ChikNativeAuthStamp> _clearStoredSession(
    _ChikNativeAuthStamp stamp,
  ) async {
    final sessionScope = stamp.sessionScope;
    final cleanupStamp = await _stageStoredSessionCleanup(stamp);
    return _reconcileSessionStore(
      cleanupStamp,
      requiredCleanupScope: sessionScope,
    );
  }

  bool get _isSessionScopeCurrent =>
      !_disposed &&
      _sessionStoreLoaded &&
      _sessionValidated &&
      (_sessionScopeLease?.isActive ?? false) &&
      _storedSession?.sessionScope == _coordinator.activeSessionScope;

  bool get _isSessionCacheCurrent =>
      _isSessionScopeCurrent && _synchronizeSharedSession();

  bool _synchronizeSharedSession() {
    if (!_sessionValidated ||
        !(_sessionScopeLease?.isActive ?? false) ||
        _credentialEpoch == _coordinator.credentialEpoch) {
      return true;
    }
    final shared = _coordinator.activeSession;
    if (shared == null || shared.sessionScope != _storedSession?.sessionScope) {
      return false;
    }
    _storedSession = shared;
    _credentialEpoch = _coordinator.credentialEpoch;
    return true;
  }

  String? _currentSessionToken() =>
      _isSessionCacheCurrent ? _storedSession?.sessionToken : null;

  String? _currentSessionScope() =>
      _isSessionScopeCurrent ? _storedSession?.sessionScope : null;

  ChikSessionScopeLease? _currentSessionScopeLease() =>
      _isSessionScopeCurrent ? _sessionScopeLease : null;

  Future<String?> _refreshSessionToken(
    String expectedSessionScope,
    ChikSessionScopeLease expectedLease,
  ) async {
    if (!_isSessionScopeCurrent ||
        !identical(_sessionScopeLease, expectedLease) ||
        expectedLease.sessionScope != expectedSessionScope) {
      throw ChikAuthError(
        ChikErrorCode.aborted,
        ChikErrorMessage.authenticationOperationSuperseded,
        status: 409,
      );
    }
    final stamp = _currentStamp();
    final session = await _refreshSessionForStamp(stamp);
    if (!_isSessionScopeCurrent ||
        !identical(_sessionScopeLease, expectedLease)) {
      throw ChikAuthError(
        ChikErrorCode.aborted,
        ChikErrorMessage.authenticationOperationSuperseded,
        status: 409,
      );
    }
    return session?.sessionToken;
  }

  static bool _needsRefresh(String value) {
    final expiry = DateTime.tryParse(value)?.toUtc();
    if (expiry == null) return true;
    return !expiry.isAfter(DateTime.now().toUtc().add(_refreshLeeway));
  }

  static bool _isExpired(String value) {
    final expiry = DateTime.tryParse(value)?.toUtc();
    return expiry == null || !expiry.isAfter(DateTime.now().toUtc());
  }
}

String _requiredNativeCredential(String? value, String label) {
  final normalized = value?.trim();
  if (normalized == null || normalized.isEmpty) {
    throw ChikAuthError(
      ChikErrorCode.invalidResponse,
      'Native session response did not include a $label.',
    );
  }
  return normalized;
}

String _requiredNativeSessionScope(Object? value) {
  if (value is! String || !RegExp(r'^[a-f0-9]{64}$').hasMatch(value)) {
    throw ChikAuthError(
      ChikErrorCode.storageError,
      'The stored native session scope is invalid.',
      status: 0,
    );
  }
  return value;
}

String? _optionalNativeResponseSessionScope(Object? value) {
  return value == null ? null : _requiredNativeResponseSessionScope(value);
}

String _requiredNativeResponseSessionScope(Object? value) {
  if (value is! String || !RegExp(r'^[a-f0-9]{64}$').hasMatch(value)) {
    throw ChikAuthError(
      ChikErrorCode.invalidResponse,
      'Native session response did not include a valid session scope.',
      status: 502,
    );
  }
  return value;
}

String? _storedNativeSessionScope(Object? value) {
  if (value is! Map) return null;
  final sessionScope = value['sessionScope'];
  return sessionScope is String &&
          RegExp(r'^[a-f0-9]{64}$').hasMatch(sessionScope)
      ? sessionScope
      : null;
}

String _requiredNativeOAuthText(Object? value, String label) {
  final normalized = value is String ? value.trim() : '';
  if (normalized.isEmpty) {
    throw ChikAuthError(
      ChikErrorCode.invalidResponse,
      'Native authorization response did not include a $label.',
      status: 502,
    );
  }
  return normalized;
}

_ChikNativeGitHubRedirectValues _nativeGitHubRedirectValues(
  String redirect,
  String expected,
  String state,
) {
  final received = Uri.tryParse(redirect);
  final target = Uri.tryParse(expected);
  if (received == null ||
      target == null ||
      received.scheme != target.scheme ||
      received.host != target.host ||
      received.port != target.port ||
      received.path != target.path ||
      received.userInfo.isNotEmpty ||
      received.fragment.isNotEmpty) {
    throw ChikAuthError(
      ChikErrorCode.permissionDenied,
      'The redirect URL does not match this authorization transaction.',
      status: 403,
    );
  }
  final codes = received.queryParametersAll['code'];
  final states = received.queryParametersAll['state'];
  final code = codes != null && codes.length == 1 ? codes.single.trim() : '';
  final receivedState =
      states != null && states.length == 1 ? states.single.trim() : '';
  if (code.isEmpty || receivedState.isEmpty || receivedState != state) {
    throw ChikAuthError(
      ChikErrorCode.unauthenticated,
      'The authorization state is invalid.',
      status: 401,
    );
  }
  return _ChikNativeGitHubRedirectValues(code: code, state: receivedState);
}

final _chikAuthHttpClient = http.Client();

Future<ChikAuthResponse> _chikAuthHttpFetch(
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
    await _chikAuthHttpClient.send(request),
  );
  return ChikAuthResponse(
    status: response.statusCode,
    bodyBytes: response.bodyBytes,
    headers: response.headers,
  );
}

String _authOrigin(String baseUrl) {
  final uri = Uri.parse(baseUrl);
  if ((uri.scheme != 'http' && uri.scheme != 'https') ||
      uri.userInfo.isNotEmpty ||
      uri.query.isNotEmpty ||
      uri.fragment.isNotEmpty) {
    throw ArgumentError(
      'Auth baseUrl must be an absolute HTTP(S) deployment URL.',
    );
  }
  return uri.origin + uri.path.replaceFirst(RegExp(r'/+$'), '');
}

Map<String, Object?> _authObject(Object? value) {
  if (value is! Map)
    throw ChikAuthError(
        ChikErrorCode.invalidResponse, 'JSON object response expected.');
  return {for (final entry in value.entries) entry.key.toString(): entry.value};
}

ChikAuthError _authErrorFromResponse(ChikAuthResponse response) {
  final bytes = response.bodyBytes;
  final text = bytes == null ? '' : utf8.decode(bytes, allowMalformed: true);
  var code = ChikErrorCode.unknown;
  String? rawCode;
  var message = text.isEmpty ? 'HTTP ${response.status}' : text;
  Object? details;
  try {
    final json = _authObject(jsonDecode(text));
    final declaredCode = json['code'];
    if (declaredCode is String && declaredCode.isNotEmpty) {
      final parsedCode = ChikErrorCode.fromWire(declaredCode);
      if (parsedCode != ChikErrorCode.unknown ||
          declaredCode == ChikErrorCode.unknown.wireValue) {
        code = parsedCode;
      } else {
        rawCode = declaredCode;
      }
    }
    final declaredMessage = json['message'];
    if (declaredMessage is String && declaredMessage.isNotEmpty)
      message = declaredMessage;
    if (json.containsKey('details')) details = json['details'];
  } catch (_) {
    // The plain response body remains the customer-visible error message.
  }
  return ChikAuthError(
    code,
    message,
    rawCode: rawCode,
    status: response.status,
    retryAfterSeconds: int.tryParse(
      _authReadHeader(response.headers, 'retry-after') ?? '',
    ),
    details: details,
  );
}

String? _authReadHeader(Map<String, String> headers, String name) {
  final lower = name.toLowerCase();
  for (final entry in headers.entries) {
    if (entry.key.toLowerCase() == lower) return entry.value;
  }
  return null;
}

void _authSetHeader(Map<String, String> headers, String name, String value) {
  final lower = name.toLowerCase();
  headers.removeWhere((key, _) => key.toLowerCase() == lower);
  headers[name] = value;
}
