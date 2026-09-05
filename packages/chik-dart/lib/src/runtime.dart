library chik_client;

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import 'auth.dart';
import 'error-contract.dart';
import 'storage.dart';

typedef ChikJsonMap = Map<String, Object?>;

final class ChikConnectError implements Exception {
  ChikConnectError(
    this.code,
    this.message, {
    this.rawCode,
    this.statusCode,
    this.details,
    this.cause,
  });

  final ChikErrorCode code;
  final String? rawCode;
  final String message;
  final int? statusCode;
  final Object? details;
  final Object? cause;

  @override
  String toString() => 'ChikConnectError($code, $message)';
}

abstract interface class ChikTransport {
  Future<ChikTransportResponse> postJson(
    Uri url,
    Map<String, String> headers,
    Object? body,
  );
}

/// Optional capability for declared raw HTTP operations.
///
/// Custom RPC transports only need [ChikTransport]. Implement this interface
/// as well when the application calls operations from chick/api.yml.
abstract interface class ChikRawTransport {
  Future<ChikTransportResponse> request(
    Uri url,
    String method,
    Map<String, String> headers, {
    Uint8List? body,
  });
}

// Internal WebSocket transport adapter used by streaming RPCs.
// Users implement this connection contract instead of handling raw WebSocket frames.
abstract interface class ChikStreamConnection {
  Stream<String> get incoming;
  void send(String frame);
  void close([int code = 1000, String reason = '']);
}

abstract interface class ChikStreamTransport {
  /// Opens a connection to the WebSocket URL and handles protocol v2 frame transport.
  ChikStreamConnection openStream(Uri url, Map<String, String> headers);
}

/// Default WebSocket adapter. Users do not interact with the frame protocol directly.
final class ChikWebSocketStreamConnection implements ChikStreamConnection {
  ChikWebSocketStreamConnection(this._channel);

  final WebSocketChannel _channel;

  @override
  Stream<String> get incoming =>
      _channel.stream.map((value) => value.toString());

  @override
  void send(String frame) => _channel.sink.add(frame);

  @override
  void close([int code = 1000, String reason = '']) {
    _channel.sink.close(code, reason);
  }
}

final class ChikWebSocketStreamTransport implements ChikStreamTransport {
  const ChikWebSocketStreamTransport();

  @override
  ChikStreamConnection openStream(Uri url, Map<String, String> _headers) {
    // Browsers cannot set arbitrary WebSocket headers, so credentials are sent in the start frame.
    return ChikWebSocketStreamConnection(WebSocketChannel.connect(url));
  }
}

abstract interface class ChikCancellationSignal {
  bool get isCancelled;
  void addListener(void Function() listener);
  void removeListener(void Function() listener);
}

final class ChikCallOptions {
  const ChikCallOptions({
    this.token,
    this.headers = const {},
    this.signal,
    this.retryOnAuthenticationFailure = false,
  });

  final String? token;
  final Map<String, String> headers;
  final ChikCancellationSignal? signal;
  final bool retryOnAuthenticationFailure;

  ChikCallOptions withAuthenticationRetry() {
    if (retryOnAuthenticationFailure) return this;
    return ChikCallOptions(
      token: token,
      headers: headers,
      signal: signal,
      retryOnAuthenticationFailure: true,
    );
  }
}

final class ChikTransportResponse {
  const ChikTransportResponse({
    required this.statusCode,
    required this.body,
    this.headers = const {},
  });

  final int statusCode;
  final String body;
  final Map<String, String> headers;

  bool get isOk => statusCode >= 200 && statusCode < 300;
}

/// Opaque bytes for a declared multipart or octet-stream HTTP operation.
///
/// The generated SDK owns the HTTP method and path. Applications own only the
/// request bytes and their content type.
final class ChikRawBody {
  const ChikRawBody(this.bytes, {required this.contentType});

  final Uint8List bytes;
  final String contentType;

  factory ChikRawBody.json(Object? value) {
    return ChikRawBody(
      Uint8List.fromList(utf8.encode(jsonEncode(_toJsonValue(value)))),
      contentType: 'application/json',
    );
  }
}

final class _ChikRawResponse {
  const _ChikRawResponse(this.body);

  final String body;

  ChikJsonMap get jsonBody {
    if (body.isEmpty) return <String, Object?>{};
    try {
      final decoded = jsonDecode(body);
      if (decoded is Map) return _stringKeyedMap(decoded);
    } catch (_) {
      // Normalize malformed JSON to the generated client error contract.
    }
    throw ChikConnectError(
        ChikErrorCode.internal, 'JSON object response expected.');
  }
}

/// Default JSON HTTP transport. Users do not need to implement an HTTP client.
final class ChikHttpTransport implements ChikTransport, ChikRawTransport {
  ChikHttpTransport({http.Client? client}) : _client = client ?? http.Client();

  final http.Client _client;

  @override
  Future<ChikTransportResponse> postJson(
    Uri url,
    Map<String, String> headers,
    Object? body,
  ) async {
    return request(
      url,
      'POST',
      headers,
      body: Uint8List.fromList(utf8.encode(jsonEncode(body))),
    );
  }

  @override
  Future<ChikTransportResponse> request(
    Uri url,
    String method,
    Map<String, String> headers, {
    Uint8List? body,
  }) async {
    final request = http.Request(method, url)
      ..headers.addAll(headers)
      ..followRedirects = false
      ..maxRedirects = 0;
    if (body != null) request.bodyBytes = body;
    final response = await http.Response.fromStream(
      await _client.send(request),
    );
    return ChikTransportResponse(
      statusCode: response.statusCode,
      body: response.body,
      headers: response.headers,
    );
  }

  void close() => _client.close();
}

abstract interface class ChikReactiveBridge {
  ChikReactiveQuery<T> query<T>({
    required String name,
    required Object? args,
    required ChikCallOptions callOptions,
    required Future<ChikReactiveFetchResult<T>> Function(
      ChikReactiveSubscription? subscription,
    ) fetchItems,
    required T Function(ChikJsonMap json) fromJson,
  });
}

abstract interface class ChikReactiveQuery<T> {
  Stream<List<T>> get stream;
  List<T> get value;
  Future<List<T>> refresh();
  Future<void> dispose();
}

final class ChikReactiveCursor {
  const ChikReactiveCursor({required this.stream, required this.position});

  final String stream;
  final String position;
}

final class ChikReactiveSubscription {
  const ChikReactiveSubscription({
    required this.id,
    required this.identityKey,
    required this.queryHash,
    required this.version,
    required this.cursor,
    this.expiresAt,
  });

  final String id;
  final String identityKey;
  final String queryHash;
  final int version;
  final ChikReactiveCursor cursor;
  final int? expiresAt;

  ChikReactiveSubscription copyWith({
    int? version,
    ChikReactiveCursor? cursor,
    int? expiresAt,
  }) {
    return ChikReactiveSubscription(
      id: id,
      identityKey: identityKey,
      queryHash: queryHash,
      version: version ?? this.version,
      cursor: cursor ?? this.cursor,
      expiresAt: expiresAt ?? this.expiresAt,
    );
  }
}

final class ChikResponseSnapshot {
  const ChikResponseSnapshot({
    required this.statusCode,
    required this.body,
    this.headers = const {},
  });

  final int statusCode;
  final String body;
  final Map<String, String> headers;
}

typedef ChikReactiveFetchResult<T> = ({
  List<T> items,
  ChikReactiveSubscription subscription,
});

/// Default reactive watch bridge reusing the existing RPC WebSocket transport.
final class ChikWebSocketReactiveBridge implements ChikReactiveBridge {
  const ChikWebSocketReactiveBridge(this.options);

  final ChikClientOptions options;

  @override
  ChikReactiveQuery<T> query<T>({
    required String name,
    required Object? args,
    required ChikCallOptions callOptions,
    required Future<ChikReactiveFetchResult<T>> Function(
      ChikReactiveSubscription? subscription,
    ) fetchItems,
    required T Function(ChikJsonMap json) fromJson,
  }) {
    // Name and args are omitted from the transport since query hash is already included in server subscription response.
    return _ChikWebSocketReactiveQuery<T>(
      this.options,
      callOptions,
      fetchItems,
      (value) => _reactiveSnapshotItems(value, fromJson),
    );
  }
}

final class _ChikWebSocketReactiveQuery<T> implements ChikReactiveQuery<T> {
  _ChikWebSocketReactiveQuery(
    this._options,
    this._callOptions,
    this._fetchItems,
    this._snapshotItems,
  ) {
    scheduleMicrotask(_start);
  }

  final ChikClientOptions _options;
  final ChikCallOptions _callOptions;
  final Future<ChikReactiveFetchResult<T>> Function(
    ChikReactiveSubscription? subscription,
  ) _fetchItems;
  final List<T> Function(Object? value) _snapshotItems;
  final _controller = StreamController<List<T>>.broadcast();
  StreamSubscription<String>? _socketSubscription;
  ChikStreamConnection? _socket;
  ChikReactiveSubscription? _subscription;
  late final _JsonRequester _requester = _JsonRequester(_options);
  List<T> _value = const [];
  bool _closed = false;
  Future<void> _refreshTail = Future<void>.value();
  Timer? _reconnectTimer;
  Timer? _renewTimer;
  var _reconnectAttempt = 0;
  var _renewAttempt = 0;
  var _reregistering = false;

  @override
  Stream<List<T>> get stream => _controller.stream;

  @override
  List<T> get value => List<T>.unmodifiable(_value);

  @override
  Future<List<T>> refresh() async {
    final fetched = await _fetchSerialized(_subscription);
    if (_closed) return value;
    _subscription = fetched.subscription;
    _value = List<T>.unmodifiable(fetched.items);
    _controller.add(_value);
    _scheduleRenew();
    if (_socket == null && _reconnectTimer == null && !_reregistering)
      _connect();
    return value;
  }

  Future<ChikReactiveFetchResult<T>> _fetchSerialized(
    ChikReactiveSubscription? subscription,
  ) {
    final result = _refreshTail.then((_) => _fetchItems(subscription));
    _refreshTail = result.then<void>((_) {}, onError: (_, __) {});
    return result;
  }

  Future<void> _start() async {
    try {
      await refresh();
    } catch (error, stackTrace) {
      if (!_closed) _controller.addError(error, stackTrace);
    }
  }

  void _connect() {
    final subscription = _subscription;
    if (_closed ||
        subscription == null ||
        _socket != null ||
        _reconnectTimer != null) return;
    try {
      final headers = _callHeaders(
        _options,
        _callOptions,
        contentType: 'application/json',
      );
      final authorization = _readHeader(headers, 'authorization');
      final url = _reactiveUrl(
        _options.baseUrl,
        subscription,
        authorization != null,
      );
      final socket = _options.streamTransport.openStream(url, headers);
      _socket = socket;
      _socketSubscription = socket.incoming.listen(
        _onFrame,
        onError: (Object error, StackTrace stack) =>
            _handleSocketLost(socket, error, stack),
        onDone: () => _handleSocketLost(socket),
      );
      if (authorization != null) {
        socket.send(
          jsonEncode({'v': 1, 't': 'auth', 'authorization': authorization}),
        );
      }
    } catch (error, stackTrace) {
      final socket = _socket;
      _socket = null;
      unawaited(_socketSubscription?.cancel());
      _socketSubscription = null;
      socket?.close(1000, 'reconnect');
      if (!_closed) _controller.addError(error, stackTrace);
      _scheduleReconnect();
    }
  }

  void _handleSocketLost(
    ChikStreamConnection socket, [
    Object? error,
    StackTrace? stack,
  ]) {
    if (_closed || !identical(_socket, socket)) return;
    _socket = null;
    final subscription = _socketSubscription;
    _socketSubscription = null;
    unawaited(subscription?.cancel());
    if (error != null && !_closed)
      _controller.addError(error, stack ?? StackTrace.current);
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_closed || _reconnectTimer != null || _reregistering) return;
    final delayMs = math.min(
      250 * (1 << math.min(_reconnectAttempt, 7)),
      30000,
    );
    _reconnectAttempt += 1;
    _reconnectTimer = Timer(Duration(milliseconds: delayMs), () {
      _reconnectTimer = null;
      unawaited(_reregister());
    });
  }

  Future<void> _reregister() async {
    if (_closed || _reregistering) return;
    _reregistering = true;
    var retry = false;
    try {
      // Pass same subscription ID and cursor on refresh to maintain persistent cursor resume.
      final fetched = await _fetchSerialized(_subscription);
      if (_closed) return;
      _subscription = fetched.subscription;
      _value = List<T>.unmodifiable(fetched.items);
      _controller.add(_value);
      _scheduleRenew();
      _connect();
      _reconnectAttempt = 0;
    } catch (error, stackTrace) {
      if (!_closed) {
        _controller.addError(error, stackTrace);
        retry = true;
      }
    } finally {
      _reregistering = false;
      if (retry) _scheduleReconnect();
    }
  }

  void _scheduleRenew() {
    _renewTimer?.cancel();
    final expiresAt = _subscription?.expiresAt;
    if (_closed || expiresAt == null) return;
    final jitter = math.Random().nextInt(30000);
    final fireAt = expiresAt - 60000 + jitter;
    final delay = math.max(0, fireAt - DateTime.now().millisecondsSinceEpoch);
    _renewTimer = Timer(Duration(milliseconds: delay), () {
      unawaited(_performRenew());
    });
  }

  void _scheduleRenewRetry() {
    _renewTimer?.cancel();
    if (_closed || _subscription == null) return;
    _renewAttempt += 1;
    final delay = math.min(1000 * (1 << math.min(_renewAttempt, 5)), 30000);
    _renewTimer = Timer(Duration(milliseconds: delay), () {
      unawaited(_performRenew());
    });
  }

  Future<void> _performRenew() async {
    final active = _subscription;
    if (_closed || active == null) return;
    try {
      final response = await _requester.unaryWithSnapshot<ChikJsonMap>(
        '/api/_chik/reactive/renew',
        {
          'subscriptionId': active.id,
          'queryHash': active.queryHash,
          'expectedVersion': active.version,
        },
        (json) => json,
        options: _callOptions,
      );
      final expiresAtText = _readHeader(
        response.snapshot.headers,
        reactiveExpiresAtHeader,
      );
      final expiresAt =
          expiresAtText == null ? null : int.tryParse(expiresAtText);
      if (expiresAt == null ||
          expiresAt <= DateTime.now().millisecondsSinceEpoch) {
        throw ChikConnectError(
          ChikErrorCode.unavailable,
          'Invalid reactive lease expiration time.',
          statusCode: 503,
        );
      }
      _renewAttempt = 0;
      _subscription = active.copyWith(expiresAt: expiresAt);
      _scheduleRenew();
    } on ChikConnectError catch (error) {
      if (error.statusCode == 404 ||
          error.statusCode == 409 ||
          error.statusCode == 410) {
        _forceReregister();
        return;
      }
      _scheduleRenewRetry();
    } catch (_) {
      _scheduleRenewRetry();
    }
  }

  void _forceReregister() {
    if (_closed) return;
    _renewTimer?.cancel();
    _renewTimer = null;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    final socket = _socket;
    _socket = null;
    unawaited(_socketSubscription?.cancel());
    _socketSubscription = null;
    socket?.close(1000, 'subscription expired');
    _subscription = null;
    _renewAttempt = 0;
    _reconnectAttempt = 0;
    unawaited(_reregister());
  }

  void _onFrame(String frame) {
    try {
      final decoded = jsonDecode(frame);
      if (decoded is! Map)
        throw ChikConnectError(
          ChikErrorCode.dataLoss,
          'Reactive WebSocket frame is not a JSON object.',
        );
      final map = _stringKeyedMap(decoded);
      final type = map['type'];
      final active = _subscription;
      if (active == null || map['subscriptionId'] != active.id) return;
      if (type == 'reactive_invalidation') {
        unawaited(refresh());
        return;
      }
      if (type != 'reactive_snapshot' || map['snapshot'] is! Map) {
        throw ChikConnectError(
          ChikErrorCode.dataLoss,
          'Invalid reactive WebSocket frame.',
        );
      }
      final snapshot = _stringKeyedMap(map['snapshot'] as Map);
      if (snapshot['identityKey'] != active.identityKey) {
        throw ChikConnectError(
          ChikErrorCode.permissionDenied,
          'Reactive snapshot identity does not match current subscription.',
        );
      }
      final version = snapshot['version'];
      final cursor = snapshot['cursor'];
      if (version is! num || cursor is! Map) {
        throw ChikConnectError(
          ChikErrorCode.dataLoss,
          'Invalid reactive snapshot version/cursor.',
        );
      }
      final nextVersion = version.toInt();
      if (nextVersion <= active.version) return;
      final cursorMap = _stringKeyedMap(cursor);
      final stream = cursorMap['stream'];
      final position = cursorMap['position'];
      if (stream is! String || position is! String) {
        throw ChikConnectError(
          ChikErrorCode.dataLoss,
          'Invalid reactive snapshot cursor.',
        );
      }
      _subscription = active.copyWith(
        version: nextVersion,
        cursor: ChikReactiveCursor(stream: stream, position: position),
      );
      _value = List<T>.unmodifiable(_snapshotItems(snapshot['value']));
      _controller.add(_value);
    } catch (error, stackTrace) {
      if (!_closed) _controller.addError(error, stackTrace);
    }
  }

  @override
  Future<void> dispose() async {
    if (_closed) return;
    _closed = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _renewTimer?.cancel();
    _renewTimer = null;
    await _socketSubscription?.cancel();
    _socket?.close(1000, 'disposed');
    await _controller.close();
  }
}

const reactiveSubscribeHeader = 'x-chik-reactive-subscribe';
const reactiveSubscriptionIdHeader = 'x-chik-reactive-subscription-id';
const reactiveIdentityKeyHeader = 'x-chik-reactive-identity-key';
const reactiveQueryHashHeader = 'x-chik-reactive-query-hash';
const reactiveVersionHeader = 'x-chik-reactive-version';
const reactiveCursorStreamHeader = 'x-chik-reactive-cursor-stream';
const reactiveCursorPositionHeader = 'x-chik-reactive-cursor-position';
const reactiveExpiresAtHeader = 'x-chik-reactive-expires-at';

String? _readHeader(Map<String, String> headers, String name) {
  final exact = headers[name];
  if (exact != null) return exact;
  final lower = name.toLowerCase();
  for (final entry in headers.entries) {
    if (entry.key.toLowerCase() == lower) return entry.value;
  }
  return null;
}

ChikReactiveSubscription reactiveSubscriptionFromResponse(
  ChikResponseSnapshot? snapshot,
) {
  final headers = snapshot?.headers ?? const <String, String>{};
  final id = _readHeader(headers, reactiveSubscriptionIdHeader);
  final identityKey = _readHeader(headers, reactiveIdentityKeyHeader);
  final queryHash = _readHeader(headers, reactiveQueryHashHeader);
  final versionText = _readHeader(headers, reactiveVersionHeader);
  final stream = _readHeader(headers, reactiveCursorStreamHeader);
  final position = _readHeader(headers, reactiveCursorPositionHeader);
  final expiresAtText = _readHeader(headers, reactiveExpiresAtHeader);
  final expiresAt = expiresAtText == null ? null : int.tryParse(expiresAtText);

  if (id == null || id.isEmpty) {
    throw ChikConnectError(
      ChikErrorCode.unavailable,
      'subscription-id header missing',
      statusCode: 503,
    );
  }
  if (identityKey == null || identityKey.isEmpty) {
    throw ChikConnectError(
      ChikErrorCode.unavailable,
      'identity-key header missing',
      statusCode: 503,
    );
  }
  if (queryHash == null || !RegExp(r'^[0-9a-f]{64}$').hasMatch(queryHash)) {
    throw ChikConnectError(
      ChikErrorCode.unavailable,
      'query-hash header invalid',
      statusCode: 503,
    );
  }
  if (stream == null || stream.isEmpty) {
    throw ChikConnectError(
      ChikErrorCode.unavailable,
      'cursor-stream header missing',
      statusCode: 503,
    );
  }
  if (position == null || !RegExp(r'^(0|[1-9]\d*)$').hasMatch(position)) {
    throw ChikConnectError(
      ChikErrorCode.unavailable,
      'cursor-position header invalid',
      statusCode: 503,
    );
  }
  if (expiresAtText != null &&
      (expiresAt == null ||
          expiresAt <= DateTime.now().millisecondsSinceEpoch)) {
    throw ChikConnectError(
      ChikErrorCode.unavailable,
      'expires-at header invalid',
      statusCode: 503,
    );
  }
  final version = versionText == null ? null : int.tryParse(versionText);
  if (version == null || version < 1) {
    throw ChikConnectError(
      ChikErrorCode.unavailable,
      'version header invalid',
      statusCode: 503,
    );
  }
  return ChikReactiveSubscription(
    id: id,
    identityKey: identityKey,
    queryHash: queryHash,
    version: version,
    cursor: ChikReactiveCursor(stream: stream, position: position),
    expiresAt: expiresAt,
  );
}

final class ChikClientOptions {
  ChikClientOptions({
    required Uri baseUrl,
    ChikTransport? transport,
    this.apiKey,
    this.sessionToken,
    this.sessionTokenProvider,
    this.sessionScopeProvider,
    this.sessionScopeLeaseProvider,
    this.sessionTokenRefresher,
    this.headers = const {},
    this.reactive,
    this.streamTransport = const ChikWebSocketStreamTransport(),
  })  : baseUrl = _deploymentOrigin(baseUrl),
        transport = transport ?? ChikHttpTransport();

  final Uri baseUrl;
  final ChikTransport transport;
  final String? apiKey;
  final String? sessionToken;
  final ChikSessionTokenProvider? sessionTokenProvider;
  final ChikSessionScopeProvider? sessionScopeProvider;
  final ChikSessionScopeLeaseProvider? sessionScopeLeaseProvider;
  final ChikSessionTokenRefresher? sessionTokenRefresher;
  final Map<String, String> headers;
  final ChikReactiveBridge? reactive;
  final ChikStreamTransport streamTransport;

  /// Builds generated-client options without exposing native credentials.
  factory ChikClientOptions.nativeAuth(
    ChikNativeAuth auth, {
    ChikTransport? transport,
    Map<String, String>? headers,
    ChikReactiveBridge? reactive,
    ChikStreamTransport streamTransport = const ChikWebSocketStreamTransport(),
  }) {
    return ChikClientOptions(
      baseUrl: Uri.parse(auth.baseUrl),
      transport: transport,
      apiKey: auth.apiKey,
      sessionTokenProvider: auth.sessionTokenProvider,
      sessionScopeProvider: auth.sessionScopeProvider,
      sessionScopeLeaseProvider: auth.sessionScopeLeaseProvider,
      sessionTokenRefresher: auth.sessionTokenRefresher,
      headers: headers ?? auth.headers,
      reactive: reactive,
      streamTransport: streamTransport,
    );
  }

  String? get _currentSessionToken {
    final token =
        sessionTokenProvider == null ? sessionToken : sessionTokenProvider!();
    final normalized = token?.trim();
    return normalized == null || normalized.isEmpty ? null : normalized;
  }

  String? get _currentSessionScope {
    final normalized = sessionScopeProvider?.call()?.trim();
    return normalized == null || normalized.isEmpty ? null : normalized;
  }

  ChikSessionScopeLease? get _currentSessionScopeLease {
    final lease = sessionScopeLeaseProvider?.call();
    return lease != null &&
            lease.isActive &&
            lease.sessionScope == _currentSessionScope
        ? lease
        : null;
  }
}

Uri _deploymentOrigin(Uri value) {
  final path = value.path.replaceFirst(RegExp(r'/+$'), '');
  if ((value.scheme != 'http' && value.scheme != 'https') ||
      value.host.isEmpty ||
      value.userInfo.isNotEmpty ||
      value.hasQuery ||
      value.fragment.isNotEmpty ||
      (path.isNotEmpty && path != '/api')) {
    throw ArgumentError.value(
      value,
      'baseUrl',
      'baseUrl must be a deployment origin.',
    );
  }
  return value.replace(path: '/', query: null, fragment: null);
}

final class ChikRealtimePublishResult {
  const ChikRealtimePublishResult({required this.seq, required this.ts});

  final int seq;
  final int ts;

  factory ChikRealtimePublishResult.fromJson(ChikJsonMap json) {
    return ChikRealtimePublishResult(
      seq: _readInt(json, 'seq'),
      ts: _readInt(json, 'ts'),
    );
  }
}

final class ChikRealtimeEvent {
  const ChikRealtimeEvent({
    this.channel,
    required this.seq,
    required this.ts,
    required this.payload,
  });

  final String? channel;
  final int seq;
  final int ts;
  final Object? payload;
}

final class ChikRealtimeGap {
  const ChikRealtimeGap({
    this.channel,
    required this.oldestSeq,
    required this.latestSeq,
  });

  final String? channel;
  final int oldestSeq;
  final int latestSeq;
}

final class ChikRealtimeProtocolError {
  const ChikRealtimeProtocolError({
    required this.code,
    required this.message,
    this.rawCode,
    this.cause,
  });

  final ChikErrorCode code;
  final String? rawCode;
  final String message;
  final Object? cause;
}

final class ChikRealtimeSubscribeOptions {
  const ChikRealtimeSubscribeOptions({
    required this.onEvent,
    required this.onGap,
    this.lastSeq,
    this.token,
    this.onError,
  });

  final int? lastSeq;
  final String? token;
  final void Function(ChikRealtimeEvent event) onEvent;
  final void Function(ChikRealtimeGap gap) onGap;
  final void Function(ChikRealtimeProtocolError error)? onError;
}

abstract interface class ChikRealtimeSubscription {
  void close();
}

final class ChikRealtimeConnectionOptions {
  const ChikRealtimeConnectionOptions({
    required this.onEvent,
    required this.onGap,
    this.token,
    this.onError,
  });

  final String? token;
  final void Function(ChikRealtimeEvent event) onEvent;
  final void Function(ChikRealtimeGap gap) onGap;
  final void Function(ChikRealtimeProtocolError error)? onError;
}

abstract interface class ChikRealtimeConnection {
  void subscribe(String channel, {int? lastSeq});
  void unsubscribe(String channel);
  void close();
}

final class ChikRealtimeClient {
  ChikRealtimeClient(this._requester, this._options);

  final _JsonRequester _requester;
  final ChikClientOptions _options;

  Future<ChikRealtimePublishResult> publish(
    String channel,
    Object? payload, {
    String? token,
    ChikCallOptions options = const ChikCallOptions(),
  }) {
    return _requester.unary(
      '/v1/realtime/${Uri.encodeComponent(channel)}/publish',
      {'payload': payload},
      ChikRealtimePublishResult.fromJson,
      options: options,
      overrideApiKey: token,
    );
  }

  ChikRealtimeSubscription subscribe(
    String channel,
    ChikRealtimeSubscribeOptions options,
  ) {
    return _ChikSingleRealtimeSubscription(_options, channel, options);
  }

  ChikRealtimeConnection connect(ChikRealtimeConnectionOptions options) {
    return _ChikRealtimeConnection(_options, options);
  }
}

final class _ChikSingleRealtimeSubscription
    implements ChikRealtimeSubscription {
  _ChikSingleRealtimeSubscription(
    this._options,
    this._channel,
    this._callbacks,
  ) : _authorizationScope = _captureRealtimeAuthenticationScope(
          _options,
          _callbacks.token,
        ) {
    _lastSeq = _realtimeSequence(_callbacks.lastSeq ?? 0);
    scheduleMicrotask(_connect);
  }

  final ChikClientOptions _options;
  final String _channel;
  final ChikRealtimeSubscribeOptions _callbacks;
  final _AuthenticationRetryScope? _authorizationScope;
  ChikStreamConnection? _socket;
  StreamSubscription<String>? _subscription;
  Timer? _reconnectTimer;
  var _closed = false;
  var _unauthorized = false;
  var _authorizationRecoveryUsed = false;
  var _authorizationRecoveryInFlight = false;
  var _attempt = 0;
  late int _lastSeq;

  void _connect() {
    if (_closed || _socket != null) return;
    if (_authorizationScope != null &&
        !_isAuthenticationRetryScopeCurrent(_options, _authorizationScope)) {
      _stopUnauthorized(ChikErrorMessage.authenticationSessionChanged);
      return;
    }
    try {
      final authorization = _realtimeAuthorization(
        _callbacks.token,
        _options.headers,
        _options,
        _authorizationScope,
      );
      final socket = _options.streamTransport.openStream(
        _realtimeChannelUrl(
          _options.baseUrl,
          _channel,
          _lastSeq,
          authorization != null,
        ),
        _realtimeHeaders(_options.headers, authorization),
      );
      _socket = socket;
      _subscription = socket.incoming.listen(
        _onFrame,
        onError: (Object error, StackTrace stack) {
          _callbacks.onError?.call(
            ChikRealtimeProtocolError(
              code: ChikErrorCode.internal,
              message: 'Failed to establish WebSocket connection.',
              cause: error,
            ),
          );
          _socketLost(socket);
        },
        onDone: () => _socketLost(socket),
      );
      if (authorization != null) {
        socket.send(
          jsonEncode({'v': 1, 't': 'auth', 'authorization': authorization}),
        );
      }
      _attempt = 0;
    } catch (error) {
      final socket = _socket;
      _socket = null;
      unawaited(_subscription?.cancel());
      _subscription = null;
      socket?.close(1000, 'reconnect');
      _callbacks.onError?.call(
        ChikRealtimeProtocolError(
          code: ChikErrorCode.internal,
          message: 'Failed to establish WebSocket connection.',
          cause: error,
        ),
      );
      _scheduleReconnect();
    }
  }

  void _onFrame(String frame) {
    try {
      final value = _realtimeFrame(frame);
      switch (value['t']) {
        case 'event':
          final seq = _readInt(value, 'seq');
          _lastSeq = seq;
          _callbacks.onEvent(
            ChikRealtimeEvent(
              seq: seq,
              ts: _readInt(value, 'ts'),
              payload: value['payload'],
            ),
          );
          break;
        case 'gap':
          final latest = _readInt(value, 'latest_seq');
          _lastSeq = math.max(_lastSeq, latest).toInt();
          _callbacks.onGap(
            ChikRealtimeGap(
              oldestSeq: _readInt(value, 'oldest_seq'),
              latestSeq: latest,
            ),
          );
          break;
        case 'error':
          final error = _realtimeProtocolError(value);
          if (error.code == ChikErrorCode.unauthorized) {
            _recoverAuthorization(error.message);
          } else {
            _callbacks.onError?.call(error);
          }
          break;
        default:
          throw ChikConnectError(
            ChikErrorCode.dataLoss,
            'Invalid realtime WebSocket frame.',
          );
      }
    } catch (error) {
      _callbacks.onError?.call(
        ChikRealtimeProtocolError(
          code: ChikErrorCode.internal,
          message: error.toString(),
          cause: error,
        ),
      );
    }
  }

  void _socketLost(ChikStreamConnection socket) {
    if (_closed || !identical(_socket, socket)) return;
    _socket = null;
    final subscription = _subscription;
    _subscription = null;
    unawaited(subscription?.cancel());
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_closed ||
        _unauthorized ||
        _authorizationRecoveryInFlight ||
        _reconnectTimer != null) {
      return;
    }
    _attempt += 1;
    _reconnectTimer = Timer(
      Duration(milliseconds: math.min(1000 * _attempt, 10000)),
      () {
        _reconnectTimer = null;
        _connect();
      },
    );
  }

  void _recoverAuthorization(String message) {
    if (_closed) return;
    if (_authorizationRecoveryUsed || _authorizationRecoveryInFlight) {
      _stopUnauthorized(message);
      return;
    }
    _authorizationRecoveryUsed = true;
    _authorizationRecoveryInFlight = true;
    final socket = _socket;
    _socket = null;
    final subscription = _subscription;
    _subscription = null;
    unawaited(subscription?.cancel());
    socket?.close(1000, 'reauthenticate');
    unawaited(_refreshRealtimeAuthorization(
      _options,
      _callbacks.token,
      _authorizationScope,
    ).then(
      (refreshed) {
        _authorizationRecoveryInFlight = false;
        if (_closed) return;
        if (!refreshed) {
          _stopUnauthorized(message);
          return;
        }
        _connect();
      },
      onError: (_) {
        _authorizationRecoveryInFlight = false;
        if (!_closed) _stopUnauthorized(message);
      },
    ));
  }

  void _stopUnauthorized(String message) {
    if (_unauthorized) return;
    _unauthorized = true;
    _callbacks.onError?.call(
      ChikRealtimeProtocolError(
        code: ChikErrorCode.unauthorized,
        message: message,
      ),
    );
    close();
  }

  @override
  void close() {
    if (_closed) return;
    _closed = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    unawaited(_subscription?.cancel());
    _subscription = null;
    _socket?.close(1000, 'closed');
    _socket = null;
  }
}

final class _ChikRealtimeConnection implements ChikRealtimeConnection {
  _ChikRealtimeConnection(this._options, this._callbacks)
      : _authorizationScope = _captureRealtimeAuthenticationScope(
          _options,
          _callbacks.token,
        ) {
    scheduleMicrotask(_connect);
  }

  final ChikClientOptions _options;
  final ChikRealtimeConnectionOptions _callbacks;
  final _AuthenticationRetryScope? _authorizationScope;
  final Map<String, int> _lastSeqByChannel = <String, int>{};
  ChikStreamConnection? _socket;
  StreamSubscription<String>? _subscription;
  Timer? _reconnectTimer;
  var _closed = false;
  var _unauthorized = false;
  var _authorizationRecoveryUsed = false;
  var _authorizationRecoveryInFlight = false;
  var _attempt = 0;

  @override
  void subscribe(String channel, {int? lastSeq}) {
    final value = _realtimeSequence(lastSeq ?? _lastSeqByChannel[channel] ?? 0);
    _lastSeqByChannel[channel] = value;
    _send({'v': 1, 't': 'sub', 'channel': channel, 'last_seq': value});
  }

  @override
  void unsubscribe(String channel) {
    _lastSeqByChannel.remove(channel);
    _send({'v': 1, 't': 'unsub', 'channel': channel});
  }

  void _connect() {
    if (_closed || _socket != null) return;
    if (_authorizationScope != null &&
        !_isAuthenticationRetryScopeCurrent(_options, _authorizationScope)) {
      _stopUnauthorized(ChikErrorMessage.authenticationSessionChanged);
      return;
    }
    try {
      final authorization = _realtimeAuthorization(
        _callbacks.token,
        _options.headers,
        _options,
        _authorizationScope,
      );
      final socket = _options.streamTransport.openStream(
        _realtimeConnectionUrl(_options.baseUrl, authorization != null),
        _realtimeHeaders(_options.headers, authorization),
      );
      _socket = socket;
      _subscription = socket.incoming.listen(
        _onFrame,
        onError: (Object error, StackTrace stack) {
          _callbacks.onError?.call(
            ChikRealtimeProtocolError(
              code: ChikErrorCode.internal,
              message: 'Failed to establish WebSocket connection.',
              cause: error,
            ),
          );
          _socketLost(socket);
        },
        onDone: () => _socketLost(socket),
      );
      if (authorization != null) {
        socket.send(
          jsonEncode({'v': 1, 't': 'auth', 'authorization': authorization}),
        );
      }
      _attempt = 0;
      for (final entry in _lastSeqByChannel.entries) {
        _send({
          'v': 1,
          't': 'sub',
          'channel': entry.key,
          'last_seq': entry.value,
        });
      }
    } catch (error) {
      final socket = _socket;
      _socket = null;
      unawaited(_subscription?.cancel());
      _subscription = null;
      socket?.close(1000, 'reconnect');
      _callbacks.onError?.call(
        ChikRealtimeProtocolError(
          code: ChikErrorCode.internal,
          message: 'Failed to establish WebSocket connection.',
          cause: error,
        ),
      );
      _scheduleReconnect();
    }
  }

  void _send(Object frame) {
    final socket = _socket;
    if (socket == null || _closed) return;
    socket.send(jsonEncode(frame));
  }

  void _onFrame(String frame) {
    try {
      final value = _realtimeFrame(frame);
      final channel = value['channel'];
      final channelName = channel is String ? channel : null;
      switch (value['t']) {
        case 'event':
          final seq = _readInt(value, 'seq');
          if (channelName != null) _lastSeqByChannel[channelName] = seq;
          _callbacks.onEvent(
            ChikRealtimeEvent(
              channel: channelName,
              seq: seq,
              ts: _readInt(value, 'ts'),
              payload: value['payload'],
            ),
          );
          break;
        case 'gap':
          final latest = _readInt(value, 'latest_seq');
          if (channelName != null) _lastSeqByChannel[channelName] = latest;
          _callbacks.onGap(
            ChikRealtimeGap(
              channel: channelName,
              oldestSeq: _readInt(value, 'oldest_seq'),
              latestSeq: latest,
            ),
          );
          break;
        case 'error':
          final error = _realtimeProtocolError(value);
          if (error.code == ChikErrorCode.unauthorized) {
            _recoverAuthorization(error.message);
          } else {
            _callbacks.onError?.call(error);
          }
          break;
        default:
          throw ChikConnectError(
            ChikErrorCode.dataLoss,
            'Invalid realtime WebSocket frame.',
          );
      }
    } catch (error) {
      _callbacks.onError?.call(
        ChikRealtimeProtocolError(
          code: ChikErrorCode.internal,
          message: error.toString(),
          cause: error,
        ),
      );
    }
  }

  void _socketLost(ChikStreamConnection socket) {
    if (_closed || !identical(_socket, socket)) return;
    _socket = null;
    final subscription = _subscription;
    _subscription = null;
    unawaited(subscription?.cancel());
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_closed ||
        _unauthorized ||
        _authorizationRecoveryInFlight ||
        _reconnectTimer != null) {
      return;
    }
    _attempt += 1;
    _reconnectTimer = Timer(
      Duration(milliseconds: math.min(1000 * _attempt, 10000)),
      () {
        _reconnectTimer = null;
        _connect();
      },
    );
  }

  void _recoverAuthorization(String message) {
    if (_closed) return;
    if (_authorizationRecoveryUsed || _authorizationRecoveryInFlight) {
      _stopUnauthorized(message);
      return;
    }
    _authorizationRecoveryUsed = true;
    _authorizationRecoveryInFlight = true;
    final socket = _socket;
    _socket = null;
    final subscription = _subscription;
    _subscription = null;
    unawaited(subscription?.cancel());
    socket?.close(1000, 'reauthenticate');
    unawaited(_refreshRealtimeAuthorization(
      _options,
      _callbacks.token,
      _authorizationScope,
    ).then(
      (refreshed) {
        _authorizationRecoveryInFlight = false;
        if (_closed) return;
        if (!refreshed) {
          _stopUnauthorized(message);
          return;
        }
        _connect();
      },
      onError: (_) {
        _authorizationRecoveryInFlight = false;
        if (!_closed) _stopUnauthorized(message);
      },
    ));
  }

  void _stopUnauthorized(String message) {
    if (_unauthorized) return;
    _unauthorized = true;
    _callbacks.onError?.call(
      ChikRealtimeProtocolError(
        code: ChikErrorCode.unauthorized,
        message: message,
      ),
    );
    close();
  }

  @override
  void close() {
    if (_closed) return;
    _closed = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    unawaited(_subscription?.cancel());
    _subscription = null;
    _socket?.close(1000, 'closed');
    _socket = null;
  }
}

final class _JsonRequester {
  _JsonRequester(this.options);

  final ChikClientOptions options;

  Future<T> unary<T>(
    String path,
    Object? body,
    T Function(ChikJsonMap json) decode, {
    ChikCallOptions options = const ChikCallOptions(),
    String? overrideApiKey,
    bool retriedAfterAuthenticationFailure = false,
    _AuthenticationRetryScope? authenticationRetryScope,
    Object? encodedBody = _uncapturedJsonBody,
  }) async {
    final requestBody = identical(encodedBody, _uncapturedJsonBody)
        ? _toJsonValue(body)
        : encodedBody;
    final retryScope = authenticationRetryScope ??
        _captureAuthenticationRetryScope(this.options, options, overrideApiKey);
    final headers = _callHeaders(
      this.options,
      options,
      contentType: 'application/json',
      connectProtocol: true,
      overrideToken: overrideApiKey,
      sessionOnly: retryScope != null,
      authenticationRetryToken: retryScope?.token,
    );
    final response = await _awaitWithCancellation(
      this.options.transport.postJson(
            _resolvePath(this.options.baseUrl, path),
            headers,
            requestBody,
          ),
      options.signal,
    );
    if (!response.isOk) {
      final error = _connectErrorFromResponse(response);
      if (!retriedAfterAuthenticationFailure &&
          error.statusCode == 401 &&
          retryScope != null) {
        if (await _refreshAuthenticationRetryScope(this.options, retryScope)) {
          return unary(
            path,
            body,
            decode,
            options: options,
            overrideApiKey: overrideApiKey,
            retriedAfterAuthenticationFailure: true,
            authenticationRetryScope: retryScope,
            encodedBody: requestBody,
          );
        }
      }
      throw error;
    }
    return decode(_decodeJsonObject(response.body));
  }

  Future<({T body, ChikResponseSnapshot snapshot})> unaryWithSnapshot<T>(
    String path,
    Object? body,
    T Function(ChikJsonMap json) decode, {
    ChikCallOptions options = const ChikCallOptions(),
    Map<String, String>? extraHeaders,
    String? overrideApiKey,
    bool retriedAfterAuthenticationFailure = false,
    _AuthenticationRetryScope? authenticationRetryScope,
    Object? encodedBody = _uncapturedJsonBody,
  }) async {
    final requestBody = identical(encodedBody, _uncapturedJsonBody)
        ? _toJsonValue(body)
        : encodedBody;
    final retryScope = authenticationRetryScope ??
        _captureAuthenticationRetryScope(this.options, options, overrideApiKey);
    final headers = _callHeaders(
      this.options,
      options,
      contentType: 'application/json',
      connectProtocol: true,
      extraHeaders: extraHeaders,
      overrideToken: overrideApiKey,
      sessionOnly: retryScope != null,
      authenticationRetryToken: retryScope?.token,
    );
    final response = await _awaitWithCancellation(
      this.options.transport.postJson(
            _resolvePath(this.options.baseUrl, path),
            headers,
            requestBody,
          ),
      options.signal,
    );
    if (!response.isOk) {
      final error = _connectErrorFromResponse(response);
      if (!retriedAfterAuthenticationFailure &&
          error.statusCode == 401 &&
          retryScope != null) {
        if (await _refreshAuthenticationRetryScope(this.options, retryScope)) {
          return unaryWithSnapshot(
            path,
            body,
            decode,
            options: options,
            extraHeaders: extraHeaders,
            overrideApiKey: overrideApiKey,
            retriedAfterAuthenticationFailure: true,
            authenticationRetryScope: retryScope,
            encodedBody: requestBody,
          );
        }
      }
      throw error;
    }
    return (
      body: decode(_decodeJsonObject(response.body)),
      snapshot: ChikResponseSnapshot(
        statusCode: response.statusCode,
        body: response.body,
        headers: response.headers,
      ),
    );
  }

  Future<_ChikRawResponse> raw(
    String method,
    String path,
    ChikRawBody body,
    ChikCallOptions callOptions, {
    bool retriedAfterAuthenticationFailure = false,
    _AuthenticationRetryScope? authenticationRetryScope,
    ChikRawBody? capturedBody,
  }) async {
    final requestBody = capturedBody ??
        ChikRawBody(
          Uint8List.fromList(body.bytes),
          contentType: body.contentType,
        );
    final retryScope = authenticationRetryScope ??
        _captureAuthenticationRetryScope(this.options, callOptions, null);
    final transport = this.options.transport;
    if (transport is! ChikRawTransport) {
      throw ChikConnectError(
        ChikErrorCode.unimplemented,
        'The configured transport does not support declared raw HTTP operations.',
        statusCode: 501,
      );
    }
    final rawTransport = transport as ChikRawTransport;
    final headers = _callHeaders(
      this.options,
      callOptions,
      contentType: requestBody.contentType,
      sessionOnly: retryScope != null,
      authenticationRetryToken: retryScope?.token,
    );
    final response = await _awaitWithCancellation(
      rawTransport.request(
        _resolvePath(this.options.baseUrl, path),
        method,
        headers,
        body: requestBody.bytes,
      ),
      callOptions.signal,
    );
    if (!response.isOk) {
      final error = _connectErrorFromResponse(response);
      if (!retriedAfterAuthenticationFailure &&
          error.statusCode == 401 &&
          retryScope != null) {
        if (await _refreshAuthenticationRetryScope(this.options, retryScope)) {
          return raw(
            method,
            path,
            body,
            callOptions,
            retriedAfterAuthenticationFailure: true,
            authenticationRetryScope: retryScope,
            capturedBody: requestBody,
          );
        }
      }
      throw error;
    }
    return _ChikRawResponse(response.body);
  }

  ChikReactiveQuery<T> reactiveQuery<T>({
    required String name,
    required Object? args,
    required ChikCallOptions options,
    required Future<ChikReactiveFetchResult<T>> Function(
      ChikReactiveSubscription? subscription,
    ) fetchItems,
    required T Function(ChikJsonMap json) fromJson,
  }) {
    final bridge =
        this.options.reactive ?? ChikWebSocketReactiveBridge(this.options);
    return bridge.query<T>(
      name: name,
      args: args,
      callOptions: options,
      fetchItems: fetchItems,
      fromJson: fromJson,
    );
  }

  Stream<String> _rpcStream(
    String service,
    String method,
    Stream<Object?> request,
    ChikCallOptions callOptions,
  ) async* {
    final signal = callOptions.signal;
    if (signal?.isCancelled ?? false) {
      throw ChikConnectError(
        ChikErrorCode.canceled,
        'The RPC call was cancelled.',
      );
    }
    final transport = options.streamTransport;
    final headers = _callHeaders(
      options,
      callOptions,
      contentType: 'application/json',
    );
    final connection = transport.openStream(
      _streamUrl(options.baseUrl, service, method),
      headers,
    );
    final incoming = StreamController<String>();
    final terminalAcknowledged = Completer<ChikConnectError?>();
    void failTerminalAcknowledgement(Object? cause) {
      if (terminalAcknowledged.isCompleted) return;
      terminalAcknowledged.complete(
        ChikConnectError(
          ChikErrorCode.unavailable,
          'The RPC stream closed before server cleanup completed.',
          statusCode: ChikErrorCode.unavailable.defaultHttpStatus,
          cause: cause,
        ),
      );
    }

    final incomingSubscription = connection.incoming.listen(
      (frame) {
        if (_isRpcTerminalFrame(frame) && !terminalAcknowledged.isCompleted) {
          terminalAcknowledged.complete(null);
        }
        if (!incoming.isClosed) incoming.add(frame);
      },
      onError: (Object error, StackTrace stackTrace) {
        failTerminalAcknowledgement(error);
        if (!incoming.isClosed) incoming.addError(error, stackTrace);
      },
      onDone: () {
        failTerminalAcknowledgement(null);
        if (!incoming.isClosed) unawaited(incoming.close());
      },
    );
    var requestCredit = 0;
    var requestEnded = false;
    var terminal = false;
    var cancellationRequested = false;
    final creditWaiters = <Completer<void>>[];
    void wakeCreditWaiters() {
      while (creditWaiters.isNotEmpty) {
        creditWaiters.removeAt(0).complete();
      }
    }

    Future<void> waitForRequestCredit() async {
      while (requestCredit <= 0 && !terminal && !cancellationRequested) {
        final waiter = Completer<void>();
        creditWaiters.add(waiter);
        await waiter.future;
      }
    }

    void requestCancellation() {
      if (terminal || cancellationRequested) return;
      cancellationRequested = true;
      try {
        connection.send(jsonEncode({'v': 2, 't': 'cancel'}));
      } catch (error) {
        failTerminalAcknowledgement(error);
      }
      wakeCreditWaiters();
    }

    final requestIterator = StreamIterator<Object?>(request);
    Future<void>? requestPump;
    try {
      Future<void> pumpRequests() async {
        try {
          while (await requestIterator.moveNext()) {
            await waitForRequestCredit();
            if (terminal || cancellationRequested) return;
            requestCredit -= 1;
            connection.send(
              jsonEncode({
                'v': 2,
                't': 'message',
                'data': jsonEncode(_toJsonValue(requestIterator.current)),
              }),
            );
          }
          if (!terminal && !cancellationRequested && !requestEnded) {
            requestEnded = true;
            connection.send(jsonEncode({'v': 2, 't': 'half_close'}));
          }
        } catch (_) {
          requestCancellation();
        }
      }

      connection.send(
        jsonEncode({
          'v': 2,
          't': 'start',
          'responseCredit': 16,
          if (headers['authorization'] != null)
            'authorization': headers['authorization'],
        }),
      );
      signal?.addListener(requestCancellation);
      if (signal?.isCancelled ?? false) requestCancellation();
      requestPump = pumpRequests();
      await for (final frame in incoming.stream) {
        final decoded = jsonDecode(frame);
        if (decoded is! Map)
          throw ChikConnectError(
            ChikErrorCode.internal,
            'Stream frame is not a JSON object.',
          );
        final map = _stringKeyedMap(decoded);
        if (map['v'] != 2)
          throw ChikConnectError(
            ChikErrorCode.invalidArgument,
            'Unsupported RPC stream protocol version.',
          );
        switch (map['t']) {
          case 'ready':
          case 'credit':
            final value = map['requestCredit'] ?? map['value'];
            if (value is! num || value < 1 || value > 16) {
              throw ChikConnectError(
                ChikErrorCode.invalidArgument,
                'Invalid RPC stream credit.',
              );
            }
            requestCredit += value.toInt();
            wakeCreditWaiters();
            break;
          case 'message':
            if (cancellationRequested) break;
            final data = map['data'];
            if (data is! String)
              throw ChikConnectError(
                ChikErrorCode.invalidArgument,
                'Missing stream message data.',
              );
            yield data;
            if (!terminal && !cancellationRequested)
              connection.send(
                jsonEncode({'v': 2, 't': 'response_credit', 'value': 1}),
              );
            break;
          case 'complete':
            terminal = true;
            connection.close(1000, 'complete');
            return;
          case 'error':
            terminal = true;
            connection.close(1000, 'error');
            wakeCreditWaiters();
            final wireCode = map['code'];
            final message = map['message'];
            final parsedCode = wireCode is String
                ? ChikErrorCode.fromWire(wireCode)
                : ChikErrorCode.unknown;
            final code = parsedCode.isProtocol &&
                    (parsedCode != ChikErrorCode.unknown ||
                        wireCode == ChikErrorCode.unknown.wireValue)
                ? parsedCode
                : ChikErrorCode.unknown;
            throw ChikConnectError(
              code,
              message is String ? message : 'An RPC stream error occurred.',
              statusCode: code.defaultHttpStatus,
              rawCode: wireCode is String &&
                      code == ChikErrorCode.unknown &&
                      wireCode != ChikErrorCode.unknown.wireValue
                  ? wireCode
                  : null,
            );
          default:
            throw ChikConnectError(
              ChikErrorCode.invalidArgument,
              'Invalid RPC stream frame.',
            );
        }
      }
    } finally {
      signal?.removeListener(requestCancellation);
      final waitForAcknowledgement = !terminal;
      try {
        if (waitForAcknowledgement) requestCancellation();
        try {
          await requestIterator.cancel();
        } finally {
          if (waitForAcknowledgement) {
            final failure = await terminalAcknowledged.future;
            if (failure != null) throw failure;
          }
        }
      } finally {
        terminal = true;
        wakeCreditWaiters();
        try {
          if (requestPump != null) await requestPump;
        } finally {
          await incomingSubscription.cancel();
          if (!incoming.isClosed) unawaited(incoming.close());
        }
      }
    }
  }

  Stream<T> streamCall<T>(
    String service,
    String method,
    Stream<Object?> request,
    T Function(ChikJsonMap json) decode,
    ChikCallOptions callOptions,
  ) {
    return _rpcStream(
      service,
      method,
      request,
      callOptions,
    ).map(_streamFramePayload).map(decode);
  }

  Future<T> streamCollect<T>(
    String service,
    String method,
    Stream<Object?> request,
    T Function(ChikJsonMap json) decode,
    ChikCallOptions callOptions,
  ) async {
    String? response;
    var responseCount = 0;
    await for (final frame in _rpcStream(
      service,
      method,
      request,
      callOptions,
    )) {
      responseCount += 1;
      if (responseCount > 1) {
        throw ChikConnectError(
          ChikErrorCode.internal,
          'Client-streaming RPC returned more than one response.',
        );
      }
      response = frame;
    }
    if (responseCount != 1 || response == null) {
      throw ChikConnectError(
        ChikErrorCode.internal,
        'Client-streaming RPC must return exactly one response.',
      );
    }
    return decode(_streamFramePayload(response));
  }
}

/// 생성 패키지는 고객이 선언한 서비스와 작업 이름만 전달하고,
/// 이 런타임이 연결 세부 구현을 소유합니다.
final class ChikRuntime {
  ChikRuntime(this.options, {required String apiName})
      : _apiName = apiName,
        _requester = _JsonRequester(options),
        storage = ChikStorageClient(
          baseUrl: options.baseUrl.toString(),
          apiKey: options.apiKey,
          sessionToken: options.sessionToken,
          sessionTokenProvider: options.sessionTokenProvider,
          sessionScopeProvider: options.sessionScopeProvider,
          sessionScopeLeaseProvider: options.sessionScopeLeaseProvider,
          sessionTokenRefresher: options.sessionTokenRefresher,
          headers: options.headers,
        ),
        auth = ChikAuth.withOptions(
          baseUrl: options.baseUrl.toString(),
          apiKey: options.apiKey,
          sessionToken: options.sessionToken,
          sessionTokenProvider: options.sessionTokenProvider,
          headers: options.headers,
        ) {
    realtime = ChikRealtimeClient(_requester, options);
  }

  final ChikClientOptions options;
  final String _apiName;
  final _JsonRequester _requester;
  final ChikStorageClient storage;
  final ChikAuth auth;
  late final ChikRealtimeClient realtime;

  /// Opaque local identity for generated native state that follows one sign-in.
  String? get sessionScope => options._currentSessionScope;

  ChikSessionScopeLease? get sessionScopeLease =>
      options._currentSessionScopeLease;

  Future<T> call<T>(
    String service,
    String method,
    Object? request,
    T Function(ChikJsonMap json) decode, {
    ChikCallOptions options = const ChikCallOptions(),
  }) {
    return _requester.unary(
      _servicePath(service, method),
      request,
      decode,
      options: options,
    );
  }

  Stream<T> stream<T>(
    String service,
    String method,
    Stream<Object?> request,
    T Function(ChikJsonMap json) decode, {
    ChikCallOptions options = const ChikCallOptions(),
  }) {
    return _requester.streamCall(
      _serviceName(service),
      method,
      request,
      decode,
      options,
    );
  }

  Future<T> collect<T>(
    String service,
    String method,
    Stream<Object?> request,
    T Function(ChikJsonMap json) decode, {
    ChikCallOptions options = const ChikCallOptions(),
  }) {
    return _requester.streamCollect(
      _serviceName(service),
      method,
      request,
      decode,
      options,
    );
  }

  ChikReactiveQuery<T> watchList<T, R>({
    required String service,
    required String method,
    required Object? request,
    required R Function(ChikJsonMap json) decode,
    required List<T> Function(R response) selectItems,
    required T Function(ChikJsonMap json) fromJson,
    ChikCallOptions options = const ChikCallOptions(),
  }) {
    return _requester.reactiveQuery<T>(
      name: '$service.$method',
      args: request,
      options: options,
      fetchItems: (subscription) async {
        final headers = <String, String>{reactiveSubscribeHeader: '1'};
        if (subscription != null) {
          headers[reactiveSubscriptionIdHeader] = subscription.id;
          headers[reactiveVersionHeader] = subscription.version.toString();
        }
        final result = await _requester.unaryWithSnapshot<R>(
          _servicePath(service, method),
          request,
          decode,
          extraHeaders: headers,
          options: options,
        );
        return (
          items: selectItems(result.body),
          subscription: reactiveSubscriptionFromResponse(result.snapshot),
        );
      },
      fromJson: fromJson,
    );
  }

  Future<ChikJsonMap> operation(
    ChikOperation operation,
    Object? payload, {
    Map<String, String> pathParameters = const {},
    ChikCallOptions options = const ChikCallOptions(),
  }) async {
    final response = await _requester.raw(
      operation.method,
      _operationPath(operation.path, pathParameters),
      payload is ChikRawBody ? payload : ChikRawBody.json(payload),
      options,
    );
    return response.jsonBody;
  }

  String _serviceName(String service) => '$_apiName.$service';

  String _servicePath(String service, String method) =>
      '/api/${_serviceName(service)}/$method';
}

/// 고객이 선언한 작업입니다. 네트워크 세부 구현은 이 런타임에 남습니다.
final class ChikOperation {
  const ChikOperation({
    required this.name,
    required this.method,
    required this.path,
  });

  final String name;
  final String method;
  final String path;
}

Uri _resolvePath(Uri baseUrl, String requestPath) {
  final path = baseUrl.path.replaceFirst(RegExp(r'/+$'), '');
  return baseUrl.replace(
    path: '$path$requestPath',
    query: null,
    fragment: null,
  );
}

Map<String, String> _callHeaders(
  ChikClientOptions client,
  ChikCallOptions call, {
  String? contentType,
  bool connectProtocol = false,
  Map<String, String>? extraHeaders,
  String? overrideToken,
  bool sessionOnly = false,
  String? authenticationRetryToken,
}) {
  final headers = <String, String>{
    ...client.headers,
    ...call.headers,
    if (extraHeaders != null) ...extraHeaders,
  };
  if (contentType != null) _setHeader(headers, 'content-type', contentType);
  if (connectProtocol) _setHeader(headers, 'connect-protocol-version', '1');
  final explicitToken = overrideToken ?? call.token;
  if (explicitToken != null && explicitToken.isNotEmpty) {
    _setHeader(headers, 'authorization', 'Bearer $explicitToken');
  } else if (_readHeader(headers, 'authorization') == null) {
    final token = sessionOnly
        ? authenticationRetryToken
        : authenticationRetryToken ??
            client._currentSessionToken ??
            client.apiKey;
    if (token != null && token.isNotEmpty)
      _setHeader(headers, 'authorization', 'Bearer $token');
  }
  return headers;
}

const _uncapturedJsonBody = Object();

final class _AuthenticationRetryScope {
  _AuthenticationRetryScope({
    required this.sessionScope,
    required this.lease,
    required this.token,
  });

  final String sessionScope;
  final ChikSessionScopeLease lease;
  String? token;
}

_AuthenticationRetryScope? _captureAuthenticationRetryScope(
  ChikClientOptions client,
  ChikCallOptions call,
  String? overrideToken,
) {
  if (!call.retryOnAuthenticationFailure ||
      overrideToken != null ||
      call.token != null ||
      _readHeader(client.headers, 'authorization') != null ||
      _readHeader(call.headers, 'authorization') != null ||
      client.sessionTokenProvider == null ||
      client.sessionTokenRefresher == null) {
    return null;
  }
  return _captureCurrentAuthenticationScope(client);
}

_AuthenticationRetryScope? _captureRealtimeAuthenticationScope(
  ChikClientOptions client,
  String? overrideToken,
) {
  if (overrideToken != null ||
      client.sessionTokenRefresher == null ||
      _readHeader(client.headers, 'authorization') != null) return null;
  return _captureCurrentAuthenticationScope(client);
}

_AuthenticationRetryScope? _captureCurrentAuthenticationScope(
  ChikClientOptions client,
) {
  final sessionScope = client._currentSessionScope;
  final lease = client._currentSessionScopeLease;
  final token = client._currentSessionToken;
  if (sessionScope == null || lease == null) return null;
  final scope = _AuthenticationRetryScope(
    sessionScope: sessionScope,
    lease: lease,
    token: token,
  );
  return _isAuthenticationRetryScopeCurrent(client, scope) ? scope : null;
}

bool _isAuthenticationRetryScopeCurrent(
  ChikClientOptions client,
  _AuthenticationRetryScope scope,
) {
  return scope.lease.isActive &&
      identical(client._currentSessionScopeLease, scope.lease) &&
      client._currentSessionScope == scope.sessionScope;
}

Future<bool> _refreshAuthenticationRetryScope(
  ChikClientOptions client,
  _AuthenticationRetryScope scope,
) async {
  if (!_isAuthenticationRetryScopeCurrent(client, scope)) return false;
  final token = await client.sessionTokenRefresher!(
    scope.sessionScope,
    scope.lease,
  );
  final normalized = token?.trim();
  if (normalized == null ||
      normalized.isEmpty ||
      !_isAuthenticationRetryScopeCurrent(client, scope)) {
    return false;
  }
  scope.token = normalized;
  return true;
}

void _setHeader(Map<String, String> headers, String name, String value) {
  final lower = name.toLowerCase();
  headers.removeWhere((key, _) => key.toLowerCase() == lower);
  headers[name] = value;
}

Future<T> _awaitWithCancellation<T>(
  Future<T> pending,
  ChikCancellationSignal? signal,
) {
  if (signal == null) return pending;
  if (signal.isCancelled) {
    return Future<T>.error(
      ChikConnectError(ChikErrorCode.canceled, 'The RPC call was cancelled.'),
    );
  }
  final result = Completer<T>();
  var completed = false;
  late void Function() cancel;
  cancel = () {
    if (completed) return;
    completed = true;
    result.completeError(
      ChikConnectError(ChikErrorCode.canceled, 'The RPC call was cancelled.'),
    );
    signal.removeListener(cancel);
  };
  signal.addListener(cancel);
  unawaited(() async {
    try {
      final value = await pending;
      if (!completed) {
        completed = true;
        result.complete(value);
      }
    } catch (error, stackTrace) {
      if (!completed) {
        completed = true;
        result.completeError(error, stackTrace);
      }
    } finally {
      signal.removeListener(cancel);
    }
  }());
  if (signal.isCancelled) cancel();
  return result.future;
}

ChikJsonMap _decodeJsonObject(String body) {
  if (body.isEmpty) return <String, Object?>{};
  try {
    final decoded = jsonDecode(body);
    if (decoded is Map) return _stringKeyedMap(decoded);
  } catch (_) {
    // Normalize malformed JSON to the generated client error contract.
  }
  throw ChikConnectError(
      ChikErrorCode.internal, 'JSON object response expected.');
}

ChikConnectError _connectErrorFromResponse(ChikTransportResponse response) {
  final fallbackCode = _connectCodeFromStatus(response.statusCode);
  var code = fallbackCode;
  String? rawCode;
  var message =
      response.body.isEmpty ? 'HTTP ${response.statusCode}' : response.body;
  Object? details;
  try {
    final decoded = jsonDecode(response.body);
    if (decoded is Map) {
      final value = _stringKeyedMap(decoded);
      final declaredCode = value['code'];
      if (declaredCode is String && declaredCode.isNotEmpty) {
        final parsedCode = ChikErrorCode.fromWire(declaredCode);
        if (parsedCode.isProtocol &&
            (parsedCode != ChikErrorCode.unknown ||
                declaredCode == ChikErrorCode.unknown.wireValue)) {
          code = parsedCode;
        } else {
          code = ChikErrorCode.unknown;
          rawCode = declaredCode;
        }
      }
      final declaredMessage = value['message'];
      if (declaredMessage is String && declaredMessage.isNotEmpty)
        message = declaredMessage;
      if (value.containsKey('details')) details = value['details'];
    }
  } catch (_) {
    // Keep the non-JSON response text as the protocol error message.
  }
  return ChikConnectError(
    code,
    message,
    rawCode: rawCode,
    statusCode: response.statusCode,
    details: details,
  );
}

String _operationPath(String template, Map<String, String> parameters) {
  var path = template;
  for (final entry in parameters.entries) {
    path = path.replaceAll('{${entry.key}}', Uri.encodeComponent(entry.value));
  }
  if (RegExp(r'\{[A-Za-z][A-Za-z0-9]*\}').hasMatch(path)) {
    throw ChikConnectError(
      ChikErrorCode.invalidArgument,
      'A raw operation path parameter is missing.',
    );
  }
  return path;
}

List<T> _reactiveSnapshotItems<T>(
  Object? value,
  T Function(ChikJsonMap json) fromJson,
) {
  final rows = <ChikJsonMap>[];
  void collect(Object? candidate) {
    if (candidate is Map) {
      final values = candidate['values'];
      if (values is List) {
        for (final item in values) {
          if (item is Map) rows.add(_stringKeyedMap(item));
        }
        return;
      }
      for (final child in candidate.values) {
        collect(child);
      }
    } else if (candidate is List) {
      if (candidate.every((item) => item is Map)) {
        for (final item in candidate) {
          rows.add(_stringKeyedMap(item as Map));
        }
        return;
      }
      for (final child in candidate) {
        collect(child);
      }
    }
  }

  collect(value);
  return rows.map(fromJson).toList(growable: false);
}

Uri _reactiveUrl(
  Uri baseUrl,
  ChikReactiveSubscription subscription,
  bool frameAuth,
) {
  final path = baseUrl.path.replaceFirst(RegExp(r'/+$'), '');
  final query = <String, String>{
    'subscription_id': subscription.id,
    'identity_key': subscription.identityKey,
    'query_hash': subscription.queryHash,
    if (frameAuth) 'frame_auth': '1',
  };
  return baseUrl.replace(
    scheme: baseUrl.scheme == 'https' ? 'wss' : 'ws',
    path: '$path/_chik/reactive',
    queryParameters: query,
    fragment: null,
  );
}

Map<String, String> _realtimeHeaders(
  Map<String, String> configured,
  String? authorization,
) {
  final headers = <String, String>{...configured};
  if (authorization != null && authorization.isNotEmpty)
    _setHeader(headers, 'authorization', authorization);
  return headers;
}

String? _realtimeAuthorization(
  String? explicitToken,
  Map<String, String> headers,
  ChikClientOptions client,
  _AuthenticationRetryScope? scope,
) {
  if (explicitToken != null && explicitToken.isNotEmpty)
    return 'Bearer $explicitToken';
  final authorization = _readHeader(headers, 'authorization');
  if (authorization != null &&
      RegExp(r'^Bearer\s+\S+$', caseSensitive: false).hasMatch(authorization)) {
    return authorization;
  }
  final sessionToken =
      scope == null ? client._currentSessionToken : scope.token;
  if (sessionToken != null) return 'Bearer $sessionToken';
  if (scope != null) return null;
  final apiKey = client.apiKey;
  return apiKey == null || apiKey.isEmpty ? null : 'Bearer $apiKey';
}

Future<bool> _refreshRealtimeAuthorization(
  ChikClientOptions options,
  String? overrideToken,
  _AuthenticationRetryScope? scope,
) async {
  if (overrideToken != null ||
      scope == null ||
      !_isAuthenticationRetryScopeCurrent(options, scope)) {
    return false;
  }
  return _refreshAuthenticationRetryScope(options, scope);
}

Uri _realtimeChannelUrl(
  Uri baseUrl,
  String channel,
  int lastSeq,
  bool frameAuth,
) {
  final path = baseUrl.path.replaceFirst(RegExp(r'/+$'), '');
  return baseUrl.replace(
    scheme: baseUrl.scheme == 'https' ? 'wss' : 'ws',
    path: '$path/v1/realtime/${Uri.encodeComponent(channel)}',
    queryParameters: <String, String>{
      'last_seq': lastSeq.toString(),
      if (frameAuth) 'frame_auth': '1',
    },
    fragment: null,
  );
}

Uri _realtimeConnectionUrl(Uri baseUrl, bool frameAuth) {
  final path = baseUrl.path.replaceFirst(RegExp(r'/+$'), '');
  return baseUrl.replace(
    scheme: baseUrl.scheme == 'https' ? 'wss' : 'ws',
    path: '$path/v1/realtime',
    queryParameters: <String, String>{if (frameAuth) 'frame_auth': '1'},
    fragment: null,
  );
}

int _realtimeSequence(int value) {
  if (value < 0) {
    throw ChikConnectError(
      ChikErrorCode.invalidArgument,
      'lastSeq must be a non-negative integer.',
      statusCode: 400,
    );
  }
  return value;
}

ChikJsonMap _realtimeFrame(String frame) {
  final decoded = jsonDecode(frame);
  if (decoded is! Map) {
    throw ChikConnectError(
      ChikErrorCode.dataLoss,
      'Realtime WebSocket frame is not a JSON object.',
    );
  }
  return _stringKeyedMap(decoded);
}

ChikRealtimeProtocolError _realtimeProtocolError(ChikJsonMap value) {
  final declared = value['code'];
  final declaredCode = ChikErrorCode.fromWire(declared);
  final code = declaredCode.isProtocol ||
          declaredCode == ChikErrorCode.unauthorized ||
          declaredCode == ChikErrorCode.channelLimit ||
          declaredCode == ChikErrorCode.payloadTooLarge
      ? declaredCode
      : ChikErrorCode.unknown;
  final message = value['message'];
  return ChikRealtimeProtocolError(
    code: code,
    rawCode: declared is String &&
            code == ChikErrorCode.unknown &&
            declared != ChikErrorCode.unknown
        ? declared
        : null,
    message: message is String && message.isNotEmpty
        ? message
        : 'A realtime protocol error occurred.',
  );
}

// Builds WebSocket URL for streaming RPCs. Replaces http(s) base with ws(s).
Uri _streamUrl(Uri baseUrl, String service, String method) {
  final path = baseUrl.path.replaceFirst(RegExp(r'/+$'), '');
  return baseUrl.replace(
    scheme: baseUrl.scheme == 'https' ? 'wss' : 'ws',
    path: '$path/api/_chik/rpc-stream/$service/$method',
    query: null,
    fragment: null,
  );
}

bool _isRpcTerminalFrame(String frame) {
  try {
    final decoded = jsonDecode(frame);
    if (decoded is! Map || decoded['v'] != 2) return false;
    return decoded['t'] == 'complete' || decoded['t'] == 'error';
  } catch (_) {
    return false;
  }
}

// Extracts payload from stream frame and converts error frames to ChikConnectError.
ChikJsonMap _streamFramePayload(String frame) {
  final decoded = jsonDecode(frame);
  if (decoded is! Map) {
    throw ChikConnectError(
        ChikErrorCode.internal, 'Stream frame is not a JSON object.');
  }
  final map = _stringKeyedMap(decoded);
  return map;
}

ChikErrorCode _connectCodeFromStatus(int statusCode) {
  if (statusCode == 400) return ChikErrorCode.invalidArgument;
  if (statusCode == 401) return ChikErrorCode.unauthenticated;
  if (statusCode == 403) return ChikErrorCode.permissionDenied;
  if (statusCode == 404) return ChikErrorCode.notFound;
  if (statusCode == 409) return ChikErrorCode.aborted;
  if (statusCode == 412) return ChikErrorCode.failedPrecondition;
  if (statusCode == 429) return ChikErrorCode.resourceExhausted;
  if (statusCode == 499) return ChikErrorCode.canceled;
  if (statusCode == 502 || statusCode == 503) return ChikErrorCode.unavailable;
  if (statusCode == 504) return ChikErrorCode.deadlineExceeded;
  return ChikErrorCode.internal;
}

Object? _toJsonValue(Object? value) {
  if (value == null || value is String || value is num || value is bool)
    return value;
  if (value is List) return value.map(_toJsonValue).toList();
  if (value is Map) {
    return {
      for (final entry in value.entries)
        entry.key.toString(): _toJsonValue(entry.value),
    };
  }
  try {
    return _toJsonValue((value as dynamic).toJson());
  } catch (_) {
    throw ChikConnectError(
      ChikErrorCode.invalidArgument,
      'Cannot convert to JSON: ${value.runtimeType}',
    );
  }
}

ChikJsonMap _stringKeyedMap(Map<dynamic, dynamic> value) {
  return {for (final entry in value.entries) entry.key.toString(): entry.value};
}

int _readInt(ChikJsonMap json, String field) {
  final value = json[field];
  if (value is int) return value;
  if (value is num) return value.toInt();
  throw ChikConnectError(ChikErrorCode.internal, 'Expected int for $field');
}

// _wire* helpers follow protobuf JSON representation directly.
// List fields use values wrapper, nullable fields use value or sqlNull wrappers.
// Dart unwraps/wraps these explicitly as it has no native protobuf runtime.

ChikJsonMap _wireJsonMap(Object? value) {
  if (value is Map) return _stringKeyedMap(value);
  throw ChikConnectError(ChikErrorCode.internal, 'Expected object value');
}

String _wireString(Object? value) {
  if (value is String) return value;
  throw ChikConnectError(ChikErrorCode.internal, 'Expected string value');
}

int _wireInt(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  if (value is String) {
    final parsed = int.tryParse(value);
    if (parsed != null) return parsed;
  }
  throw ChikConnectError(ChikErrorCode.internal, 'Expected int value');
}

double _wireDouble(Object? value) {
  if (value is num) return value.toDouble();
  if (value is String) {
    final parsed = double.tryParse(value);
    if (parsed != null) return parsed;
  }
  throw ChikConnectError(ChikErrorCode.internal, 'Expected double value');
}

bool _wireBool(Object? value) {
  if (value is bool) return value;
  throw ChikConnectError(ChikErrorCode.internal, 'Expected bool value');
}

T _wireValue<T>(
  ChikJsonMap json,
  String field,
  T Function(Object? value) decode,
) {
  final value = json[field];
  if (value == null)
    throw ChikConnectError(ChikErrorCode.internal, 'Expected value for $field');
  return decode(value);
}

T? _wireOptionalValue<T>(
  ChikJsonMap json,
  String field,
  T Function(Object? value) decode,
) {
  final value = json[field];
  return value == null ? null : decode(value);
}

List<T>? _wireOptionalListValues<T>(
  ChikJsonMap json,
  String field,
  T Function(Object? value) decode,
) {
  final wrapper = json[field];
  if (wrapper == null) return null;
  return _wireUnwrapList(_wireJsonMap(wrapper)['values'], field, decode);
}

List<T> _wireListValues<T>(
  ChikJsonMap json,
  String field,
  T Function(Object? value) decode,
) {
  return _wireOptionalListValues(json, field, decode) ?? <T>[];
}

T? _wireNullableValue<T>(
  ChikJsonMap json,
  String field,
  T Function(Object? value) decode,
) {
  final wrapper = json[field];
  if (wrapper == null) return null;
  final map = _wireJsonMap(wrapper);
  if (_wireIsSqlNull(map)) return null;
  final value = map['value'];
  return value == null ? null : decode(value);
}

List<T>? _wireNullableListValues<T>(
  ChikJsonMap json,
  String field,
  T Function(Object? value) decode,
) {
  final wrapper = json[field];
  if (wrapper == null) return null;
  final map = _wireJsonMap(wrapper);
  if (_wireIsSqlNull(map)) return null;
  final list = map['list'];
  if (list == null) return <T>[];
  return _wireUnwrapList(_wireJsonMap(list)['values'], field, decode) ?? <T>[];
}

bool _wireIsSqlNull(ChikJsonMap wrapper) {
  return wrapper.containsKey('sqlNull') || wrapper.containsKey('sql_null');
}

List<T>? _wireUnwrapList<T>(
  Object? values,
  String field,
  T Function(Object? value) decode,
) {
  if (values == null) return <T>[];
  if (values is! List)
    throw ChikConnectError(
        ChikErrorCode.internal, 'Expected list wrapper for $field');
  return values.map(decode).toList(growable: false);
}

ChikJsonMap _wireListJson<T>(List<T> values, Object? Function(T value) encode) {
  return {'values': values.map(encode).toList(growable: false)};
}

ChikJsonMap _wireNullableJson<T>(T? value, Object? Function(T value) encode) {
  return value == null
      ? const <String, Object?>{'sqlNull': null}
      : {'value': encode(value)};
}

ChikJsonMap _wireNullableListJson<T>(
  List<T>? values,
  Object? Function(T value) encode,
) {
  return values == null
      ? const <String, Object?>{'sqlNull': null}
      : {'list': _wireListJson(values, encode)};
}

/// 생성된 고객 모델이 사용하는 JSON 변환입니다. 표현 세부는 여기에서 관리해
/// 생성 패키지에는 모델과 타입 파사드만 남깁니다.
abstract final class ChikJson {
  static ChikJsonMap object(Object? value) => _wireJsonMap(value);

  static String string(Object? value) => _wireString(value);

  static int integer(Object? value) => _wireInt(value);

  static double decimal(Object? value) => _wireDouble(value);

  static bool boolean(Object? value) => _wireBool(value);

  static T required<T>(
    ChikJsonMap json,
    String field,
    T Function(Object? value) decode,
  ) {
    return _wireValue(json, field, decode);
  }

  static T? optional<T>(
    ChikJsonMap json,
    String field,
    T Function(Object? value) decode,
  ) {
    return _wireOptionalValue(json, field, decode);
  }

  static List<T> list<T>(
    ChikJsonMap json,
    String field,
    T Function(Object? value) decode,
  ) {
    return _wireListValues(json, field, decode);
  }

  static List<T>? optionalList<T>(
    ChikJsonMap json,
    String field,
    T Function(Object? value) decode,
  ) {
    return _wireOptionalListValues(json, field, decode);
  }

  static T? nullable<T>(
    ChikJsonMap json,
    String field,
    T Function(Object? value) decode,
  ) {
    return _wireNullableValue(json, field, decode);
  }

  static List<T>? nullableList<T>(
    ChikJsonMap json,
    String field,
    T Function(Object? value) decode,
  ) {
    return _wireNullableListValues(json, field, decode);
  }

  static ChikJsonMap listValue<T>(
    List<T> values,
    Object? Function(T value) encode,
  ) {
    return _wireListJson(values, encode);
  }

  static ChikJsonMap nullableValue<T>(
    T? value,
    Object? Function(T value) encode,
  ) {
    return _wireNullableJson(value, encode);
  }

  static ChikJsonMap nullableListValue<T>(
    List<T>? values,
    Object? Function(T value) encode,
  ) {
    return _wireNullableListJson(values, encode);
  }
}
