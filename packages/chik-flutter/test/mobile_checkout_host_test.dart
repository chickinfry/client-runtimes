import 'dart:async';
import 'dart:convert';

import 'package:chik_client/chik_client.dart';
import 'package:chik_flutter/chik_flutter.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage_platform_interface/flutter_secure_storage_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:webview_flutter_platform_interface/webview_flutter_platform_interface.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final originalStorage = FlutterSecureStoragePlatform.instance;
  final nativePackageCalls = <MethodCall>[];
  setUp(() {
    FlutterSecureStoragePlatform.instance = _MemorySecureStoragePlatform();
    nativePackageCalls.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('dev.chik.checkout/android'),
          (call) async {
            nativePackageCalls.add(call);
            return true;
          },
        );
  });
  tearDown(() {
    FlutterSecureStoragePlatform.instance = originalStorage;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('dev.chik.checkout/android'),
          null,
        );
  });

  testWidgets('document를 표시하고 navigation 결과를 host 동작으로 변환한다', (tester) async {
    final platform = _FakeWebViewPlatform();
    WebViewPlatform.instance = platform;
    final externalUrls = <Uri>[];
    final packageUrls = <(Uri, List<String>)>[];
    final host = ChikFlutterMobileCheckoutHost.withIncomingLinks(
      incomingLinks: const Stream<Uri>.empty(),
      externalLauncher: (url) async {
        externalUrls.add(url);
        return url.scheme == 'https';
      },
      androidPackagesLauncher: (url, packageNames) async {
        packageUrls.add((url, packageNames));
        return false;
      },
    );
    await tester.pumpWidget(
      MaterialApp(navigatorKey: host.navigatorKey, home: const Placeholder()),
    );

    final result = _presentOnAndroid(
      host,
      _presentation((url) {
        if (url.endsWith('/allow')) {
          return const ChikCheckoutNavigation.allow();
        }
        if (url.endsWith('/external')) {
          return const ChikCheckoutNavigation.external(
            'supertoss://payments/open',
            fallbackUrl: 'https://checkout.example/fallback',
            androidPackages: ['viva.republica.toss'],
          );
        }
        return _completedNavigation;
      }),
    );
    await tester.pumpAndSettle();

    expect(platform.controller.document, '<html>checkout</html>');
    expect(find.text('Checkout'), findsOneWidget);
    expect(
      await platform.navigation.navigate('https://checkout.example/allow'),
      NavigationDecision.navigate,
    );
    expect(
      await platform.navigation.navigate('bankapp://pay/external'),
      NavigationDecision.prevent,
    );
    expect(packageUrls, hasLength(1));
    expect(packageUrls.single.$1, Uri.parse('supertoss://payments/open'));
    expect(packageUrls.single.$2, ['viva.republica.toss']);
    expect(externalUrls, <Uri>[Uri.parse('https://checkout.example/fallback')]);
    expect(
      await platform.navigation.navigate('https://checkout.example/complete'),
      NavigationDecision.prevent,
    );
    await tester.pumpAndSettle();
    expect(await result, 'https://checkout.example/complete');
    expect(host.hasActiveSession, isFalse);
    final recovery = await host.restoreCheckout(_sessionScope);
    expect(recovery?.redirectUrl, 'https://checkout.example/complete');
    await expectLater(
      host.completeCheckout('wrong-capability', _sessionScope),
      throwsA(
        isA<ChikCheckoutException>().having(
          (error) => error.code,
          'code',
          ChikErrorCode.failedPrecondition,
        ),
      ),
    );
    await host.completeCheckout(
      _testPreparation.approvalCapability,
      _sessionScope,
    );
    expect(await host.restoreCheckout(_sessionScope), isNull);
  });

  testWidgets('WebView와 app link가 동시에 완료되어도 recovery를 한 번만 기록한다', (
    tester,
  ) async {
    final platform = _FakeWebViewPlatform();
    WebViewPlatform.instance = platform;
    final storage =
        FlutterSecureStoragePlatform.instance as _MemorySecureStoragePlatform;
    final redirectGate = storage.blockNextRedirectWrites(1).single;
    final links = StreamController<Uri>.broadcast(sync: true);
    final host = ChikFlutterMobileCheckoutHost.withIncomingLinks(
      incomingLinks: links.stream,
    );
    await tester.pumpWidget(
      MaterialApp(navigatorKey: host.navigatorKey, home: const Placeholder()),
    );

    final result = _presentOnAndroid(
      host,
      _presentation((_) => _completedNavigation),
    );
    String? completedUrl;
    Object? completionError;
    unawaited(
      result.then<void>(
        (value) => completedUrl = value,
        onError: (Object error, StackTrace _) => completionError = error,
      ),
    );
    await tester.pump(const Duration(seconds: 1));
    final navigation = platform.navigation.navigate(
      'https://checkout.example/webview-complete',
    );
    NavigationDecision? navigationDecision;
    Object? navigationError;
    unawaited(
      navigation.then<void>(
        (value) => navigationDecision = value,
        onError: (Object error, StackTrace _) => navigationError = error,
      ),
    );
    await tester.pump();
    final writesBeforeLink = storage.redirectWrites;
    links.add(Uri.parse('exampleapp://app-link-complete'));
    await tester.pump();
    final writesAfterLink = storage.redirectWrites;

    redirectGate.complete();
    await tester.pump();
    expect(writesBeforeLink, 1);
    expect(writesAfterLink, 1);
    expect(navigationError, isNull);
    expect(navigationDecision, NavigationDecision.prevent);
    expect(completionError, isNull);
    expect(completedUrl, 'https://checkout.example/webview-complete');
    await host.completeCheckout(
      _testPreparation.approvalCapability,
      _sessionScope,
    );
    await tester.pump();

    expect(storage.redirectWrites, 1);
    expect(storage.values.containsKey(_recoveryKey), isFalse);
    await links.close();
  });

  testWidgets('로그인 세션이 바뀌면 열린 checkout과 복구 상태를 닫는다', (tester) async {
    final platform = _FakeWebViewPlatform();
    WebViewPlatform.instance = platform;
    final lease = ChikSessionScopeLease(_sessionScope);
    final host = ChikFlutterMobileCheckoutHost.withIncomingLinks(
      incomingLinks: const Stream<Uri>.empty(),
    );
    await tester.pumpWidget(
      MaterialApp(navigatorKey: host.navigatorKey, home: const Placeholder()),
    );

    final result = _presentOnAndroid(
      host,
      _presentation(
        (_) => const ChikCheckoutNavigation.allow(),
        sessionScopeLease: lease,
      ),
    );
    final rejected = expectLater(
      result,
      throwsA(
        isA<ChikCheckoutException>()
            .having(
              (error) => error.code,
              'code',
              ChikErrorCode.unauthenticated,
            )
            .having((error) => error.status, 'status', 401),
      ),
    );
    await tester.pumpAndSettle();
    lease.invalidate();
    await tester.pumpAndSettle();

    await rejected;
    expect(host.hasActiveSession, isFalse);
    expect(await host.restoreCheckout(_sessionScope), isNull);
  });

  test('Android custom scheme은 생성된 package-bound launcher로만 연다', () async {
    final host = ChikFlutterMobileCheckoutHost.withIncomingLinks(
      incomingLinks: const Stream<Uri>.empty(),
    );
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    try {
      for (final url in <String>[
        'wallet://pay',
        'market://details?id=viva.republica.toss',
      ]) {
        await expectLater(
          host.openExternal(url),
          throwsA(
            isA<ChikCheckoutException>()
                .having(
                  (error) => error.code,
                  'code',
                  ChikErrorCode.invalidArgument,
                )
                .having((error) => error.status, 'status', 400),
          ),
        );
      }
      await host.openExternal(
        'samsungpay://payments/open',
        androidPackages: [
          'com.samsung.android.spay',
          'com.samsung.android.spaylite',
        ],
      );
      expect(nativePackageCalls, hasLength(1));
      expect(nativePackageCalls.single.method, 'openPackages');
      expect(nativePackageCalls.single.arguments, <String, Object>{
        'url': 'samsungpay://payments/open',
        'packageNames': [
          'com.samsung.android.spay',
          'com.samsung.android.spaylite',
        ],
      });
    } finally {
      debugDefaultTargetPlatformOverride = null;
      await host.dispose();
    }
  });

  test('만료된 checkout recovery는 다음 요청을 막지 않고 제거한다', () async {
    final storage =
        FlutterSecureStoragePlatform.instance as _MemorySecureStoragePlatform;
    storage.values[_recoveryKey] = jsonEncode(<String, Object?>{
      'version': 1,
      'expiresAt': DateTime.now().millisecondsSinceEpoch - 1,
      'sessionScope': _sessionScope,
      'recovery': <String, Object?>{'preparation': _testPreparation.toJson()},
    });
    final host = ChikFlutterMobileCheckoutHost.withIncomingLinks(
      incomingLinks: const Stream<Uri>.empty(),
    );
    expect(await host.restoreCheckout(_sessionScope), isNull);
    expect(storage.values.containsKey(_recoveryKey), isFalse);
    await host.dispose();
  });

  test('checkout recovery는 서버 intent 수명보다 오래 남을 수 없다', () async {
    final storage =
        FlutterSecureStoragePlatform.instance as _MemorySecureStoragePlatform;
    storage.values[_recoveryKey] = jsonEncode(<String, Object?>{
      'version': 1,
      'expiresAt': DateTime.now()
          .add(const Duration(minutes: 40, seconds: 1))
          .millisecondsSinceEpoch,
      'sessionScope': _sessionScope,
      'recovery': <String, Object?>{'preparation': _testPreparation.toJson()},
    });
    final host = ChikFlutterMobileCheckoutHost.withIncomingLinks(
      incomingLinks: const Stream<Uri>.empty(),
    );
    await expectLater(
      host.restoreCheckout(_sessionScope),
      throwsA(
        isA<ChikCheckoutException>().having(
          (error) => error.code,
          'code',
          ChikErrorCode.storageError,
        ),
      ),
    );
    expect(storage.values.containsKey(_recoveryKey), isFalse);
    await host.dispose();
  });

  test('checkout recovery는 현재 native session scope별로 격리한다', () async {
    final storage =
        FlutterSecureStoragePlatform.instance as _MemorySecureStoragePlatform;
    final expiresAt = DateTime.now()
        .add(const Duration(minutes: 40))
        .millisecondsSinceEpoch;
    storage.values[_recoveryKey] = jsonEncode(<String, Object?>{
      'version': 1,
      'expiresAt': expiresAt,
      'sessionScope': _sessionScope,
      'recovery': <String, Object?>{'preparation': _testPreparation.toJson()},
    });
    final host = ChikFlutterMobileCheckoutHost.withIncomingLinks(
      incomingLinks: const Stream<Uri>.empty(),
    );
    const otherScope =
        'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';

    expect(await host.restoreCheckout(otherScope), isNull);
    await host.completeCheckout(
      _testPreparation.approvalCapability,
      otherScope,
    );
    expect(storage.values.containsKey(_recoveryKey), isTrue);
    expect(
      (await host.restoreCheckout(_sessionScope))?.preparation.toJson(),
      _testPreparation.toJson(),
    );

    storage.values[_recoveryKey] = jsonEncode(<String, Object?>{
      'version': 1,
      'expiresAt': expiresAt,
      'sessionScope': otherScope,
      'recovery': <String, Object?>{'preparation': _testPreparation.toJson()},
    });
    await expectLater(
      host.restoreCheckout(_sessionScope),
      throwsA(
        isA<ChikCheckoutException>().having(
          (error) => error.code,
          'code',
          ChikErrorCode.storageError,
        ),
      ),
    );
    expect(storage.values.containsKey(_recoveryKey), isFalse);
    await host.dispose();
  });

  test('navigator 없는 present 실패는 secure recovery를 제거한다', () async {
    final host = ChikFlutterMobileCheckoutHost.withIncomingLinks(
      incomingLinks: const Stream<Uri>.empty(),
    );
    await expectLater(
      _presentOnAndroid(
        host,
        _presentation((_) => const ChikCheckoutNavigation.allow()),
      ),
      throwsA(
        isA<ChikCheckoutException>()
            .having(
              (error) => error.code,
              'code',
              ChikErrorCode.failedPrecondition,
            )
            .having((error) => error.status, 'status', 412),
      ),
    );
    final storage =
        FlutterSecureStoragePlatform.instance as _MemorySecureStoragePlatform;
    expect(storage.values.containsKey(_recoveryKey), isFalse);
    await host.dispose();
  });

  testWidgets('단일 session과 dismiss·timeout을 fail-closed로 집행한다', (tester) async {
    final platform = _FakeWebViewPlatform();
    WebViewPlatform.instance = platform;
    final host = ChikFlutterMobileCheckoutHost.withIncomingLinks(
      incomingLinks: const Stream<Uri>.empty(),
      timeout: const Duration(seconds: 1),
      externalLauncher: (_) async => true,
    );
    await tester.pumpWidget(
      MaterialApp(navigatorKey: host.navigatorKey, home: const Placeholder()),
    );

    final first = _presentOnAndroid(
      host,
      _presentation((_) => const ChikCheckoutNavigation.allow()),
    );
    await tester.pump();
    await expectLater(
      _presentOnAndroid(
        host,
        _presentation((_) => const ChikCheckoutNavigation.allow()),
      ),
      throwsA(
        isA<ChikCheckoutException>().having(
          (error) => error.code,
          'code',
          ChikErrorCode.failedPrecondition,
        ),
      ),
    );
    final canceled = expectLater(
      first,
      throwsA(
        isA<ChikCheckoutException>().having(
          (error) => error.code,
          'code',
          ChikErrorCode.canceled,
        ),
      ),
    );
    await host.dismiss();
    await tester.pumpAndSettle();
    await canceled;
    final storage =
        FlutterSecureStoragePlatform.instance as _MemorySecureStoragePlatform;
    expect(storage.values.containsKey(_recoveryKey), isFalse);

    final timedOut = expectLater(
      _presentOnAndroid(
        host,
        _presentation((_) => const ChikCheckoutNavigation.allow()),
      ),
      throwsA(
        isA<ChikCheckoutException>()
            .having(
              (error) => error.code,
              'code',
              ChikErrorCode.deadlineExceeded,
            )
            .having((error) => error.status, 'status', 504)
            .having((error) => error.message, 'message', 'Checkout timed out.'),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    await timedOut;
    expect(storage.values.containsKey(_recoveryKey), isFalse);
  });

  testWidgets('cold-start app link를 보관하고 active WebView에 전달한다', (tester) async {
    final platform = _FakeWebViewPlatform();
    WebViewPlatform.instance = platform;
    final resumedUrl = Uri.parse('https://checkout.example/resume');
    final links = StreamController<Uri>.broadcast(sync: true);
    addTearDown(links.close);
    final host = ChikFlutterMobileCheckoutHost.withIncomingLinks(
      incomingLinks: links.stream,
      externalLauncher: (_) async => true,
    );
    links.add(
      Uri.parse(
        'exampleapp://?url=${Uri.encodeQueryComponent(resumedUrl.toString())}',
      ),
    );
    await tester.pumpWidget(
      MaterialApp(navigatorKey: host.navigatorKey, home: const Placeholder()),
    );

    final returnedUrls = <String>[];
    final result = _presentOnAndroid(
      host,
      _presentation((url) {
        returnedUrls.add(url);
        if (url.startsWith('exampleapp://')) {
          return ChikCheckoutNavigation.resume(resumedUrl.toString());
        }
        if (url == 'https://checkout.example/complete') {
          return _completedNavigation;
        }
        throw const ChikCheckoutException(
          ChikErrorCode.invalidArgument,
          'The checkout navigation URL is invalid.',
          400,
        );
      }),
    );
    await tester.pump();
    expect(returnedUrls.single, startsWith('exampleapp:'));
    expect(platform.controller.request, resumedUrl);
    expect(
      await platform.navigation.navigate('https://checkout.example/complete'),
      NavigationDecision.prevent,
    );
    await tester.pumpAndSettle();
    expect(await result, 'https://checkout.example/complete');
    links.add(Uri.parse('exampleapp://stale'));
    await tester.pump();
    expect(host.hasActiveSession, isFalse);
  });

  testWidgets('다른 pending checkout을 덮어쓰지 않는다', (tester) async {
    final platform = _FakeWebViewPlatform();
    WebViewPlatform.instance = platform;
    final storage =
        FlutterSecureStoragePlatform.instance as _MemorySecureStoragePlatform;
    storage.values[_recoveryKey] = jsonEncode(<String, Object?>{
      'version': 1,
      'expiresAt': DateTime.now()
          .add(const Duration(minutes: 40))
          .millisecondsSinceEpoch,
      'sessionScope': _sessionScope,
      'recovery': <String, Object?>{
        'preparation': <String, Object?>{
          ..._testPreparation.toJson(),
          'approvalCapability': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      },
    });
    final host = ChikFlutterMobileCheckoutHost.withIncomingLinks(
      incomingLinks: const Stream<Uri>.empty(),
      externalLauncher: (_) async => true,
    );
    await tester.pumpWidget(
      MaterialApp(navigatorKey: host.navigatorKey, home: const Placeholder()),
    );

    await expectLater(
      _presentOnAndroid(
        host,
        _presentation((_) => const ChikCheckoutNavigation.allow()),
      ),
      throwsA(
        isA<ChikCheckoutException>()
            .having(
              (error) => error.code,
              'code',
              ChikErrorCode.failedPrecondition,
            )
            .having((error) => error.status, 'status', 412),
      ),
    );
    expect(storage.values[_recoveryKey], contains('bbbbbbbb'));
  });

  testWidgets('잘못된 secure recovery record는 실패하고 제거한다', (tester) async {
    final storage =
        FlutterSecureStoragePlatform.instance as _MemorySecureStoragePlatform;
    final host = ChikFlutterMobileCheckoutHost.withIncomingLinks(
      incomingLinks: const Stream<Uri>.empty(),
      externalLauncher: (_) async => true,
    );

    final invalidRecords = <Map<String, Object?>>[
      <String, Object?>{
        'preparation': <String, Object?>{
          'approvalCapability': _testPreparation.approvalCapability,
        },
      },
      <String, Object?>{
        'preparation': _testPreparation.toJson(),
        'unexpected': true,
      },
      <String, Object?>{
        'preparation': <String, Object?>{
          ..._testPreparation.toJson(),
          'unexpected': true,
        },
      },
      <String, Object?>{
        'preparation': <String, Object?>{
          ..._testPreparation.toJson(),
          'requestId': ' ',
        },
      },
      <String, Object?>{
        'preparation': <String, Object?>{
          ..._testPreparation.toJson(),
          'requestId': ' request-1',
        },
      },
      <String, Object?>{
        'preparation': <String, Object?>{
          ..._testPreparation.toJson(),
          'requestId': ''.padRight(513, 'x'),
        },
      },
      <String, Object?>{
        'preparation': <String, Object?>{
          ..._testPreparation.toJson(),
          'orderId': 'order=1',
        },
      },
      <String, Object?>{
        'preparation': <String, Object?>{
          ..._testPreparation.toJson(),
          'orderName': ' Order',
        },
      },
      <String, Object?>{
        'preparation': <String, Object?>{
          ..._testPreparation.toJson(),
          'customerKey': 'customer',
        },
      },
      <String, Object?>{
        'preparation': _testPreparation.toJson(),
        'redirectUrl': null,
      },
      <String, Object?>{
        'preparation': _testPreparation.toJson(),
        'redirectUrl': 'not a URL',
      },
      <String, Object?>{
        'preparation': _testPreparation.toJson(),
        'redirectUrl': 'http://checkout.example/complete',
      },
      <String, Object?>{
        'preparation': _testPreparation.toJson(),
        'redirectUrl': 'https://attacker@checkout.example/complete',
      },
      <String, Object?>{
        'preparation': _testPreparation.toJson(),
        'redirectUrl': 'https://checkout.example/complete#result',
      },
      <String, Object?>{
        'preparation': _testPreparation.toJson(),
        'redirectUrl':
            'https://checkout.example/${''.padRight(16 * 1024, 'x')}',
      },
    ];
    for (final encoded in <String>[
      '',
      ' ',
      ...invalidRecords.map(
        (record) => jsonEncode(<String, Object?>{
          'version': 1,
          'expiresAt': DateTime.now()
              .add(const Duration(minutes: 40))
              .millisecondsSinceEpoch,
          'sessionScope': _sessionScope,
          'recovery': record,
        }),
      ),
    ]) {
      storage.values[_recoveryKey] = encoded;
      await expectLater(
        host.restoreCheckout(_sessionScope),
        throwsA(
          isA<ChikCheckoutException>().having(
            (error) => error.code,
            'code',
            ChikErrorCode.storageError,
          ),
        ),
      );
      expect(storage.values.containsKey(_recoveryKey), isFalse);
    }
  });

  testWidgets('cold-start app link 재개 뒤 failure redirect도 완료한다', (
    tester,
  ) async {
    final platform = _FakeWebViewPlatform();
    WebViewPlatform.instance = platform;
    final resumedUrl = Uri.parse('https://checkout.example/resume');
    final failedUrl = Uri.parse('https://checkout.example/fail');
    final links = StreamController<Uri>.broadcast(sync: true);
    addTearDown(links.close);
    final host = ChikFlutterMobileCheckoutHost.withIncomingLinks(
      incomingLinks: links.stream,
      externalLauncher: (_) async => true,
    );
    links.add(
      Uri.parse(
        'exampleapp://?url=${Uri.encodeQueryComponent(resumedUrl.toString())}',
      ),
    );
    await tester.pumpWidget(
      MaterialApp(navigatorKey: host.navigatorKey, home: const Placeholder()),
    );

    final result = _presentOnAndroid(
      host,
      _presentation((url) {
        if (url.startsWith('exampleapp://')) {
          return ChikCheckoutNavigation.resume(resumedUrl.toString());
        }
        return _completedNavigation;
      }),
    );
    await tester.pump();
    expect(platform.controller.request, resumedUrl);
    expect(
      await platform.navigation.navigate(failedUrl.toString()),
      NavigationDecision.prevent,
    );
    await tester.pumpAndSettle();
    expect(await result, failedUrl.toString());
  });

  testWidgets('복구 정보 없는 cold-start는 즉시 실패하고 warm 복귀는 session을 유지한다', (
    tester,
  ) async {
    final coldPlatform = _FakeWebViewPlatform();
    WebViewPlatform.instance = coldPlatform;
    final coldLinks = StreamController<Uri>.broadcast(sync: true);
    addTearDown(coldLinks.close);
    final coldHost = ChikFlutterMobileCheckoutHost.withIncomingLinks(
      incomingLinks: coldLinks.stream,
      externalLauncher: (_) async => true,
    );
    coldLinks.add(Uri.parse('exampleapp://'));
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: coldHost.navigatorKey,
        home: const Placeholder(),
      ),
    );
    final coldResult = _presentOnAndroid(
      coldHost,
      _presentation((url) {
        if (url.startsWith('exampleapp:')) {
          return const ChikCheckoutNavigation.restore();
        }
        return const ChikCheckoutNavigation.allow();
      }),
    );
    final coldFailure = expectLater(
      coldResult,
      throwsA(
        isA<ChikCheckoutException>()
            .having(
              (error) => error.code,
              'code',
              ChikErrorCode.failedPrecondition,
            )
            .having((error) => error.status, 'status', 412),
      ),
    );
    await tester.pump();
    await coldFailure;
    final storage =
        FlutterSecureStoragePlatform.instance as _MemorySecureStoragePlatform;
    expect(storage.values.containsKey(_recoveryKey), isFalse);

    final warmPlatform = _FakeWebViewPlatform();
    WebViewPlatform.instance = warmPlatform;
    final warmLinks = StreamController<Uri>.broadcast(sync: true);
    addTearDown(warmLinks.close);
    final warmHost = ChikFlutterMobileCheckoutHost.withIncomingLinks(
      incomingLinks: warmLinks.stream,
      externalLauncher: (_) async => true,
    );
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: warmHost.navigatorKey,
        home: const Placeholder(),
      ),
    );
    final warmResult = _presentOnAndroid(
      warmHost,
      _presentation((url) {
        if (url.startsWith('exampleapp:')) {
          return const ChikCheckoutNavigation.restore();
        }
        if (url == 'https://checkout.example/page') {
          return const ChikCheckoutNavigation.allow();
        }
        return _completedNavigation;
      }),
    );
    await tester.pump();
    warmLinks.add(Uri.parse('https://checkout.example/page'));
    await tester.pump();
    expect(warmPlatform.controller.request, isNull);
    warmLinks.add(Uri.parse('exampleapp://'));
    await tester.pump();
    expect(warmPlatform.controller.request, isNull);
    expect(
      await warmPlatform.navigation.navigate(
        'https://checkout.example/complete',
      ),
      NavigationDecision.prevent,
    );
    await tester.pumpAndSettle();
    expect(await warmResult, 'https://checkout.example/complete');
  });
}

Future<String> _presentOnAndroid(
  ChikFlutterMobileCheckoutHost host,
  ChikCheckoutPresentation presentation,
) {
  debugDefaultTargetPlatformOverride = TargetPlatform.android;
  try {
    return host.present(presentation);
  } finally {
    debugDefaultTargetPlatformOverride = null;
  }
}

ChikCheckoutPresentation _presentation(
  ChikCheckoutNavigation Function(String url) navigate, {
  ChikSessionScopeLease? sessionScopeLease,
}) {
  return ChikCheckoutPresentation(
    document: '<html>checkout</html>',
    returnScheme: 'exampleapp://',
    sessionScope: _sessionScope,
    sessionScopeLease:
        sessionScopeLease ?? ChikSessionScopeLease(_sessionScope),
    recovery: const ChikMobileCheckoutRecovery(preparation: _testPreparation),
    navigate: navigate,
  );
}

const _testPreparation = ChikCheckoutPreparation(
  requestId: 'request-1',
  orderId: 'order-1',
  orderName: 'Order',
  amount: 1000,
  currency: 'KRW',
  customerKey: 'customer-1',
  approvalCapability: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
);

const _sessionScope =
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const _recoveryKey = 'chik.checkout.$_sessionScope';

const _completedNavigation = ChikCheckoutNavigation.complete(
  ChikCheckoutFailure(
    code: 'payment_failed',
    message: 'Checkout could not be completed.',
  ),
);

final class _FakeWebViewPlatform extends WebViewPlatform {
  late _FakePlatformWebViewController controller;
  late _FakePlatformNavigationDelegate navigation;

  @override
  PlatformWebViewController createPlatformWebViewController(
    PlatformWebViewControllerCreationParams params,
  ) {
    return controller = _FakePlatformWebViewController(params);
  }

  @override
  PlatformNavigationDelegate createPlatformNavigationDelegate(
    PlatformNavigationDelegateCreationParams params,
  ) {
    return navigation = _FakePlatformNavigationDelegate(params);
  }

  @override
  PlatformWebViewWidget createPlatformWebViewWidget(
    PlatformWebViewWidgetCreationParams params,
  ) {
    return _FakePlatformWebViewWidget(params);
  }
}

final class _FakePlatformWebViewController extends PlatformWebViewController {
  _FakePlatformWebViewController(super.params) : super.implementation();

  String? document;
  Uri? request;

  @override
  Future<void> setJavaScriptMode(JavaScriptMode javaScriptMode) async {}

  @override
  Future<void> setPlatformNavigationDelegate(
    PlatformNavigationDelegate handler,
  ) async {}

  @override
  Future<void> loadHtmlString(String html, {String? baseUrl}) async {
    document = html;
  }

  @override
  Future<void> loadRequest(LoadRequestParams params) async {
    request = params.uri;
  }
}

final class _FakePlatformNavigationDelegate extends PlatformNavigationDelegate {
  _FakePlatformNavigationDelegate(super.params) : super.implementation();

  NavigationRequestCallback? _onNavigationRequest;

  @override
  Future<void> setOnNavigationRequest(
    NavigationRequestCallback onNavigationRequest,
  ) async {
    _onNavigationRequest = onNavigationRequest;
  }

  @override
  Future<void> setOnWebResourceError(
    WebResourceErrorCallback onWebResourceError,
  ) async {}

  Future<NavigationDecision> navigate(String url) async {
    return _onNavigationRequest!(
      NavigationRequest(url: url, isMainFrame: true),
    );
  }
}

final class _FakePlatformWebViewWidget extends PlatformWebViewWidget {
  _FakePlatformWebViewWidget(super.params) : super.implementation();

  @override
  Widget build(BuildContext context) => const ColoredBox(color: Colors.white);
}

final class _MemorySecureStoragePlatform extends FlutterSecureStoragePlatform {
  final Map<String, String> values = <String, String>{};
  final List<Completer<void>> _redirectWriteGates = <Completer<void>>[];
  int redirectWrites = 0;

  List<Completer<void>> blockNextRedirectWrites(int count) {
    final gates = List<Completer<void>>.generate(
      count,
      (_) => Completer<void>(),
    );
    _redirectWriteGates.addAll(gates);
    return gates;
  }

  @override
  Future<bool> containsKey({
    required String key,
    required Map<String, String> options,
  }) async => values.containsKey(key);

  @override
  Future<void> delete({
    required String key,
    required Map<String, String> options,
  }) async {
    values.remove(key);
  }

  @override
  Future<void> deleteAll({required Map<String, String> options}) async =>
      values.clear();

  @override
  Future<String?> read({
    required String key,
    required Map<String, String> options,
  }) async => values[key];

  @override
  Future<Map<String, String>> readAll({
    required Map<String, String> options,
  }) async => Map<String, String>.from(values);

  @override
  Future<void> write({
    required String key,
    required String value,
    required Map<String, String> options,
  }) async {
    if (value.contains('"redirectUrl"')) {
      final index = redirectWrites++;
      if (index < _redirectWriteGates.length) {
        await _redirectWriteGates[index].future;
      }
    }
    values[key] = value;
  }
}
