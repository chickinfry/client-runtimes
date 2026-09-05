import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:chik_client/chik_client.dart';
import 'package:test/test.dart';

const _firstSessionScope =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const _secondSessionScope =
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

void main() {
  test(
    'native GitHub OAuth accepts one verified callback and stores the session',
    () async {
      String? stored;
      var completionCalls = 0;
      var refreshCalls = 0;
      final clearedScopes = <String>[];
      final localLifecycle = <String>[];
      final auth = ChikNativeAuth(
        baseUrl: 'https://app.example.test',
        sessionStore: ChikNativeSessionStore.json(
          read: () async => stored,
          write: (value) async => stored = value,
          delete: () async {
            localLifecycle.add('session');
            stored = null;
          },
          deleteSessionScope: (scope) async {
            localLifecycle.add('scope:$scope');
            clearedScopes.add(scope);
          },
        ),
        fetch: (
          method,
          url, {
          headers,
          body,
        }) async {
          final path = Uri.parse(url).path;
          if (method == 'POST' && path == '/api/auth/native/github/start') {
            return _jsonResponse(<String, Object?>{
              'authorizationUrl': 'https://github.example.test/login',
              'state': 'state',
              'browserNonce': 'nonce',
              'pkceVerifier': 'verifier',
              'expiresAt': '2099-01-01T00:00:00Z',
              'redirectUri':
                  'https://app.example.test/api/auth/github/callback',
            });
          }
          if (method == 'POST' && path == '/api/auth/native/github/complete') {
            completionCalls += 1;
            final input =
                jsonDecode(utf8.decode(body!)) as Map<String, Object?>;
            expect(input, <String, Object?>{
              'code': 'code',
              'state': 'state',
              'browserNonce': 'nonce',
              'pkceVerifier': 'verifier',
            });
            return _jsonResponse(_nativeSessionJson());
          }
          if (method == 'POST' && path == '/api/auth/refresh') {
            refreshCalls += 1;
            return _jsonResponse(<String, Object?>{
              ..._nativeSessionJson(),
              'sessionToken': 'access-refreshed',
              'refreshToken': 'refresh-refreshed',
            }..remove('sessionScope'));
          }
          if (method == 'POST' && path == '/api/auth/native/sign-in') {
            return _jsonResponse(<String, Object?>{
              ..._nativeSessionJson(),
              'sessionToken': 'second-access',
              'refreshToken': 'second-refresh',
              'sessionScope': _secondSessionScope,
            });
          }
          if (method == 'POST' && path == '/api/auth/sign-out') {
            return _jsonResponse(<String, Object?>{'signedOut': true});
          }
          return _jsonResponse(<String, Object?>{
            'code': 'not_found',
            'message': 'not found',
          }, status: 404);
        },
      );

      final transaction = await auth.startGitHubNative();
      expect(
        transaction.matchesRedirect(
          'https://app.example.test/api/auth/github/callback?code=code&state=wrong',
        ),
        isFalse,
      );
      await expectLater(
        transaction.complete(
          'https://app.example.test/api/auth/github/callback?code=code&state=state&state=state',
        ),
        throwsA(
          isA<ChikAuthError>().having((error) => error.status, 'status', 401),
        ),
      );
      expect(completionCalls, 0);

      final session = await transaction.complete(
        'https://app.example.test/api/auth/github/callback?code=code&state=state',
      );
      expect(session.user.userId, 'user');
      expect(completionCalls, 1);
      final storedSession = jsonDecode(stored!) as Map<String, Object?>;
      expect(storedSession, containsPair('refreshToken', 'refresh'));
      expect(storedSession['sessionScope'], _firstSessionScope);
      final sessionScope = storedSession['sessionScope'] as String;
      expect(auth.sessionScopeProvider(), sessionScope);
      final firstSessionLease = auth.sessionScopeLeaseProvider()!;
      expect(firstSessionLease.isActive, isTrue);
      await auth.refreshSession();
      final refreshed = jsonDecode(stored!) as Map<String, Object?>;
      expect(refreshed['sessionToken'], 'access-refreshed');
      expect(refreshed['sessionScope'], sessionScope);
      expect(refreshCalls, 1);
      await auth.signIn('second@example.test', 'password');
      final secondSession = jsonDecode(stored!) as Map<String, Object?>;
      final secondSessionScope = secondSession['sessionScope'];
      expect(secondSessionScope, _secondSessionScope);
      expect(firstSessionLease.isActive, isFalse);
      final secondSessionLease = auth.sessionScopeLeaseProvider()!;
      expect(secondSessionLease.isActive, isTrue);
      expect(clearedScopes, <String>[sessionScope]);
      await auth.signOut();
      expect(stored, isNull);
      expect(auth.sessionScopeProvider(), isNull);
      expect(secondSessionLease.isActive, isFalse);
      expect(clearedScopes, <String>[
        sessionScope,
        secondSessionScope as String,
      ]);
      expect(
        localLifecycle.sublist(localLifecycle.length - 2),
        <String>['scope:$secondSessionScope', 'session'],
      );

      await expectLater(
        transaction.complete(
          'https://app.example.test/api/auth/github/callback?code=code&state=state',
        ),
        throwsA(
          isA<ChikAuthError>().having((error) => error.status, 'status', 412),
        ),
      );
      expect(completionCalls, 1);
    },
  );

  test('native sign-in requires a server-issued session scope', () async {
    String? stored;
    final auth = ChikNativeAuth(
      baseUrl: 'https://app.example.test',
      sessionStore: ChikNativeSessionStore.json(
        read: () async => stored,
        write: (value) async => stored = value,
        delete: () async => stored = null,
        deleteSessionScope: (_) async {},
      ),
      fetch: (method, url, {headers, body}) async {
        final response = _nativeSessionJson()..remove('sessionScope');
        return _jsonResponse(response);
      },
    );

    await expectLater(
      auth.signIn('user@example.test', 'password'),
      throwsA(
        isA<ChikAuthError>()
            .having(
              (error) => error.code,
              'code',
              ChikErrorCode.invalidResponse,
            )
            .having((error) => error.status, 'status', 502),
      ),
    );
    expect(stored, isNull);
  });

  test('same-scope restore and refresh preserve the checkout lease', () async {
    String? stored;
    final refresh = Completer<ChikAuthResponse>();
    final refreshStarted = Completer<void>();
    final auth = _concurrentAuth(
      read: () async => stored,
      write: (value) async => stored = value,
      delete: () async => stored = null,
      deleteSessionScope: (_) async {},
      fetch: (method, path) {
        if (method == 'GET' && path == '/api/auth/session') {
          return Future.value(
            _jsonResponse(_remoteSessionJson(userId: 'user')),
          );
        }
        if (method == 'POST' && path == '/api/auth/refresh') {
          refreshStarted.complete();
          return refresh.future;
        }
        throw StateError('unexpected request: $method $path');
      },
    );

    await auth.acceptSession(AuthSession.fromJson(_nativeSessionJson()));
    final lease = auth.sessionScopeLeaseProvider()!;
    await auth.onAppForeground();
    expect(lease.isActive, isTrue);
    expect(auth.sessionScopeLeaseProvider(), same(lease));

    final refreshing = auth.refreshSession();
    await refreshStarted.future;
    expect(lease.isActive, isTrue);
    refresh.complete(_jsonResponse(_nativeSessionJson(
      sessionToken: 'refreshed-access',
      refreshToken: 'refreshed-refresh',
    )..remove('sessionScope')));
    await refreshing;
    expect(lease.isActive, isTrue);
    expect(auth.sessionScopeLeaseProvider(), same(lease));
  });

  test('refresh drains prior writes and persists a marker before rotation',
      () async {
    String? stored;
    final priorWriteStarted = Completer<void>();
    final releasePriorWrite = Completer<void>();
    var writes = 0;
    var refreshCalls = 0;
    final auth = _concurrentAuth(
      read: () async => stored,
      write: (value) async {
        writes += 1;
        if (writes == 1) {
          priorWriteStarted.complete();
          await releasePriorWrite.future;
        }
        stored = value;
      },
      delete: () async => stored = null,
      deleteSessionScope: (_) async {},
      fetch: (method, path) {
        if (method == 'POST' && path == '/api/auth/refresh') {
          refreshCalls += 1;
          expect(jsonDecode(stored!), <String, Object?>{
            'kind': 'cleanup',
            'sessionScope': _firstSessionScope,
          });
          return Future.value(_jsonResponse(_nativeSessionJson(
            sessionToken: 'rotated-access',
            refreshToken: 'rotated-refresh',
          )..remove('sessionScope')));
        }
        throw StateError('unexpected request: $method $path');
      },
    );

    final accepting = auth.acceptSession(
      AuthSession.fromJson(_nativeSessionJson()),
    );
    await priorWriteStarted.future;
    final refreshing = auth.refreshSession();
    await Future<void>.delayed(Duration.zero);
    expect(refreshCalls, 0);

    releasePriorWrite.complete();
    await accepting;
    final refreshed = await refreshing;
    expect(refreshCalls, 1);
    expect(refreshed?.sessionToken, 'rotated-access');
    final persisted = jsonDecode(stored!) as Map<String, Object?>;
    expect(persisted['sessionToken'], 'rotated-access');
    expect(persisted['refreshToken'], 'rotated-refresh');
  });

  test('acceptSession rejects a mismatched explicit session scope', () async {
    String? stored;
    var writes = 0;
    final auth = ChikNativeAuth(
      baseUrl: 'https://app.example.test',
      sessionStore: ChikNativeSessionStore.json(
        read: () async => stored,
        write: (value) async {
          writes += 1;
          stored = value;
        },
        delete: () async => stored = null,
        deleteSessionScope: (_) async {},
      ),
    );

    await expectLater(
      auth.acceptSession(
        AuthSession.fromJson(_nativeSessionJson()),
        sessionScope: _secondSessionScope,
      ),
      throwsA(
        isA<ChikAuthError>()
            .having(
              (error) => error.code,
              'code',
              ChikErrorCode.invalidArgument,
            )
            .having((error) => error.status, 'status', 400)
            .having(
              (error) => error.message,
              'message',
              'The explicit native session scope does not match the session response.',
            ),
      ),
    );
    expect(writes, 0);
    expect(stored, isNull);
  });

  for (final operationKind in <String>['sign-out', 'replacement']) {
    test('$operationKind handles cleanup marker write failure', () async {
      String? stored = jsonEncode(_nativeSessionJson());
      var markerWrites = 0;
      var networkCalls = 0;
      final auth = _concurrentAuth(
        read: () async => stored,
        write: (value) async {
          final json = jsonDecode(value) as Map<String, Object?>;
          if (json['kind'] == 'cleanup') {
            markerWrites += 1;
            throw StateError('cleanup marker write failed');
          }
          stored = value;
        },
        delete: () async => stored = null,
        deleteSessionScope: (_) async {},
        fetch: (method, path) {
          networkCalls += 1;
          if (path == '/api/auth/sign-out') {
            return Future.value(
              _jsonResponse(<String, Object?>{'signedOut': true}),
            );
          }
          return Future.value(_jsonResponse(_nativeSessionJson(
            userId: 'second-user',
            sessionToken: 'second-access',
            refreshToken: 'second-refresh',
            sessionScope: _secondSessionScope,
          )));
        },
      );

      final Future<Object?> operation;
      if (operationKind == 'sign-out') {
        operation = auth.signOut().then<Object?>((_) => null);
      } else {
        operation = auth.signIn('second@example.test', 'password');
      }
      if (operationKind == 'sign-out') {
        await operation;
        expect(markerWrites, 2);
        expect(networkCalls, 1);
        expect(stored, isNull);
        expect(auth.hasSession, isFalse);
      } else {
        await expectLater(
          operation,
          throwsA(
            isA<ChikAuthError>().having(
              (error) => error.code,
              'code',
              ChikErrorCode.storageError,
            ),
          ),
        );
        expect(markerWrites, 1);
        expect(networkCalls, 0);
        expect(
          (jsonDecode(stored!) as Map<String, Object?>)['sessionToken'],
          'access',
        );
        expect(auth.hasSession, isFalse);
      }
    });
  }

  test('sign-out reports storage failure after all cleanup writes fail',
      () async {
    String? stored = jsonEncode(_nativeSessionJson());
    var signOutCalls = 0;
    final auth = _concurrentAuth(
      read: () async => stored,
      write: (_) async => throw StateError('marker write failed'),
      delete: () async => throw StateError('session delete failed'),
      deleteSessionScope: (_) async => throw StateError('scope delete failed'),
      fetch: (method, path) {
        if (method == 'POST' && path == '/api/auth/sign-out') {
          signOutCalls += 1;
          return Future.value(
            _jsonResponse(<String, Object?>{'signedOut': true}),
          );
        }
        throw StateError('unexpected request: $method $path');
      },
    );

    await expectLater(
      auth.signOut(),
      throwsA(
        isA<ChikAuthError>().having(
          (error) => error.code,
          'code',
          ChikErrorCode.storageError,
        ),
      ),
    );
    expect(signOutCalls, 1);
    expect(
      (jsonDecode(stored) as Map<String, Object?>)['sessionToken'],
      'access',
    );
    expect(auth.hasSession, isFalse);

    final remoteRead = Completer<ChikAuthResponse>();
    final remoteReadStarted = Completer<void>();
    final restarted = _concurrentAuth(
      read: () async => stored,
      write: (_) async => throw StateError('marker write failed'),
      delete: () async => throw StateError('session delete failed'),
      deleteSessionScope: (_) async => throw StateError('scope delete failed'),
      fetch: (method, path) {
        if (method == 'GET' && path == '/api/auth/session') {
          remoteReadStarted.complete();
          return remoteRead.future;
        }
        throw StateError('unexpected request: $method $path');
      },
    );
    final restoring = restarted.restoreSession();
    final restoringExpectation = expectLater(
      restoring,
      throwsA(
        isA<ChikAuthError>()
            .having(
              (error) => error.code,
              'code',
              ChikErrorCode.networkFailure,
            )
            .having(
              (error) => error.cause,
              'cause',
              isA<StateError>(),
            ),
      ),
    );
    await remoteReadStarted.future;
    expect(restarted.hasSession, isFalse);
    expect(restarted.currentUser, isNull);
    expect(restarted.sessionTokenProvider(), isNull);
    expect(restarted.sessionScopeProvider(), isNull);
    expect(restarted.sessionScopeLeaseProvider(), isNull);
    remoteRead.completeError(StateError('network unavailable'));
    await restoringExpectation;
    expect(restarted.hasSession, isFalse);
  });

  test('corrupt stored session recovers as signed out after full cleanup',
      () async {
    String? stored = jsonEncode(<String, Object?>{
      ..._nativeSessionJson(),
      'refreshToken': '',
    });
    var scopeDeletes = 0;
    var sessionDeletes = 0;
    final auth = ChikNativeAuth(
      baseUrl: 'https://app.example.test',
      sessionStore: ChikNativeSessionStore.json(
        read: () async => stored,
        write: (value) async => stored = value,
        delete: () async {
          sessionDeletes += 1;
          stored = null;
        },
        deleteSessionScope: (_) async {
          scopeDeletes += 1;
        },
      ),
    );

    expect(await auth.restoreSession(), isNull);
    expect(scopeDeletes, 1);
    expect(sessionDeletes, 1);
    expect(stored, isNull);
    expect(auth.hasSession, isFalse);
  });

  test('corrupt session persists a cleanup-only marker for restart', () async {
    String? stored = jsonEncode(<String, Object?>{
      ..._nativeSessionJson(),
      'refreshToken': '',
    });
    var scopeDeletes = 0;
    var sessionDeletes = 0;
    final discoveredScopes = <String>[];

    Future<void> deleteSession() async {
      sessionDeletes += 1;
      stored = null;
    }

    Future<void> deleteSessionScope(String sessionScope) async {
      scopeDeletes += 1;
      discoveredScopes.add(sessionScope);
      if (scopeDeletes == 1) throw StateError('scope cleanup failed');
    }

    ChikNativeAuth createAuth() => ChikNativeAuth(
          baseUrl: 'https://app.example.test',
          sessionStore: ChikNativeSessionStore.json(
            read: () async => stored,
            write: (value) async => stored = value,
            delete: deleteSession,
            deleteSessionScope: deleteSessionScope,
          ),
        );

    await expectLater(
      createAuth().restoreSession(),
      throwsA(
        isA<ChikAuthError>()
            .having(
              (error) => error.code,
              'code',
              ChikErrorCode.storageError,
            )
            .having(
              (error) => (error.details! as ChikAuthError).message,
              'cleanup error',
              'The invalid stored session could not be cleared.',
            ),
      ),
    );
    expect(scopeDeletes, 1);
    expect(sessionDeletes, 0);
    expect(jsonDecode(stored!), <String, Object?>{
      'kind': 'cleanup',
      'sessionScope': _firstSessionScope,
    });

    final restarted = createAuth();
    expect(await restarted.restoreSession(), isNull);
    expect(scopeDeletes, 2);
    expect(sessionDeletes, 1);
    expect(discoveredScopes, <String>[
      _firstSessionScope,
      _firstSessionScope,
    ]);
    expect(stored, isNull);
    expect(restarted.hasSession, isFalse);
  });

  test('sign-out keeps its scope reference for cleanup after restart',
      () async {
    const sessionScope =
        'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    String? stored = jsonEncode(<String, Object?>{
      ..._nativeSessionJson(),
      'sessionScope': sessionScope,
    });
    var scopeAttempts = 0;
    var sessionDeletes = 0;
    var signOutCalls = 0;
    final discoveredScopes = <String>[];
    final restartedCleanupStarted = Completer<void>();
    final releaseRestartedCleanup = Completer<void>();

    ChikNativeAuth createAuth() => _concurrentAuth(
          read: () async => stored,
          write: (value) async => stored = value,
          delete: () async {
            sessionDeletes += 1;
            stored = null;
          },
          deleteSessionScope: (scope) async {
            discoveredScopes.add(scope);
            scopeAttempts += 1;
            if (scopeAttempts == 1) {
              throw StateError('temporary secure storage failure');
            }
            restartedCleanupStarted.complete();
            await releaseRestartedCleanup.future;
          },
          fetch: (method, path) async {
            if (method == 'POST' && path == '/api/auth/sign-out') {
              signOutCalls += 1;
              if (signOutCalls > 1) {
                return _jsonResponse(<String, Object?>{
                  'code': 'unauthenticated',
                  'message': 'already revoked',
                }, status: 401);
              }
              return _jsonResponse(<String, Object?>{'signedOut': true});
            }
            return _jsonResponse(<String, Object?>{
              'code': 'not_found',
              'message': 'not found',
            }, status: 404);
          },
        );

    final auth = createAuth();

    await expectLater(
      auth.signOut(),
      throwsA(
        isA<ChikAuthError>().having(
          (error) => error.code,
          'code',
          ChikErrorCode.storageError,
        ),
      ),
    );
    expect(auth.sessionScopeProvider(), isNull);
    expect(sessionDeletes, 0);
    final marker = jsonDecode(stored!) as Map<String, Object?>;
    expect(marker, <String, Object?>{
      'kind': 'cleanup',
      'sessionScope': sessionScope,
    });

    final restarted = createAuth();
    final clientOptions = ChikClientOptions.nativeAuth(restarted);
    final restoring = restarted.restoreSession();
    final requiring = expectLater(
      restarted.getSession(),
      throwsA(
        isA<ChikAuthError>().having(
          (error) => error.code,
          'code',
          ChikErrorCode.unauthenticated,
        ),
      ),
    );
    await restartedCleanupStarted.future;
    expect(restarted.hasSession, isFalse);
    expect(restarted.currentUser, isNull);
    expect(clientOptions.sessionTokenProvider!(), isNull);
    expect(clientOptions.sessionScopeProvider!(), isNull);
    expect(clientOptions.sessionScopeLeaseProvider!(), isNull);
    expect(jsonDecode(stored!), marker);
    releaseRestartedCleanup.complete();

    expect(await restoring, isNull);
    await requiring;
    expect(stored, isNull);
    expect(restarted.sessionScopeProvider(), isNull);
    expect(scopeAttempts, 2);
    expect(sessionDeletes, 1);
    expect(signOutCalls, 1);
    expect(discoveredScopes, <String>[sessionScope, sessionScope]);
  });

  test('old scope cleanup debt does not block a replacement session', () async {
    String? stored = jsonEncode(_nativeSessionJson());
    var scopeCleanupAttempts = 0;
    final auth = _concurrentAuth(
      read: () async => stored,
      write: (value) async => stored = value,
      delete: () async => stored = null,
      deleteSessionScope: (_) async {
        scopeCleanupAttempts += 1;
        throw StateError('scope cleanup remains unavailable');
      },
      fetch: (method, path) {
        if (method == 'POST' && path == '/api/auth/sign-out') {
          return Future.value(
            _jsonResponse(<String, Object?>{'signedOut': true}),
          );
        }
        if (method == 'POST' && path == '/api/auth/native/sign-in') {
          return Future.value(_jsonResponse(_nativeSessionJson(
            userId: 'next-user',
            sessionToken: 'next-access',
            refreshToken: 'next-refresh',
            sessionScope: _secondSessionScope,
          )));
        }
        throw StateError('unexpected request: $method $path');
      },
    );

    await expectLater(
      auth.signOut(),
      throwsA(
        isA<ChikAuthError>().having(
          (error) => error.code,
          'code',
          ChikErrorCode.storageError,
        ),
      ),
    );
    expect(jsonDecode(stored!), <String, Object?>{
      'kind': 'cleanup',
      'sessionScope': _firstSessionScope,
    });

    final accepted = await auth.signIn('next@example.test', 'password');
    expect(accepted.user.userId, 'next-user');
    expect(scopeCleanupAttempts, 3);
    final persisted = jsonDecode(stored!) as Map<String, Object?>;
    expect(persisted['sessionToken'], 'next-access');
    expect(persisted['sessionScope'], _secondSessionScope);
  });

  test('a deferred store read cannot initialize a superseded operation',
      () async {
    String? stored = jsonEncode(_nativeSessionJson());
    final firstReadStarted = Completer<void>();
    final releaseFirstRead = Completer<void>();
    var reads = 0;
    final auth = _concurrentAuth(
      read: () async {
        reads += 1;
        if (reads == 1) {
          firstReadStarted.complete();
          await releaseFirstRead.future;
        }
        return stored;
      },
      write: (value) async => stored = value,
      delete: () async => stored = null,
      deleteSessionScope: (_) async {},
      fetch: (method, path) {
        if (method == 'POST' && path == '/api/auth/native/sign-in') {
          return Future.value(_jsonResponse(_nativeSessionJson(
            userId: 'second-user',
            sessionToken: 'second-access',
            refreshToken: 'second-refresh',
            sessionScope: _secondSessionScope,
          )));
        }
        throw StateError('unexpected request: $method $path');
      },
    );

    final staleRestore = auth.restoreSession();
    final staleRestoreExpectation = _expectAborted(staleRestore);
    await firstReadStarted.future;
    final replacement = auth.signIn('second@example.test', 'password');
    releaseFirstRead.complete();

    await staleRestoreExpectation;
    await replacement;
    expect(reads, 2);
    final persisted = jsonDecode(stored!) as Map<String, Object?>;
    expect(persisted['sessionToken'], 'second-access');
    expect(persisted['sessionScope'], _secondSessionScope);
  });

  test('a stale remote session read cannot replace a newer sign-in', () async {
    String? stored = jsonEncode(_nativeSessionJson());
    final remoteRead = Completer<ChikAuthResponse>();
    final remoteReadStarted = Completer<void>();
    final auth = _concurrentAuth(
      read: () async => stored,
      write: (value) async => stored = value,
      delete: () async => stored = null,
      deleteSessionScope: (_) async {},
      fetch: (method, path) {
        if (method == 'GET' && path == '/api/auth/session') {
          remoteReadStarted.complete();
          return remoteRead.future;
        }
        if (method == 'POST' && path == '/api/auth/native/sign-in') {
          return Future.value(_jsonResponse(_nativeSessionJson(
            userId: 'second-user',
            sessionToken: 'second-access',
            refreshToken: 'second-refresh',
            sessionScope: _secondSessionScope,
          )));
        }
        throw StateError('unexpected request: $method $path');
      },
    );

    final staleRestore = auth.restoreSession();
    final staleRestoreExpectation = _expectAborted(staleRestore);
    await remoteReadStarted.future;
    await auth.signIn('second@example.test', 'password');
    remoteRead
        .complete(_jsonResponse(_remoteSessionJson(userId: 'first-remote')));

    await staleRestoreExpectation;
    final persisted = jsonDecode(stored!) as Map<String, Object?>;
    expect(persisted['sessionToken'], 'second-access');
    expect(persisted['sessionScope'], _secondSessionScope);
    expect(auth.currentUser?.userId, 'second-user');
  });

  test('a stale remote session read cannot repopulate signed-out state',
      () async {
    String? stored = jsonEncode(_nativeSessionJson());
    final remoteRead = Completer<ChikAuthResponse>();
    final remoteReadStarted = Completer<void>();
    final auth = _concurrentAuth(
      read: () async => stored,
      write: (value) async => stored = value,
      delete: () async => stored = null,
      deleteSessionScope: (_) async {},
      fetch: (method, path) {
        if (method == 'GET' && path == '/api/auth/session') {
          remoteReadStarted.complete();
          return remoteRead.future;
        }
        if (method == 'POST' && path == '/api/auth/sign-out') {
          return Future.value(
            _jsonResponse(<String, Object?>{'signedOut': true}),
          );
        }
        throw StateError('unexpected request: $method $path');
      },
    );

    final staleRestore = auth.restoreSession();
    final staleRestoreExpectation = _expectAborted(staleRestore);
    await remoteReadStarted.future;
    await auth.signOut();
    remoteRead
        .complete(_jsonResponse(_remoteSessionJson(userId: 'first-remote')));

    await staleRestoreExpectation;
    expect(stored, isNull);
    expect(auth.hasSession, isFalse);
  });

  test('refresh supersedes a stale remote session read', () async {
    String? stored = jsonEncode(_nativeSessionJson());
    final remoteRead = Completer<ChikAuthResponse>();
    final remoteReadStarted = Completer<void>();
    final auth = _concurrentAuth(
      read: () async => stored,
      write: (value) async => stored = value,
      delete: () async => stored = null,
      deleteSessionScope: (_) async {},
      fetch: (method, path) {
        if (method == 'GET' && path == '/api/auth/session') {
          remoteReadStarted.complete();
          return remoteRead.future;
        }
        if (method == 'POST' && path == '/api/auth/refresh') {
          return Future.value(_jsonResponse(_nativeSessionJson(
            sessionToken: 'refreshed-access',
            refreshToken: 'refreshed-refresh',
          )..remove('sessionScope')));
        }
        throw StateError('unexpected request: $method $path');
      },
    );

    final restoring = auth.restoreSession();
    final restoringExpectation = _expectAborted(restoring);
    await remoteReadStarted.future;
    await auth.refreshSession();
    remoteRead
        .complete(_jsonResponse(_remoteSessionJson(userId: 'remote-user')));
    await restoringExpectation;

    final persisted = jsonDecode(stored!) as Map<String, Object?>;
    expect(persisted['sessionToken'], 'refreshed-access');
    expect(persisted['refreshToken'], 'refreshed-refresh');
    expect(auth.currentUser?.userId, 'user');
  });

  test('shared refresh supersedes another auth instance stale restore',
      () async {
    String? stored = jsonEncode(_nativeSessionJson());
    final coordinationKey = Object();
    final remoteRead = Completer<ChikAuthResponse>();
    final remoteReadStarted = Completer<void>();

    ChikNativeSessionStore createStore() => ChikNativeSessionStore.json(
          read: () async => stored,
          write: (value) async => stored = value,
          delete: () async => stored = null,
          deleteSessionScope: (_) async {},
          coordinationKey: coordinationKey,
        );

    final first = ChikNativeAuth(
      baseUrl: 'https://app.example.test',
      sessionStore: createStore(),
      fetch: (method, url, {headers, body}) {
        if (method == 'GET' && Uri.parse(url).path == '/api/auth/session') {
          remoteReadStarted.complete();
          return remoteRead.future;
        }
        throw StateError('unexpected request: $method $url');
      },
    );
    final second = ChikNativeAuth(
      baseUrl: 'https://app.example.test',
      sessionStore: createStore(),
      fetch: (method, url, {headers, body}) async {
        if (method == 'POST' && Uri.parse(url).path == '/api/auth/refresh') {
          return _jsonResponse(_nativeSessionJson(
            sessionToken: 'refreshed-access',
            refreshToken: 'refreshed-refresh',
          )..remove('sessionScope'));
        }
        throw StateError('unexpected request: $method $url');
      },
    );

    final staleRestore = first.restoreSession();
    final staleRestoreExpectation = _expectAborted(staleRestore);
    await remoteReadStarted.future;
    final refreshed = await second.refreshSession();
    remoteRead
        .complete(_jsonResponse(_remoteSessionJson(userId: 'stale-user')));

    await staleRestoreExpectation;
    expect(refreshed?.sessionToken, 'refreshed-access');
    final persisted = jsonDecode(stored!) as Map<String, Object?>;
    expect(persisted['sessionToken'], 'refreshed-access');
    expect(persisted['refreshToken'], 'refreshed-refresh');
  });

  test('two auth instances share one refresh request and latest credentials',
      () async {
    String? stored = jsonEncode(_nativeSessionJson());
    final coordinationKey = Object();
    final refresh = Completer<ChikAuthResponse>();
    final refreshStarted = Completer<void>();
    var refreshCalls = 0;

    ChikNativeSessionStore createStore() => ChikNativeSessionStore.json(
          read: () async => stored,
          write: (value) async => stored = value,
          delete: () async => stored = null,
          deleteSessionScope: (_) async {},
          coordinationKey: coordinationKey,
        );

    ChikNativeAuth createAuth() => ChikNativeAuth(
          baseUrl: 'https://app.example.test',
          sessionStore: createStore(),
          fetch: (method, url, {headers, body}) {
            if (method == 'POST' &&
                Uri.parse(url).path == '/api/auth/refresh') {
              refreshCalls += 1;
              if (!refreshStarted.isCompleted) refreshStarted.complete();
              return refresh.future;
            }
            throw StateError('unexpected request: $method $url');
          },
        );

    final first = createAuth();
    final second = createAuth();
    final firstRefresh = first.refreshSession();
    final secondRefresh = second.refreshSession();
    await refreshStarted.future;
    expect(refreshCalls, 1);
    refresh.complete(_jsonResponse(_nativeSessionJson(
      sessionToken: 'shared-access',
      refreshToken: 'shared-refresh',
    )..remove('sessionScope')));

    final sessions = await Future.wait(<Future<AuthSession?>>[
      firstRefresh,
      secondRefresh,
    ]);
    expect(sessions.map((session) => session?.sessionToken),
        everyElement('shared-access'));
    expect(first.sessionTokenProvider(), 'shared-access');
    expect(second.sessionTokenProvider(), 'shared-access');
    expect(refreshCalls, 1);
    final persisted = jsonDecode(stored!) as Map<String, Object?>;
    expect(persisted['sessionToken'], 'shared-access');
    expect(persisted['refreshToken'], 'shared-refresh');
  });

  test('one auth adopts another same-scope refresh without ending its lease',
      () async {
    String? stored;
    final coordinationKey = Object();
    final refresh = Completer<ChikAuthResponse>();
    final refreshStarted = Completer<void>();

    ChikNativeSessionStore createStore() => ChikNativeSessionStore.json(
          read: () async => stored,
          write: (value) async => stored = value,
          delete: () async => stored = null,
          deleteSessionScope: (_) async {},
          coordinationKey: coordinationKey,
        );

    final first = ChikNativeAuth(
      baseUrl: 'https://app.example.test',
      sessionStore: createStore(),
    );
    final second = ChikNativeAuth(
      baseUrl: 'https://app.example.test',
      sessionStore: createStore(),
      fetch: (method, url, {headers, body}) async {
        final path = Uri.parse(url).path;
        if (method == 'GET' && path == '/api/auth/session') {
          return _jsonResponse(_remoteSessionJson(userId: 'user'));
        }
        if (method == 'POST' && path == '/api/auth/refresh') {
          refreshStarted.complete();
          return refresh.future;
        }
        throw StateError('unexpected request: $method $url');
      },
    );

    await first.acceptSession(AuthSession.fromJson(_nativeSessionJson()));
    final lease = first.sessionScopeLeaseProvider()!;
    await second.restoreSession();
    final refreshing = second.refreshSession();
    await refreshStarted.future;

    expect(first.sessionTokenProvider(), isNull);
    expect(first.currentUser, isNull);
    expect(first.sessionScopeLeaseProvider(), same(lease));
    expect(lease.isActive, isTrue);
    refresh.complete(_jsonResponse(_nativeSessionJson(
      userId: 'refreshed-user',
      sessionToken: 'refreshed-access',
      refreshToken: 'refreshed-refresh',
    )..remove('sessionScope')));
    await refreshing;

    expect(first.sessionTokenProvider(), 'refreshed-access');
    expect(first.currentUser?.userId, 'refreshed-user');
    expect(first.sessionScopeLeaseProvider(), same(lease));
    expect(lease.isActive, isTrue);
  });

  test('dispose keeps an active shared refresh registered until it settles',
      () async {
    String? stored = jsonEncode(_nativeSessionJson());
    const coordinationKey = 'dispose-active-refresh';
    final refresh = Completer<ChikAuthResponse>();
    final refreshStarted = Completer<void>();
    var refreshCalls = 0;

    ChikNativeSessionStore createStore() => ChikNativeSessionStore.json(
          read: () async => stored,
          write: (value) async => stored = value,
          delete: () async => stored = null,
          deleteSessionScope: (_) async {},
          coordinationKey: coordinationKey,
        );

    final first = ChikNativeAuth(
      baseUrl: 'https://app.example.test',
      sessionStore: createStore(),
      fetch: (method, url, {headers, body}) {
        if (method == 'POST' && Uri.parse(url).path == '/api/auth/refresh') {
          refreshCalls += 1;
          refreshStarted.complete();
          return refresh.future;
        }
        throw StateError('unexpected request: $method $url');
      },
    );
    final firstRefresh = first.refreshSession();
    final firstExpectation = expectLater(
      firstRefresh,
      throwsA(
        isA<ChikAuthError>().having(
          (error) => error.code,
          'code',
          ChikErrorCode.failedPrecondition,
        ),
      ),
    );
    await refreshStarted.future;
    final disposing = first.dispose();

    final second = ChikNativeAuth(
      baseUrl: 'https://app.example.test',
      sessionStore: createStore(),
    );
    final secondRefresh = second.refreshSession();
    refresh.complete(_jsonResponse(_nativeSessionJson(
      sessionToken: 'shared-access',
      refreshToken: 'shared-refresh',
    )..remove('sessionScope')));

    expect((await secondRefresh)?.sessionToken, 'shared-access');
    await firstExpectation;
    await disposing;
    expect(refreshCalls, 1);
    await second.dispose();
  });

  for (final refreshStatus in <int>[200, 401]) {
    test('stale refresh $refreshStatus cannot restore a signed-out session',
        () async {
      String? stored = jsonEncode(_nativeSessionJson());
      final refresh = Completer<ChikAuthResponse>();
      final refreshStarted = Completer<void>();
      final auth = _concurrentAuth(
        read: () async => stored,
        write: (value) async => stored = value,
        delete: () async => stored = null,
        deleteSessionScope: (_) async {},
        fetch: (method, path) {
          if (method == 'POST' && path == '/api/auth/refresh') {
            refreshStarted.complete();
            return refresh.future;
          }
          if (method == 'POST' && path == '/api/auth/sign-out') {
            return Future.value(
              _jsonResponse(<String, Object?>{'signedOut': true}),
            );
          }
          throw StateError('unexpected request: $method $path');
        },
      );

      final staleRefresh = auth.refreshSession();
      final staleRefreshExpectation = _expectAborted(staleRefresh);
      await refreshStarted.future;
      final signOut = auth.signOut();
      refresh.complete(refreshStatus == 200
          ? _jsonResponse(_nativeSessionJson(
              sessionToken: 'stale-access',
              refreshToken: 'stale-refresh',
            )..remove('sessionScope'))
          : _jsonResponse(<String, Object?>{
              'code': 'unauthenticated',
              'message': 'expired',
            }, status: 401));

      await staleRefreshExpectation;
      await signOut;
      expect(stored, isNull);
      expect(auth.hasSession, isFalse);
      expect(auth.sessionScopeProvider(), isNull);
    });
  }

  for (final refreshStatus in <int>[200, 401]) {
    test('stale refresh $refreshStatus cannot replace a newer sign-in',
        () async {
      String? stored = jsonEncode(_nativeSessionJson());
      final refresh = Completer<ChikAuthResponse>();
      final refreshStarted = Completer<void>();
      final auth = _concurrentAuth(
        read: () async => stored,
        write: (value) async => stored = value,
        delete: () async => stored = null,
        deleteSessionScope: (_) async {},
        fetch: (method, path) {
          if (method == 'POST' && path == '/api/auth/refresh') {
            refreshStarted.complete();
            return refresh.future;
          }
          if (method == 'POST' && path == '/api/auth/native/sign-in') {
            return Future.value(_jsonResponse(_nativeSessionJson(
              userId: 'second-user',
              sessionToken: 'second-access',
              refreshToken: 'second-refresh',
              sessionScope: _secondSessionScope,
            )));
          }
          throw StateError('unexpected request: $method $path');
        },
      );

      final staleRefresh = auth.refreshSession();
      final staleRefreshExpectation = _expectAborted(staleRefresh);
      await refreshStarted.future;
      final signIn = auth.signIn('second@example.test', 'password');
      refresh.complete(refreshStatus == 200
          ? _jsonResponse(_nativeSessionJson(
              sessionToken: 'stale-access',
              refreshToken: 'stale-refresh',
            )..remove('sessionScope'))
          : _jsonResponse(<String, Object?>{
              'code': 'unauthenticated',
              'message': 'expired',
            }, status: 401));

      await staleRefreshExpectation;
      await signIn;
      final persisted = jsonDecode(stored!) as Map<String, Object?>;
      expect(persisted['sessionToken'], 'second-access');
      expect(persisted['refreshToken'], 'second-refresh');
      expect(persisted['sessionScope'], _secondSessionScope);
      expect(auth.currentUser?.userId, 'second-user');
    });
  }

  test('a stale sign-out cannot clear a replacement session', () async {
    String? stored = jsonEncode(_nativeSessionJson());
    final signOut = Completer<ChikAuthResponse>();
    final signOutStarted = Completer<void>();
    final auth = _concurrentAuth(
      read: () async => stored,
      write: (value) async => stored = value,
      delete: () async => stored = null,
      deleteSessionScope: (_) async {},
      fetch: (method, path) {
        if (method == 'POST' && path == '/api/auth/sign-out') {
          signOutStarted.complete();
          return signOut.future;
        }
        if (method == 'POST' && path == '/api/auth/native/sign-in') {
          return Future.value(_jsonResponse(_nativeSessionJson(
            userId: 'second-user',
            sessionToken: 'second-access',
            refreshToken: 'second-refresh',
            sessionScope: _secondSessionScope,
          )));
        }
        throw StateError('unexpected request: $method $path');
      },
    );

    final staleSignOut = auth.signOut();
    final staleSignOutExpectation = _expectAborted(staleSignOut);
    await signOutStarted.future;
    await auth.signIn('second@example.test', 'password');
    signOut.complete(_jsonResponse(<String, Object?>{'signedOut': true}));

    await staleSignOutExpectation;
    final persisted = jsonDecode(stored!) as Map<String, Object?>;
    expect(persisted['sessionToken'], 'second-access');
    expect(persisted['sessionScope'], _secondSessionScope);
  });

  test('one auth instance cannot clear another instance replacement', () async {
    String? stored = jsonEncode(_nativeSessionJson());
    final coordinationKey = Object();
    final signOut = Completer<ChikAuthResponse>();
    final signOutStarted = Completer<void>();

    ChikNativeSessionStore createStore() => ChikNativeSessionStore.json(
          read: () async => stored,
          write: (value) async => stored = value,
          delete: () async => stored = null,
          deleteSessionScope: (_) async {},
          coordinationKey: coordinationKey,
        );

    final first = ChikNativeAuth(
      baseUrl: 'https://app.example.test',
      sessionStore: createStore(),
      fetch: (method, url, {headers, body}) {
        if (method == 'POST' && Uri.parse(url).path == '/api/auth/sign-out') {
          signOutStarted.complete();
          return signOut.future;
        }
        throw StateError('unexpected request: $method $url');
      },
    );
    final second = ChikNativeAuth(
      baseUrl: 'https://app.example.test',
      sessionStore: createStore(),
      fetch: (method, url, {headers, body}) async {
        if (method == 'POST' &&
            Uri.parse(url).path == '/api/auth/native/sign-in') {
          return _jsonResponse(_nativeSessionJson(
            userId: 'second-user',
            sessionToken: 'second-access',
            refreshToken: 'second-refresh',
            sessionScope: _secondSessionScope,
          ));
        }
        throw StateError('unexpected request: $method $url');
      },
    );

    final staleSignOut = first.signOut();
    final staleSignOutExpectation = _expectAborted(staleSignOut);
    await signOutStarted.future;
    await second.signIn('second@example.test', 'password');
    signOut.complete(_jsonResponse(<String, Object?>{'signedOut': true}));

    await staleSignOutExpectation;
    final persisted = jsonDecode(stored!) as Map<String, Object?>;
    expect(persisted['sessionToken'], 'second-access');
    expect(persisted['sessionScope'], _secondSessionScope);
  });

  test('one auth instance cannot restore over another instance replacement',
      () async {
    String? stored = jsonEncode(_nativeSessionJson());
    final coordinationKey = Object();
    final remoteRead = Completer<ChikAuthResponse>();
    final remoteReadStarted = Completer<void>();

    ChikNativeSessionStore createStore() => ChikNativeSessionStore.json(
          read: () async => stored,
          write: (value) async => stored = value,
          delete: () async => stored = null,
          deleteSessionScope: (_) async {},
          coordinationKey: coordinationKey,
        );

    final first = ChikNativeAuth(
      baseUrl: 'https://app.example.test',
      sessionStore: createStore(),
      fetch: (method, url, {headers, body}) {
        if (method == 'GET' && Uri.parse(url).path == '/api/auth/session') {
          remoteReadStarted.complete();
          return remoteRead.future;
        }
        throw StateError('unexpected request: $method $url');
      },
    );
    final second = ChikNativeAuth(
      baseUrl: 'https://app.example.test',
      sessionStore: createStore(),
      fetch: (method, url, {headers, body}) async {
        if (method == 'POST' &&
            Uri.parse(url).path == '/api/auth/native/sign-in') {
          return _jsonResponse(_nativeSessionJson(
            userId: 'second-user',
            sessionToken: 'second-access',
            refreshToken: 'second-refresh',
            sessionScope: _secondSessionScope,
          ));
        }
        throw StateError('unexpected request: $method $url');
      },
    );

    final staleRestore = first.restoreSession();
    final staleRestoreExpectation = _expectAborted(staleRestore);
    await remoteReadStarted.future;
    expect(first.hasSession, isFalse);
    expect(first.currentUser, isNull);
    expect(first.sessionTokenProvider(), isNull);
    expect(first.sessionScopeProvider(), isNull);
    expect(first.sessionScopeLeaseProvider(), isNull);
    await second.signIn('second@example.test', 'password');
    expect(first.sessionTokenProvider(), isNull);
    remoteRead
        .complete(_jsonResponse(_remoteSessionJson(userId: 'first-remote')));

    await staleRestoreExpectation;
    final persisted = jsonDecode(stored!) as Map<String, Object?>;
    expect(persisted['sessionToken'], 'second-access');
    expect(persisted['sessionScope'], _secondSessionScope);
  });

  test('a stale GitHub transaction aborts before callback network I/O',
      () async {
    String? stored;
    var callbackCalls = 0;
    final auth = _concurrentAuth(
      read: () async => stored,
      write: (value) async => stored = value,
      delete: () async => stored = null,
      deleteSessionScope: (_) async {},
      fetch: (method, path) {
        if (method == 'POST' && path == '/api/auth/native/github/start') {
          return Future.value(_jsonResponse(<String, Object?>{
            'authorizationUrl': 'https://github.example.test/login',
            'state': 'state',
            'browserNonce': 'nonce',
            'pkceVerifier': 'verifier',
            'expiresAt': '2099-01-01T00:00:00Z',
            'redirectUri': 'https://app.example.test/api/auth/github/callback',
          }));
        }
        if (method == 'POST' && path == '/api/auth/native/github/complete') {
          callbackCalls += 1;
          return Future.value(_jsonResponse(_nativeSessionJson()));
        }
        if (method == 'POST' && path == '/api/auth/native/sign-in') {
          return Future.value(_jsonResponse(_nativeSessionJson(
            userId: 'second-user',
            sessionToken: 'second-access',
            refreshToken: 'second-refresh',
            sessionScope: _secondSessionScope,
          )));
        }
        throw StateError('unexpected request: $method $path');
      },
    );

    final transaction = await auth.startGitHubNative();
    await auth.signIn('second@example.test', 'password');

    await _expectAborted(transaction.complete(
      'https://app.example.test/api/auth/github/callback?code=code&state=state',
    ));
    expect(callbackCalls, 0);
    final persisted = jsonDecode(stored!) as Map<String, Object?>;
    expect(persisted['sessionToken'], 'second-access');
    expect(persisted['sessionScope'], _secondSessionScope);
  });

  test('a stale GitHub callback cannot replace a newer sign-in', () async {
    String? stored;
    final callback = Completer<ChikAuthResponse>();
    final callbackStarted = Completer<void>();
    final auth = _concurrentAuth(
      read: () async => stored,
      write: (value) async => stored = value,
      delete: () async => stored = null,
      deleteSessionScope: (_) async {},
      fetch: (method, path) {
        if (method == 'POST' && path == '/api/auth/native/github/start') {
          return Future.value(_jsonResponse(<String, Object?>{
            'authorizationUrl': 'https://github.example.test/login',
            'state': 'state',
            'browserNonce': 'nonce',
            'pkceVerifier': 'verifier',
            'expiresAt': '2099-01-01T00:00:00Z',
            'redirectUri': 'https://app.example.test/api/auth/github/callback',
          }));
        }
        if (method == 'POST' && path == '/api/auth/native/github/complete') {
          callbackStarted.complete();
          return callback.future;
        }
        if (method == 'POST' && path == '/api/auth/native/sign-in') {
          return Future.value(_jsonResponse(_nativeSessionJson(
            userId: 'second-user',
            sessionToken: 'second-access',
            refreshToken: 'second-refresh',
            sessionScope: _secondSessionScope,
          )));
        }
        throw StateError('unexpected request: $method $path');
      },
    );

    final transaction = await auth.startGitHubNative();
    final staleCallback = transaction.complete(
      'https://app.example.test/api/auth/github/callback?code=code&state=state',
    );
    final staleCallbackExpectation = _expectAborted(staleCallback);
    await callbackStarted.future;
    await auth.signIn('second@example.test', 'password');
    callback.complete(_jsonResponse(_nativeSessionJson(userId: 'github-user')));

    await staleCallbackExpectation;
    final persisted = jsonDecode(stored!) as Map<String, Object?>;
    expect(persisted['sessionToken'], 'second-access');
    expect(persisted['sessionScope'], _secondSessionScope);
    expect(auth.currentUser?.userId, 'second-user');
  });

  test('a queued replacement wins after an older session write completes',
      () async {
    String? stored;
    final firstWriteStarted = Completer<void>();
    final releaseFirstWrite = Completer<void>();
    var writes = 0;
    final auth = _concurrentAuth(
      read: () async => stored,
      write: (value) async {
        writes += 1;
        if (writes == 1) {
          firstWriteStarted.complete();
          await releaseFirstWrite.future;
        }
        stored = value;
      },
      delete: () async => stored = null,
      deleteSessionScope: (_) async {},
      fetch: (method, path) {
        if (method == 'POST' && path == '/api/auth/native/sign-in') {
          return Future.value(_jsonResponse(_nativeSessionJson(
            userId: 'first-user',
          )));
        }
        throw StateError('unexpected request: $method $path');
      },
    );

    final staleSignIn = auth.signIn('first@example.test', 'password');
    final staleSignInExpectation = _expectAborted(staleSignIn);
    await firstWriteStarted.future;
    final replacement = auth.acceptSession(
      AuthSession.fromJson(_nativeSessionJson(
        userId: 'second-user',
        sessionToken: 'second-access',
        refreshToken: 'second-refresh',
        sessionScope: _secondSessionScope,
      )),
      sessionScope: _secondSessionScope,
    );
    releaseFirstWrite.complete();

    await Future.wait<void>(<Future<void>>[
      staleSignInExpectation,
      replacement.then<void>((_) {}),
    ]);
    final persisted = jsonDecode(stored!) as Map<String, Object?>;
    expect(persisted['sessionToken'], 'second-access');
    expect(persisted['sessionScope'], _secondSessionScope);
  });

  test('a queued clear wins after an older session write completes', () async {
    String? stored;
    final firstWriteStarted = Completer<void>();
    final releaseFirstWrite = Completer<void>();
    final auth = _concurrentAuth(
      read: () async => stored,
      write: (value) async {
        firstWriteStarted.complete();
        await releaseFirstWrite.future;
        stored = value;
      },
      delete: () async => stored = null,
      deleteSessionScope: (_) async {},
      fetch: (method, path) {
        if (method == 'POST' && path == '/api/auth/native/sign-in') {
          return Future.value(_jsonResponse(_nativeSessionJson()));
        }
        if (method == 'POST' && path == '/api/auth/sign-out') {
          return Future.value(
            _jsonResponse(<String, Object?>{'signedOut': true}),
          );
        }
        throw StateError('unexpected request: $method $path');
      },
    );

    final staleSignIn = auth.signIn('first@example.test', 'password');
    final staleSignInExpectation = _expectAborted(staleSignIn);
    await firstWriteStarted.future;
    final clear = auth.signOut();
    releaseFirstWrite.complete();

    await Future.wait<void>(<Future<void>>[staleSignInExpectation, clear]);
    expect(stored, isNull);
    expect(auth.hasSession, isFalse);
  });

  test('a failed superseding sign-in tombstones a completed stale disk write',
      () async {
    String? stored;
    final firstWriteStarted = Completer<void>();
    final releaseFirstWrite = Completer<void>();
    final secondSignInStarted = Completer<void>();
    final failSecondSignIn = Completer<ChikAuthResponse>();
    var signInCalls = 0;
    var writes = 0;
    var deletes = 0;
    final auth = _concurrentAuth(
      read: () async => stored,
      write: (value) async {
        writes += 1;
        if (writes == 1) {
          firstWriteStarted.complete();
          await releaseFirstWrite.future;
        }
        stored = value;
      },
      delete: () async {
        deletes += 1;
        stored = null;
      },
      deleteSessionScope: (_) async {},
      fetch: (method, path) {
        if (method == 'POST' && path == '/api/auth/native/sign-in') {
          signInCalls += 1;
          if (signInCalls == 1) {
            return Future.value(_jsonResponse(_nativeSessionJson()));
          }
          secondSignInStarted.complete();
          return failSecondSignIn.future;
        }
        throw StateError('unexpected request: $method $path');
      },
    );

    final staleSignIn = auth.signIn('first@example.test', 'password');
    final staleSignInExpectation = _expectAborted(staleSignIn);
    await firstWriteStarted.future;
    final replacement = auth.signIn('second@example.test', 'password');
    final replacementExpectation = expectLater(
      replacement,
      throwsA(
        isA<ChikAuthError>().having(
          (error) => error.status,
          'status',
          401,
        ),
      ),
    );
    releaseFirstWrite.complete();
    await secondSignInStarted.future;
    failSecondSignIn.complete(_jsonResponse(<String, Object?>{
      'code': 'unauthenticated',
      'message': 'invalid credentials',
    }, status: 401));

    await Future.wait<void>(<Future<void>>[
      staleSignInExpectation,
      replacementExpectation,
    ]);
    expect(jsonDecode(stored!), <String, Object?>{
      'kind': 'cleanup',
      'sessionScope': _firstSessionScope,
    });
    expect(deletes, 0);
    expect(auth.hasSession, isFalse);

    final restarted = _concurrentAuth(
      read: () async => stored,
      write: (value) async => stored = value,
      delete: () async => stored = null,
      deleteSessionScope: (_) async {},
      fetch: (method, path) => throw StateError('unexpected request'),
    );
    expect(await restarted.restoreSession(), isNull);
  });

  test('a failed superseding GitHub start leaves only a cleanup marker',
      () async {
    String? stored = jsonEncode(_nativeSessionJson());
    final staleWriteStarted = Completer<void>();
    final releaseStaleWrite = Completer<void>();
    final githubStartStarted = Completer<void>();
    final failGitHubStart = Completer<ChikAuthResponse>();
    var writes = 0;
    final auth = _concurrentAuth(
      read: () async => stored,
      write: (value) async {
        writes += 1;
        if (writes == 1) {
          staleWriteStarted.complete();
          await releaseStaleWrite.future;
        }
        stored = value;
      },
      delete: () async => stored = null,
      deleteSessionScope: (_) async {},
      fetch: (method, path) {
        if (method == 'POST' && path == '/api/auth/native/github/start') {
          githubStartStarted.complete();
          return failGitHubStart.future;
        }
        if (method == 'POST' && path == '/api/auth/refresh') {
          return Future.value(_jsonResponse(_nativeSessionJson(
            sessionToken: 'stale-access',
            refreshToken: 'stale-refresh',
          )..remove('sessionScope')));
        }
        throw StateError('unexpected request: $method $path');
      },
    );

    final staleRefresh = auth.refreshSession();
    final staleRefreshExpectation = _expectAborted(staleRefresh);
    await staleWriteStarted.future;
    final githubStart = auth.startGitHubNative();
    final githubStartExpectation = expectLater(
      githubStart,
      throwsA(
        isA<ChikAuthError>().having(
          (error) => error.status,
          'status',
          503,
        ),
      ),
    );
    releaseStaleWrite.complete();
    await githubStartStarted.future;
    failGitHubStart.complete(_jsonResponse(<String, Object?>{
      'code': 'unavailable',
      'message': 'GitHub is unavailable',
    }, status: 503));

    await Future.wait<void>(<Future<void>>[
      staleRefreshExpectation,
      githubStartExpectation,
    ]);
    expect(writes, 1);
    expect(jsonDecode(stored!), <String, Object?>{
      'kind': 'cleanup',
      'sessionScope': _firstSessionScope,
    });
    expect(auth.hasSession, isFalse);
  });

  test('a failed queued store operation does not block the next operation',
      () async {
    String? stored;
    var writes = 0;
    final auth = _concurrentAuth(
      read: () async => stored,
      write: (value) async {
        writes += 1;
        if (writes == 1) throw StateError('first write failed');
        stored = value;
      },
      delete: () async => stored = null,
      deleteSessionScope: (_) async {},
      fetch: (method, path) => throw StateError('unexpected request'),
    );

    await expectLater(
      auth.acceptSession(AuthSession.fromJson(_nativeSessionJson())),
      throwsA(
        isA<ChikAuthError>().having(
          (error) => error.code,
          'code',
          ChikErrorCode.storageError,
        ),
      ),
    );
    final replacement = await auth.acceptSession(AuthSession.fromJson(
      _nativeSessionJson(
        userId: 'second-user',
        sessionToken: 'second-access',
        refreshToken: 'second-refresh',
      ),
    ));

    expect(replacement.user.userId, 'second-user');
    expect(writes, 2);
    final persisted = jsonDecode(stored!) as Map<String, Object?>;
    expect(persisted['sessionToken'], 'second-access');
    expect(persisted['sessionScope'], _firstSessionScope);
  });
}

typedef _DeferredFetch = Future<ChikAuthResponse> Function(
  String method,
  String path,
);

ChikNativeAuth _concurrentAuth({
  required ChikNativeSessionRead read,
  required ChikNativeSessionWrite write,
  required ChikNativeSessionDelete delete,
  required ChikNativeSessionScopeDelete deleteSessionScope,
  required _DeferredFetch fetch,
}) {
  return ChikNativeAuth(
    baseUrl: 'https://app.example.test',
    sessionStore: ChikNativeSessionStore.json(
      read: read,
      write: write,
      delete: delete,
      deleteSessionScope: deleteSessionScope,
    ),
    fetch: (method, url, {headers, body}) {
      return fetch(method, Uri.parse(url).path);
    },
  );
}

Future<void> _expectAborted(Future<Object?> operation) {
  return expectLater(
    operation,
    throwsA(
      isA<ChikAuthError>().having(
        (error) => error.code,
        'code',
        ChikErrorCode.aborted,
      ),
    ),
  );
}

ChikAuthResponse _jsonResponse(Object value, {int status = 200}) {
  return ChikAuthResponse(
    status: status,
    bodyBytes: Uint8List.fromList(utf8.encode(jsonEncode(value))),
  );
}

Map<String, Object?> _nativeSessionJson({
  String userId = 'user',
  String sessionToken = 'access',
  String refreshToken = 'refresh',
  String sessionScope = _firstSessionScope,
}) {
  return <String, Object?>{
    'user': <String, Object?>{
      'userId': userId,
      'projectId': 'project',
      'email': 'user@example.test',
      'emailVerified': true,
      'disabled': false,
      'createdAt': '2026-01-01T00:00:00Z',
    },
    'sessionToken': sessionToken,
    'refreshToken': refreshToken,
    'expiresAt': '2099-01-01T00:00:00Z',
    'refreshExpiresAt': '2099-01-02T00:00:00Z',
    'sessionScope': sessionScope,
  };
}

Map<String, Object?> _remoteSessionJson({required String userId}) {
  return <String, Object?>{
    'user': <String, Object?>{
      'userId': userId,
      'projectId': 'project',
      'email': 'user@example.test',
      'emailVerified': true,
      'disabled': false,
      'createdAt': '2026-01-01T00:00:00Z',
    },
    'expiresAt': '2099-01-01T01:00:00Z',
  };
}
