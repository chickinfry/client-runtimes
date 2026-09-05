import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:chik_client/chik_client.dart';
import 'package:test/test.dart';

void main() {
  test('error contract keeps typed codes and causes', () {
    final cause = StateError('transport closed');
    final error = ChikConnectError(
      ChikErrorCode.unavailable,
      'The request could not be sent.',
      statusCode: 503,
      cause: cause,
    );

    expect(error.code, ChikErrorCode.unavailable);
    expect(error.cause, same(cause));
    expect(
        ChikErrorCode.fromWire('future_provider_code'), ChikErrorCode.unknown);
    expect(ChikErrorCode.networkFailure.isProtocol, isFalse);
  });

  test('a marked raw operation refreshes and replays one JSON request',
      () async {
    var token = 'expired';
    var refreshCalls = 0;
    const sessionScope = 'session-a';
    final lease = ChikSessionScopeLease(sessionScope);
    final transport = _RawRetryTransport(() => token);
    final runtime = ChikRuntime(
      ChikClientOptions(
        baseUrl: Uri.parse('https://app.example.test'),
        transport: transport,
        sessionTokenProvider: () => token,
        sessionScopeProvider: () => sessionScope,
        sessionScopeLeaseProvider: () => lease,
        sessionTokenRefresher: (_, __) async {
          refreshCalls += 1;
          token = 'refreshed';
          return token;
        },
      ),
      apiName: 'app.test.v1',
    );

    final result = await runtime.operation(
      const ChikOperation(
        name: 'confirmPayment',
        method: 'POST',
        path: '/api/payments/confirm',
      ),
      const <String, Object?>{'requestId': 'request'},
      options: const ChikCallOptions(
        retryOnAuthenticationFailure: true,
      ),
    );

    expect(result, <String, Object?>{'paymentId': 'payment'});
    expect(refreshCalls, 1);
    expect(transport.authorization,
        <String>['Bearer expired', 'Bearer refreshed']);
    expect(transport.bodies, <String>[
      jsonEncode(<String, Object?>{'requestId': 'request'}),
      jsonEncode(<String, Object?>{'requestId': 'request'}),
    ]);
  });

  test('a marked unary operation captures one request body for its retry',
      () async {
    var token = 'expired';
    var encodedBodies = 0;
    const sessionScope = 'session-a';
    final lease = ChikSessionScopeLease(sessionScope);
    final transport = _UnaryRetryTransport(() => token);
    final runtime = ChikRuntime(
      ChikClientOptions(
        baseUrl: Uri.parse('https://app.example.test'),
        transport: transport,
        sessionTokenProvider: () => token,
        sessionScopeProvider: () => sessionScope,
        sessionScopeLeaseProvider: () => lease,
        sessionTokenRefresher: (_, __) async => token = 'refreshed',
      ),
      apiName: 'app.test.v1',
    );

    final result = await runtime.call(
      'Notes',
      'Get',
      _ChangingPayload(() => ++encodedBodies),
      (json) => json,
      options: const ChikCallOptions(retryOnAuthenticationFailure: true),
    );

    expect(result, <String, Object?>{'id': 'note-1'});
    expect(encodedBodies, 1);
    expect(transport.bodies, <String>[
      '{"requestId":"request-1"}',
      '{"requestId":"request-1"}',
    ]);
  });

  test('raw retry never crosses a replaced native session', () async {
    var token = 'expired-a';
    var sessionScope = 'session-a';
    var lease = ChikSessionScopeLease(sessionScope);
    var refreshCalls = 0;
    final transport = _RawRetryTransport(
      () => token,
      onUnauthorized: () {
        lease.invalidate();
        sessionScope = 'session-b';
        lease = ChikSessionScopeLease(sessionScope);
        token = 'new-session-b';
      },
    );
    final runtime = ChikRuntime(
      ChikClientOptions(
        baseUrl: Uri.parse('https://app.example.test'),
        transport: transport,
        sessionTokenProvider: () => token,
        sessionScopeProvider: () => sessionScope,
        sessionScopeLeaseProvider: () => lease,
        sessionTokenRefresher: (_, __) async {
          refreshCalls += 1;
          return 'unexpected-refresh';
        },
      ),
      apiName: 'app.test.v1',
    );

    await expectLater(
      runtime.operation(
        const ChikOperation(
          name: 'confirmPayment',
          method: 'POST',
          path: '/api/payments/confirm',
        ),
        const <String, Object?>{'requestId': 'request'},
        options: const ChikCallOptions(
          retryOnAuthenticationFailure: true,
        ),
      ),
      throwsA(isA<ChikConnectError>().having(
        (error) => error.statusCode,
        'statusCode',
        401,
      )),
    );
    expect(refreshCalls, 0);
    expect(transport.authorization, <String>['Bearer expired-a']);
  });

  test('raw retry stops after a second 401 and ignores explicit credentials',
      () async {
    var token = 'expired';
    var refreshCalls = 0;
    const sessionScope = 'session-a';
    final lease = ChikSessionScopeLease(sessionScope);
    final transport = _RawRetryTransport(
      () => token,
      alwaysUnauthorized: true,
    );
    final runtime = ChikRuntime(
      ChikClientOptions(
        baseUrl: Uri.parse('https://app.example.test'),
        transport: transport,
        sessionTokenProvider: () => token,
        sessionScopeProvider: () => sessionScope,
        sessionScopeLeaseProvider: () => lease,
        sessionTokenRefresher: (_, __) async {
          refreshCalls += 1;
          token = 'refreshed';
          return token;
        },
      ),
      apiName: 'app.test.v1',
    );
    const operation = ChikOperation(
      name: 'confirmPayment',
      method: 'POST',
      path: '/api/payments/confirm',
    );

    await expectLater(
      runtime.operation(
        operation,
        const <String, Object?>{'requestId': 'request'},
        options: const ChikCallOptions(
          retryOnAuthenticationFailure: true,
        ),
      ),
      throwsA(isA<ChikConnectError>()),
    );
    expect(refreshCalls, 1);
    expect(transport.authorization.length, 2);

    await expectLater(
      runtime.operation(
        operation,
        const <String, Object?>{'requestId': 'explicit'},
        options: const ChikCallOptions(
          token: 'explicit-token',
          retryOnAuthenticationFailure: true,
        ),
      ),
      throwsA(isA<ChikConnectError>()),
    );
    expect(refreshCalls, 1);
    expect(transport.authorization.last, 'Bearer explicit-token');
  });

  test('a request started during refresh never falls back to an API key',
      () async {
    String? token;
    const sessionScope = 'session-a';
    final lease = ChikSessionScopeLease(sessionScope);
    final transport = _RawRetryTransport(() => token);
    var refreshCalls = 0;
    final runtime = ChikRuntime(
      ChikClientOptions(
        baseUrl: Uri.parse('https://app.example.test'),
        transport: transport,
        apiKey: 'must-not-be-used',
        sessionTokenProvider: () => token,
        sessionScopeProvider: () => sessionScope,
        sessionScopeLeaseProvider: () => lease,
        sessionTokenRefresher: (_, __) async {
          refreshCalls += 1;
          token = 'refreshed';
          return 'refreshed';
        },
      ),
      apiName: 'app.test.v1',
    );

    await runtime.operation(
      const ChikOperation(
        name: 'confirmPayment',
        method: 'POST',
        path: '/api/payments/confirm',
      ),
      const <String, Object?>{'requestId': 'request'},
      options: const ChikCallOptions(retryOnAuthenticationFailure: true),
    );

    expect(refreshCalls, 1);
    expect(transport.authorization, <String>['', 'Bearer refreshed']);
  });

  test('realtime refreshes one captured session only once', () async {
    var token = 'expired';
    var refreshCalls = 0;
    const sessionScope = 'session-a';
    final lease = ChikSessionScopeLease(sessionScope);
    final streamTransport = _RealtimeTransport();
    final errors = <ChikRealtimeProtocolError>[];
    final runtime = ChikRuntime(
      ChikClientOptions(
        baseUrl: Uri.parse('https://app.example.test'),
        apiKey: 'must-not-be-used',
        sessionTokenProvider: () => token,
        sessionScopeProvider: () => sessionScope,
        sessionScopeLeaseProvider: () => lease,
        sessionTokenRefresher: (_, __) async {
          refreshCalls += 1;
          token = 'refreshed';
          return token;
        },
        streamTransport: streamTransport,
      ),
      apiName: 'app.test.v1',
    );

    final subscription = runtime.realtime.subscribe(
      'notes',
      ChikRealtimeSubscribeOptions(
        onEvent: (_) {},
        onGap: (_) {},
        onError: errors.add,
      ),
    );
    await Future<void>.delayed(Duration.zero);
    expect(streamTransport.connections.single.authorization, 'Bearer expired');
    streamTransport.connections.single.emitError('expired');
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);

    expect(streamTransport.connections, hasLength(2));
    expect(streamTransport.connections.last.authorization, 'Bearer refreshed');
    streamTransport.connections.last.emitError('expired again');
    await Future<void>.delayed(Duration.zero);

    expect(refreshCalls, 1);
    expect(streamTransport.connections, hasLength(2));
    expect(errors.last.code, ChikErrorCode.unauthorized);
    subscription.close();
  });
}

final class _ChangingPayload {
  const _ChangingPayload(this.next);

  final int Function() next;

  Map<String, Object?> toJson() => {'requestId': 'request-${next()}'};
}

final class _UnaryRetryTransport implements ChikTransport {
  _UnaryRetryTransport(this._token);

  final String Function() _token;
  final bodies = <String>[];

  @override
  Future<ChikTransportResponse> postJson(
    Uri url,
    Map<String, String> headers,
    Object? body,
  ) async {
    bodies.add(jsonEncode(body));
    return _token() == 'refreshed'
        ? const ChikTransportResponse(statusCode: 200, body: '{"id":"note-1"}')
        : const ChikTransportResponse(
            statusCode: 401,
            body: '{"code":"unauthenticated","message":"expired"}',
          );
  }
}

final class _RawRetryTransport implements ChikTransport, ChikRawTransport {
  _RawRetryTransport(
    this._token, {
    this.alwaysUnauthorized = false,
    this.onUnauthorized,
  });

  final String? Function() _token;
  final bool alwaysUnauthorized;
  final void Function()? onUnauthorized;
  final authorization = <String>[];
  final bodies = <String>[];
  var _unauthorizedNotified = false;

  @override
  Future<ChikTransportResponse> postJson(
    Uri url,
    Map<String, String> headers,
    Object? body,
  ) =>
      throw UnsupportedError('RPC transport is not used by this test.');

  @override
  Future<ChikTransportResponse> request(
    Uri url,
    String method,
    Map<String, String> headers, {
    Uint8List? body,
  }) async {
    authorization.add(headers['authorization'] ?? '');
    bodies.add(utf8.decode(body ?? Uint8List(0)));
    if (alwaysUnauthorized || _token() != 'refreshed') {
      if (!_unauthorizedNotified) {
        _unauthorizedNotified = true;
        onUnauthorized?.call();
      }
      return const ChikTransportResponse(
        statusCode: 401,
        body: '{"code":"unauthenticated","message":"expired"}',
      );
    }
    return const ChikTransportResponse(
      statusCode: 200,
      body: '{"paymentId":"payment"}',
    );
  }
}

final class _RealtimeTransport implements ChikStreamTransport {
  final connections = <_RealtimeConnection>[];

  @override
  ChikStreamConnection openStream(Uri url, Map<String, String> headers) {
    final connection = _RealtimeConnection();
    connections.add(connection);
    return connection;
  }
}

final class _RealtimeConnection implements ChikStreamConnection {
  final _incoming = StreamController<String>.broadcast();
  final sent = <Map<String, Object?>>[];

  String? get authorization {
    final values = sent
        .where((frame) => frame['t'] == 'auth')
        .map((frame) => frame['authorization'])
        .whereType<String>();
    return values.isEmpty ? null : values.first;
  }

  @override
  Stream<String> get incoming => _incoming.stream;

  @override
  void send(String frame) {
    sent.add((jsonDecode(frame) as Map).cast<String, Object?>());
  }

  void emitError(String message) {
    _incoming.add(jsonEncode(<String, Object?>{
      't': 'error',
      'code': 'unauthorized',
      'message': message,
    }));
  }

  @override
  void close([int code = 1000, String reason = '']) {
    unawaited(_incoming.close());
  }
}
