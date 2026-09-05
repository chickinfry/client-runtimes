import 'package:chik_client/chik_client.dart';
import 'package:test/test.dart';

const _approvalCapability = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const _sessionScope =
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
final _mobileHostCause = StateError('raw mobile host detail');

const _configuration = ChikCheckoutBridgeConfiguration(
  extension: 'payments/toss',
  clientKey: 'test_gck_checkout_test',
  successUrl: 'https://example.test/payments/success',
  failUrl: 'https://example.test/payments/fail',
  appScheme: 'exampleapp',
);

ChikCheckoutBridgeConfiguration _configurationWithClientKey(
  String clientKey,
) =>
    ChikCheckoutBridgeConfiguration(
      extension: _configuration.extension,
      clientKey: clientKey,
      successUrl: _configuration.successUrl,
      failUrl: _configuration.failUrl,
      appScheme: _configuration.appScheme,
    );

ChikCheckoutPreparation _preparation({
  String orderName = 'Order one',
}) {
  return ChikCheckoutPreparation(
    requestId: 'request-1',
    orderId: 'order-1',
    orderName: orderName,
    amount: 15000,
    currency: 'KRW',
    customerKey: 'customer-1',
    approvalCapability: _approvalCapability,
  );
}

String _successUrl({
  String amount = '15000',
  bool paymentTypeInRedirect = true,
}) {
  return Uri.parse(_configuration.successUrl).replace(
    queryParameters: <String, String>{
      'paymentKey': 'payment-key-1',
      'orderId': 'order-1',
      'amount': amount,
      if (paymentTypeInRedirect) 'paymentType': 'NORMAL',
      'chikCheckoutState': _approvalCapability,
    },
  ).toString();
}

String _returnUrl(String nested) =>
    '${_configuration.appScheme}://?url=${Uri.encodeQueryComponent(nested)}';

String _failureUrl({
  String code = 'PAY_PROCESS_CANCELED',
  String message = 'provider detail that must not escape',
}) {
  return Uri.parse(_configuration.failUrl).replace(
    queryParameters: <String, String>{
      'code': code,
      'message': message,
      'orderId': 'order-1',
      'chikCheckoutState': _approvalCapability,
    },
  ).toString();
}

Matcher _invalidArgument() {
  return isA<ChikCheckoutException>().having(
    (error) => error.code,
    'code',
    ChikErrorCode.invalidArgument,
  );
}

void main() {
  test('mobile checkout selects the flow from the client key family', () {
    for (final clientKey in <String>[
      'test_gck_checkout_test',
      'live_gck_checkout_test',
    ]) {
      final document = createChikMobileCheckoutDocument(
        _configurationWithClientKey(clientKey),
        _preparation(),
      );
      expect(document, contains('payments.widgets('));
      expect(document, isNot(contains('payments.payment(')));
    }

    for (final clientKey in <String>[
      'test_ck_checkout_test',
      'live_ck_checkout_test',
    ]) {
      final document = createChikMobileCheckoutDocument(
        _configurationWithClientKey(clientKey),
        _preparation(),
      );
      expect(document, contains('payments.payment('));
      expect(document, contains('method:"CARD"'));
      expect(document, contains('flowMode:"DEFAULT"'));
      expect(document, contains('windowTarget:"self"'));
      expect(document, contains('appScheme:input.config.appScheme+"://"'));
      expect(document, contains('CHECKOUT_REQUEST_FAILED'));
      expect(document, isNot(contains('payments.widgets(')));
    }

    for (final clientKey in <String>[
      'test_gsk_checkout_test',
      'test_sk_checkout_test',
      'staging_ck_checkout_test',
      'test_unknown_checkout_test',
    ]) {
      expect(
        () => createChikMobileCheckoutDocument(
          _configurationWithClientKey(clientKey),
          _preparation(),
        ),
        throwsA(_invalidArgument()),
      );
    }
  });

  test('checkout redirects accept success and normalize provider failures', () {
    final success = parseChikCheckoutRedirect(
      _configuration,
      _successUrl(),
    );
    expect(success, isA<ChikCheckoutSuccess>());
    final successful = success as ChikCheckoutSuccess;
    expect(successful.paymentKey, 'payment-key-1');
    expect(successful.orderId, 'order-1');
    expect(successful.amount, 15000);
    expect(successful.paymentType, 'NORMAL');
    expect(successful.approvalCapability, _approvalCapability);

    final individual = parseChikCheckoutRedirect(
      _configurationWithClientKey('test_ck_checkout_test'),
      _successUrl(paymentTypeInRedirect: false),
    ) as ChikCheckoutSuccess;
    expect(individual.paymentType, 'NORMAL');
    expect(individual.paymentKey, successful.paymentKey);

    final canceled = parseChikCheckoutRedirect(
      _configuration,
      _failureUrl(),
    );
    expect(canceled, isA<ChikCheckoutFailure>());
    final canceledFailure = canceled as ChikCheckoutFailure;
    expect(canceledFailure.code, 'canceled');
    expect(canceledFailure.message, 'Checkout was canceled.');
    expect(
      '${canceledFailure.code}:${canceledFailure.message}',
      isNot(contains('PAY_PROCESS_CANCELED')),
    );
    expect(
      '${canceledFailure.code}:${canceledFailure.message}',
      isNot(contains('provider detail')),
    );

    final unavailable = parseChikCheckoutRedirect(
      _configuration,
      _failureUrl(
        code: 'CHECKOUT_UI_UNAVAILABLE',
        message: 'provider SDK boot detail',
      ),
    ) as ChikCheckoutFailure;
    expect(unavailable.code, 'ui_unavailable');
    expect(unavailable.message, 'The checkout UI could not be loaded.');
    expect(
      '${unavailable.code}:${unavailable.message}',
      isNot(contains('provider SDK')),
    );

    final failed = parseChikCheckoutRedirect(
      _configuration,
      _failureUrl(
        code: 'SOME_PROVIDER_CODE',
        message: 'provider stack detail',
      ),
    ) as ChikCheckoutFailure;
    expect(failed.code, 'payment_failed');
    expect(failed.message, 'Checkout could not be completed.');
    expect(
      '${failed.code}:${failed.message}',
      isNot(contains('SOME_PROVIDER_CODE')),
    );
    expect(
      '${failed.code}:${failed.message}',
      isNot(contains('provider stack')),
    );
  });

  test('success amount is an ASCII decimal integer only', () {
    for (final amount in <String>[
      '1e3',
      '+15000',
      '15000.0',
      ' 15000',
      '15000 ',
      '1500\u0660',
    ]) {
      expect(
        () => parseChikCheckoutRedirect(
          _configuration,
          _successUrl(amount: amount),
        ),
        throwsA(_invalidArgument()),
        reason: 'accepted non-ASCII-decimal amount: $amount',
      );
    }
  });

  test('checkout supports KRW and NORMAL payment callbacks only', () {
    expect(
      () => createChikMobileCheckoutDocument(
        _configuration,
        ChikCheckoutPreparation(
          requestId: 'request-1',
          orderId: 'order-1',
          orderName: 'Order one',
          amount: 15000,
          currency: 'USD',
          customerKey: 'customer-1',
          approvalCapability: _approvalCapability,
        ),
      ),
      throwsA(_invalidArgument()),
    );
    expect(
      () => parseChikCheckoutRedirect(
        _configuration,
        _successUrl()
            .replaceFirst('paymentType=NORMAL', 'paymentType=BRANDPAY'),
      ),
      throwsA(_invalidArgument()),
    );
    expect(
      () => parseChikCheckoutRedirect(
        _configuration,
        _successUrl(paymentTypeInRedirect: false),
      ),
      throwsA(_invalidArgument()),
    );
    expect(
      () => parseChikCheckoutRedirect(
        _configurationWithClientKey('test_ck_checkout_test'),
        _successUrl(),
      ),
      throwsA(_invalidArgument()),
    );
    expect(
      () => createChikMobileCheckoutDocument(
        ChikCheckoutBridgeConfiguration(
          extension: _configuration.extension,
          clientKey: _configuration.clientKey,
          successUrl: '${_configuration.successUrl}?paymentType=NORMAL',
          failUrl: _configuration.failUrl,
          appScheme: _configuration.appScheme,
        ),
        _preparation(),
      ),
      throwsA(_invalidArgument()),
    );
  });

  test('mobile checkout rejects ambiguous callbacks and reserved schemes', () {
    for (final configuration in <ChikCheckoutBridgeConfiguration>[
      ChikCheckoutBridgeConfiguration(
        extension: _configuration.extension,
        clientKey: _configuration.clientKey,
        successUrl: _configuration.successUrl,
        failUrl: _configuration.successUrl,
        appScheme: _configuration.appScheme,
      ),
      ChikCheckoutBridgeConfiguration(
        extension: _configuration.extension,
        clientKey: _configuration.clientKey,
        successUrl: 'https://example.test/payments/return',
        failUrl: 'https://example.test/payments/return?outcome=failed',
        appScheme: _configuration.appScheme,
      ),
      for (final scheme in <String>['supertoss', 'intent', 'javascript'])
        ChikCheckoutBridgeConfiguration(
          extension: _configuration.extension,
          clientKey: _configuration.clientKey,
          successUrl: _configuration.successUrl,
          failUrl: _configuration.failUrl,
          appScheme: scheme,
        ),
    ]) {
      expect(
        () => createChikMobileCheckoutDocument(configuration, _preparation()),
        throwsA(_invalidArgument()),
      );
    }
    expect(
      () => createChikMobileCheckoutDocument(
        _configuration,
        ChikCheckoutPreparation(
          requestId: 'request-1',
          orderId: 'order=1',
          orderName: 'Order one',
          amount: 15000,
          currency: 'KRW',
          customerKey: 'customer-1',
          approvalCapability: _approvalCapability,
        ),
      ),
      throwsA(_invalidArgument()),
    );
  });

  test('redirect validation rejects forged, duplicate, and oversized URLs', () {
    final duplicatePaymentKey = '${_successUrl()}&paymentKey=forged-key';
    final duplicateCapability =
        '${_successUrl()}&chikCheckoutState=$_approvalCapability';
    final oversized = List<String>.filled(17000, 'x').join();
    final invalid = <String>[
      _successUrl().replaceFirst(_approvalCapability, 'too-short'),
      duplicatePaymentKey,
      duplicateCapability,
      _successUrl().replaceFirst('example.test', 'attacker.test'),
      _successUrl().replaceFirst('/payments/success', '/payments/other'),
      _successUrl().replaceFirst('https://', 'https://attacker@'),
      '${_successUrl()}#forged',
      '${_configuration.successUrl}?payload=$oversized',
    ];

    for (final url in invalid) {
      expect(
        () => parseChikCheckoutRedirect(_configuration, url),
        throwsA(_invalidArgument()),
      );
    }
  });

  test(
    'mobile host allows pages, opens apps, falls back, and completes',
    () async {
      final host = _ExerciseMobileHost();
      final result = await presentChikMobileCheckout(
        _configuration,
        _preparation(
          orderName: 'Order </script><script>globalThis.pwned=true</script>',
        ),
        host,
        _sessionScope,
        _activeSessionLease(),
      );

      expect(result, isA<ChikCheckoutSuccess>());
      expect((result as ChikCheckoutSuccess).paymentKey, 'payment-key-1');
      expect(host.presentation.returnScheme, 'exampleapp://');
      expect(host.presentation.sessionScope, _sessionScope);
      expect(
        host.presentation.document,
        isNot(
          contains(
            'Order </script><script>globalThis.pwned=true</script>',
          ),
        ),
      );
      expect(host.presentation.document, contains(r'\u003c/script\u003e'));
      expect(host.presentation.document, contains('chikCheckoutState'));
      expect(
        host.resumed,
        <String>['https://payment-widget.tosspayments.com/resume'],
      );
      expect(host.opened, hasLength(2));
      expect(host.opened[0].$1, 'supertoss://payments/open');
      expect(host.opened[0].$2, ['viva.republica.toss']);
      expect(
        host.opened[1].$1,
        'https://play.google.com/store/apps/details?id=viva.republica.toss',
      );
      expect(host.opened[1].$2, isNull);
    },
  );

  test('mobile host rejects forged, duplicate, and oversized URLs', () async {
    final result = await presentChikMobileCheckout(
      _configuration,
      _preparation(),
      _RejectingMobileHost(),
      _sessionScope,
      _activeSessionLease(),
    );
    expect(result, isA<ChikCheckoutSuccess>());
  });

  test('mobile external navigation failure is canonical', () async {
    await expectLater(
      presentChikMobileCheckout(
        _configuration,
        _preparation(),
        _UnavailableExternalHost(),
        _sessionScope,
        _activeSessionLease(),
      ),
      throwsA(
        isA<ChikCheckoutException>()
            .having(
              (error) => error.code,
              'code',
              ChikErrorCode.unavailable,
            )
            .having(
              (error) => error.message,
              'message',
              'The payment application could not be opened.',
            ),
      ),
    );
  });

  test('mobile UI setup failure is canonical and hides host detail', () async {
    await expectLater(
      presentChikMobileCheckout(
        _configuration,
        _preparation(),
        _ThrowingMobileHost(),
        _sessionScope,
        _activeSessionLease(),
      ),
      throwsA(
        isA<ChikCheckoutException>()
            .having((error) => error.code, 'code', ChikErrorCode.unavailable)
            .having((error) => error.status, 'status', 503)
            .having(
              (error) => error.message,
              'message',
              'The checkout UI could not be displayed.',
            )
            .having(
              (error) => error.toString(),
              'string form',
              isNot(contains('raw mobile host detail')),
            )
            .having((error) => error.cause, 'cause', same(_mobileHostCause)),
      ),
    );
  });

  test('mobile checkout requires the current native session scope', () async {
    await expectLater(
      presentChikMobileCheckout(
        _configuration,
        _preparation(),
        _ReturningMobileHost(_successUrl()),
        null,
        null,
      ),
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
  });

  test('mobile checkout binds callbacks to the active preparation', () async {
    final otherCapability = List<String>.filled(43, 'b').join();
    for (final redirectUrl in <String>[
      _successUrl().replaceFirst(_approvalCapability, otherCapability),
      _successUrl().replaceFirst('order-1', 'order-2'),
      _successUrl(amount: '15001'),
      _failureUrl().replaceFirst(_approvalCapability, otherCapability),
      _failureUrl().replaceFirst('order-1', 'order-2'),
    ]) {
      await expectLater(
        presentChikMobileCheckout(
          _configuration,
          _preparation(),
          _ReturningMobileHost(redirectUrl),
          _sessionScope,
          _activeSessionLease(),
        ),
        throwsA(
          isA<ChikCheckoutException>()
              .having(
                  (error) => error.code, 'code', ChikErrorCode.invalidResponse)
              .having((error) => error.status, 'status', 502),
        ),
      );
    }
  });

  test('mobile checkout rejects forged completion before host persistence',
      () async {
    final result = await presentChikMobileCheckout(
      _configuration,
      _preparation(),
      _GateCheckingMobileHost(),
      _sessionScope,
      _activeSessionLease(),
    );
    expect(result, isA<ChikCheckoutSuccess>());
  });

  test('mobile checkout restores and clears the exact pending session',
      () async {
    final host = _RecoveryMobileHost(ChikMobileCheckoutRecovery(
      preparation: _preparation(),
      redirectUrl: _successUrl(),
    ));
    final restored = await restoreChikMobileCheckout(
      _configuration,
      host,
      _sessionScope,
      _activeSessionLease(),
    );
    expect(restored?.preparation.requestId, 'request-1');
    expect(restored?.redirect, isA<ChikCheckoutSuccess>());
    await completeChikMobileCheckout(
      restored!.preparation,
      host,
      _sessionScope,
    );
    expect(host.completed, <String>[_approvalCapability]);
  });

  test('mobile pending recovery clears before reprepare and keeps redirects',
      () async {
    final current = _preparation();
    final next = ChikCheckoutPreparation(
      requestId: 'request-2',
      orderId: 'order-2',
      orderName: current.orderName,
      amount: current.amount,
      currency: current.currency,
      customerKey: current.customerKey,
      approvalCapability: ''.padRight(43, 'b'),
    );
    final host = _RecoveryMobileHost(
      ChikMobileCheckoutRecovery(preparation: current),
    );
    var prepareCalls = 0;
    final recovered = await recoverChikMobileCheckout(
      ChikRestoredMobileCheckout(preparation: current),
      host,
      _sessionScope,
      () async {
        prepareCalls += 1;
        expect(host.recovery, isNull);
        return next;
      },
    );
    expect(recovered.preparation, same(next));
    expect(host.completed, <String>[_approvalCapability]);
    expect(prepareCalls, 1);

    final redirected = ChikRestoredMobileCheckout(
      preparation: current,
      redirect: parseChikCheckoutRedirect(_configuration, _successUrl()),
    );
    expect(
      await recoverChikMobileCheckout(
        redirected,
        host,
        _sessionScope,
        () async {
          prepareCalls += 1;
          return next;
        },
      ),
      same(redirected),
    );
    expect(host.completed, <String>[_approvalCapability]);
    expect(prepareCalls, 1);
  });

  test('mobile credential conflict leaves recovery empty for a new request',
      () async {
    final current = _preparation();
    final host = _RecoveryMobileHost(
      ChikMobileCheckoutRecovery(preparation: current),
    );
    await expectLater(
      recoverChikMobileCheckout(
        ChikRestoredMobileCheckout(preparation: current),
        host,
        _sessionScope,
        () async => throw const ChikCheckoutException(
          ChikErrorCode.aborted,
          'The checkout request conflicts with an existing order.',
          409,
        ),
      ),
      throwsA(isA<ChikCheckoutException>()
          .having((error) => error.code, 'code', ChikErrorCode.aborted)
          .having((error) => error.status, 'status', 409)),
    );
    expect(host.recovery, isNull);
    final next = await recoverChikMobileCheckout(
      null,
      host,
      _sessionScope,
      () async => current,
    );
    expect(next.preparation, same(current));
  });

  test('mobile recovery does not prepare when pending cleanup fails', () async {
    final current = _preparation();
    final host = _RecoveryMobileHost(
      ChikMobileCheckoutRecovery(preparation: current),
      completeError: StateError('secure storage unavailable'),
    );
    var prepareCalls = 0;
    await expectLater(
      recoverChikMobileCheckout(
        ChikRestoredMobileCheckout(preparation: current),
        host,
        _sessionScope,
        () async {
          prepareCalls += 1;
          return current;
        },
      ),
      throwsA(isA<ChikCheckoutException>()
          .having((error) => error.code, 'code', ChikErrorCode.storageError)),
    );
    expect(prepareCalls, 0);
    expect(host.recovery?.preparation, same(current));
  });

  test('mobile recovery rechecks the session after pending cleanup', () async {
    final current = _preparation();
    var active = true;
    var prepareCalls = 0;
    final host = _RecoveryMobileHost(
      ChikMobileCheckoutRecovery(preparation: current),
      afterComplete: () => active = false,
    );
    await expectLater(
      recoverChikMobileCheckout(
        ChikRestoredMobileCheckout(preparation: current),
        host,
        _sessionScope,
        () async {
          if (!active) {
            throw const ChikCheckoutException(
              ChikErrorCode.unauthenticated,
              'The customer session changed during checkout.',
              401,
            );
          }
          prepareCalls += 1;
          return current;
        },
      ),
      throwsA(isA<ChikCheckoutException>().having(
        (error) => error.code,
        'code',
        ChikErrorCode.unauthenticated,
      )),
    );
    expect(prepareCalls, 0);
    expect(host.recovery, isNull);
  });

  test('invalid restored redirects clear only the matching pending checkout',
      () async {
    for (final redirectUrl in <String>[
      'https://attacker.example/complete',
      Uri.parse(_successUrl()).replace(queryParameters: <String, String>{
        ...Uri.parse(_successUrl()).queryParameters,
        'chikCheckoutState': ''.padRight(43, 'b'),
      }).toString(),
    ]) {
      final host = _RecoveryMobileHost(ChikMobileCheckoutRecovery(
        preparation: _preparation(),
        redirectUrl: redirectUrl,
      ));
      await expectLater(
        restoreChikMobileCheckout(
          _configuration,
          host,
          _sessionScope,
          _activeSessionLease(),
        ),
        throwsA(
          isA<ChikCheckoutException>()
              .having(
                  (error) => error.code, 'code', ChikErrorCode.invalidResponse)
              .having((error) => error.status, 'status', 502),
        ),
      );
      expect(host.completed, <String>[_approvalCapability]);
      expect(
        await restoreChikMobileCheckout(
          _configuration,
          host,
          _sessionScope,
          _activeSessionLease(),
        ),
        isNull,
      );
    }
  });

  test('mobile checkout rejects an invalidated native session lease', () async {
    final lease = _activeSessionLease()..invalidate();
    await expectLater(
      presentChikMobileCheckout(
        _configuration,
        _preparation(),
        _ReturningMobileHost(_successUrl()),
        _sessionScope,
        lease,
      ),
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
  });
}

ChikSessionScopeLease _activeSessionLease() =>
    ChikSessionScopeLease(_sessionScope);

mixin _CheckoutRecoveryStub implements ChikMobileCheckoutHost {
  @override
  ChikMobilePlatform get platform => ChikMobilePlatform.ios;

  @override
  Future<ChikMobileCheckoutRecovery?> restoreCheckout(
          String sessionScope) async =>
      null;

  @override
  Future<void> completeCheckout(
      String approvalCapability, String sessionScope) async {}
}

final class _ExerciseMobileHost
    with _CheckoutRecoveryStub
    implements ChikMobileCheckoutHost {
  final List<(String, List<String>?)> opened = <(String, List<String>?)>[];
  final List<String> resumed = <String>[];
  late ChikCheckoutPresentation presentation;
  String? _failOnce;

  @override
  ChikMobilePlatform get platform => ChikMobilePlatform.android;

  @override
  Future<String> present(ChikCheckoutPresentation value) async {
    presentation = value;
    expect(
      value.navigate('https://payment-widget.tosspayments.com/widget').action,
      ChikCheckoutNavigationAction.allow,
    );

    const intent = 'intent://payments/open#Intent;scheme=supertoss;'
        'package=viva.republica.toss;end';
    expect(
      () => value.navigate(
        'intent://payments/open#Intent;scheme=supertoss;end',
      ),
      throwsA(_invalidArgument()),
    );
    final direct = value.navigate('supertoss://payments/open');
    expect(direct.action, ChikCheckoutNavigationAction.external);
    expect(direct.androidPackages, ['viva.republica.toss']);
    expect(
      direct.fallbackUrl,
      'https://play.google.com/store/apps/details?id=viva.republica.toss',
    );
    for (final pair in <(String, String)>[
      ('v3mobileplusweb', 'com.ahnlab.v3mobileplus'),
      ('kakaotalk', 'com.kakao.talk'),
      ('kftc-bankpay', 'com.kftc.bankpay.android'),
      ('naversearchthirdlogin', 'com.nhn.android.search'),
      ('wooripay', 'com.wooricard.wpay'),
    ]) {
      final reviewed = value.navigate(
        'intent://payments/open#Intent;scheme=${pair.$1};'
        'package=${pair.$2};end',
      );
      expect(reviewed.action, ChikCheckoutNavigationAction.external);
      expect(reviewed.androidPackages, [pair.$2]);
    }
    for (final pair in <(String, List<String>)>[
      (
        'samsungpay',
        ['com.samsung.android.spay', 'com.samsung.android.spaylite'],
      ),
      (
        'com.wooricard.wcard',
        ['com.wooricard.wcard', 'com.wooricard.smartapp'],
      ),
      (
        'cloudpay',
        ['com.hanaskcard.paycla', 'com.hanaskcard.rocomo.potal'],
      ),
    ]) {
      final reviewed = value.navigate('${pair.$1}://payments/open');
      expect(reviewed.action, ChikCheckoutNavigationAction.external);
      expect(reviewed.androidPackages, pair.$2);
    }
    _failOnce = 'supertoss://payments/open';
    final intended = value.navigate(intent);
    expect(intended.action, ChikCheckoutNavigationAction.external);
    expect(intended.androidPackages, ['viva.republica.toss']);
    try {
      await openExternal(
        intended.url!,
        androidPackages: intended.androidPackages,
      );
    } catch (_) {
      await openExternal(intended.fallbackUrl!);
    }

    final resumedUrl = 'https://payment-widget.tosspayments.com/resume';
    final resume = value.navigate(_returnUrl(resumedUrl));
    expect(resume.action, ChikCheckoutNavigationAction.resume);
    resumed.add(resume.url!);

    expect(
      value.navigate('${_configuration.appScheme}://').action,
      ChikCheckoutNavigationAction.restore,
    );

    final success = _successUrl();
    final completed = value.navigate(success);
    expect(completed.action, ChikCheckoutNavigationAction.complete);
    expect(completed.redirect, isA<ChikCheckoutSuccess>());
    return success;
  }

  @override
  Future<void> openExternal(String url, {List<String>? androidPackages}) async {
    opened.add((url, androidPackages));
    if (_failOnce == url) {
      _failOnce = null;
      throw StateError('primary app unavailable');
    }
  }
}

final class _RejectingMobileHost
    with _CheckoutRecoveryStub
    implements ChikMobileCheckoutHost {
  @override
  Future<String> present(ChikCheckoutPresentation value) async {
    final duplicate = '${_successUrl()}&paymentKey=forged-key';
    final duplicateCapability =
        '${_successUrl()}&chikCheckoutState=$_approvalCapability';
    final oversized = List<String>.filled(17000, 'x').join();
    final forged = <String>[
      'https://payment-widget.tosspayments.com.attacker.test/widget',
      'https://payment-widget.tosspayments.com:444/widget',
      'evilapp://payments/open',
      'intent://payments/open#Intent;scheme=evilapp;'
          'package=evil.package;end',
      'intent://payments/open#Intent;scheme=supertoss;'
          'package=com.kakao.talk;end',
      'intent://payments/open#Intent;scheme=supertoss;end',
      duplicate,
      duplicateCapability,
      '${_configuration.successUrl}?payload=$oversized',
      'https://attacker@payment-widget.tosspayments.com/widget',
      _returnUrl('http://payment-widget.tosspayments.com/widget'),
      _returnUrl('https://attacker.test/widget'),
    ];
    for (final url in forged) {
      expect(() => value.navigate(url), throwsA(_invalidArgument()));
    }
    expect(
      value.navigate('${_configuration.appScheme}://').action,
      ChikCheckoutNavigationAction.restore,
    );
    return _successUrl();
  }

  @override
  Future<void> openExternal(String url, {List<String>? androidPackages}) async {
    fail('unreviewed external URL was opened: $url');
  }
}

final class _UnavailableExternalHost
    with _CheckoutRecoveryStub
    implements ChikMobileCheckoutHost {
  @override
  Future<String> present(ChikCheckoutPresentation value) async {
    final navigation = value.navigate('supertoss://payments/open');
    try {
      await openExternal(navigation.url!);
    } catch (cause) {
      throw ChikCheckoutException(
        ChikErrorCode.unavailable,
        'The payment application could not be opened.',
        503,
        cause: cause,
      );
    }
    return _successUrl();
  }

  @override
  Future<void> openExternal(String url, {List<String>? androidPackages}) async {
    throw StateError('raw platform navigation detail');
  }
}

final class _ThrowingMobileHost
    with _CheckoutRecoveryStub
    implements ChikMobileCheckoutHost {
  @override
  Future<String> present(ChikCheckoutPresentation presentation) {
    throw _mobileHostCause;
  }

  @override
  Future<void> openExternal(String url,
      {List<String>? androidPackages}) async {}
}

final class _ReturningMobileHost
    with _CheckoutRecoveryStub
    implements ChikMobileCheckoutHost {
  _ReturningMobileHost(this.url);
  final String url;

  @override
  Future<String> present(ChikCheckoutPresentation presentation) async => url;

  @override
  Future<void> openExternal(String url,
      {List<String>? androidPackages}) async {}
}

final class _GateCheckingMobileHost
    with _CheckoutRecoveryStub
    implements ChikMobileCheckoutHost {
  @override
  Future<String> present(ChikCheckoutPresentation presentation) async {
    final forged = _successUrl().replaceFirst(
      _approvalCapability,
      List<String>.filled(43, 'b').join(),
    );
    expect(
      () => presentation.navigate(forged),
      throwsA(
        isA<ChikCheckoutException>()
            .having(
                (error) => error.code, 'code', ChikErrorCode.invalidResponse)
            .having((error) => error.status, 'status', 502),
      ),
    );
    return _successUrl();
  }

  @override
  Future<void> openExternal(String url,
      {List<String>? androidPackages}) async {}
}

final class _RecoveryMobileHost implements ChikMobileCheckoutHost {
  _RecoveryMobileHost(
    this.recovery, {
    this.completeError,
    this.afterComplete,
  });

  ChikMobileCheckoutRecovery? recovery;
  final Object? completeError;
  final void Function()? afterComplete;
  final List<String> completed = <String>[];

  @override
  ChikMobilePlatform get platform => ChikMobilePlatform.ios;

  @override
  Future<ChikMobileCheckoutRecovery?> restoreCheckout(
      String sessionScope) async {
    expect(sessionScope, _sessionScope);
    return recovery;
  }

  @override
  Future<void> completeCheckout(
    String approvalCapability,
    String sessionScope,
  ) async {
    expect(sessionScope, _sessionScope);
    if (completeError != null) throw completeError!;
    completed.add(approvalCapability);
    recovery = null;
    afterComplete?.call();
  }

  @override
  Future<String> present(ChikCheckoutPresentation presentation) {
    throw StateError('a restored redirect must not open a new checkout UI');
  }

  @override
  Future<void> openExternal(String url,
      {List<String>? androidPackages}) async {}
}
