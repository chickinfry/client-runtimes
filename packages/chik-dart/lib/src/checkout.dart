library chik_client_checkout;

import 'dart:convert';

import 'auth.dart';
import 'error-contract.dart';
import 'toss_key_profiles.generated.dart';

const _reviewedCheckoutScript = 'https://js.tosspayments.com/v2/standard';
const _supportedExtension = 'payments/toss';
const _maxSafeInteger = 9007199254740991;
const _checkoutStateParameter = 'chikCheckoutState';

final class ChikCheckoutException implements Exception {
  const ChikCheckoutException(
    this.code,
    this.message,
    this.status, {
    this.cause,
  });
  final ChikErrorCode code;
  final String message;
  final int status;
  final Object? cause;
  @override
  String toString() => 'ChikCheckoutException(${code.wireValue}, $message)';
}

final class ChikCheckoutBridgeConfiguration {
  const ChikCheckoutBridgeConfiguration({
    required this.extension,
    required this.clientKey,
    required this.successUrl,
    required this.failUrl,
    required this.appScheme,
  });

  final String extension;
  final String clientKey;
  final String successUrl;
  final String failUrl;
  final String appScheme;
}

final class ChikCheckoutPreparation {
  const ChikCheckoutPreparation({
    required this.requestId,
    required this.orderId,
    required this.orderName,
    required this.amount,
    required this.currency,
    required this.customerKey,
    required this.approvalCapability,
  });

  final String requestId;
  final String orderId;
  final String orderName;
  final int amount;
  final String currency;
  final String customerKey;
  final String approvalCapability;

  Map<String, Object?> toJson() => {
        'requestId': requestId,
        'orderId': orderId,
        'orderName': orderName,
        'amount': amount,
        'currency': currency,
        'customerKey': customerKey,
        'approvalCapability': approvalCapability,
      };
}

sealed class ChikCheckoutRedirect {
  const ChikCheckoutRedirect();
}

final class ChikCheckoutSuccess extends ChikCheckoutRedirect {
  const ChikCheckoutSuccess(
      {required this.paymentKey,
      required this.orderId,
      required this.amount,
      required this.paymentType,
      required this.approvalCapability});
  final String paymentKey;
  final String orderId;
  final int amount;
  final String paymentType;
  final String approvalCapability;
}

final class ChikCheckoutFailure extends ChikCheckoutRedirect {
  const ChikCheckoutFailure(
      {required this.code, required this.message, this.orderId});
  final String code;
  final String message;
  final String? orderId;
}

final class ChikCheckoutPresentation {
  const ChikCheckoutPresentation(
      {required this.document,
      required this.returnScheme,
      required this.sessionScope,
      required this.sessionScopeLease,
      required this.recovery,
      required this.navigate});
  final String document;
  final String returnScheme;
  final String sessionScope;
  final ChikSessionScopeLease sessionScopeLease;
  final ChikMobileCheckoutRecovery recovery;
  final ChikCheckoutNavigation Function(String url) navigate;
}

final class ChikMobileCheckoutRecovery {
  const ChikMobileCheckoutRecovery({
    required this.preparation,
    this.redirectUrl,
  });
  final ChikCheckoutPreparation preparation;
  final String? redirectUrl;
}

final class ChikRestoredMobileCheckout {
  const ChikRestoredMobileCheckout({
    required this.preparation,
    this.redirect,
  });
  final ChikCheckoutPreparation preparation;
  final ChikCheckoutRedirect? redirect;
}

enum ChikCheckoutNavigationAction { allow, restore, resume, complete, external }

final class ChikCheckoutNavigation {
  const ChikCheckoutNavigation.allow()
      : action = ChikCheckoutNavigationAction.allow,
        url = null,
        fallbackUrl = null,
        androidPackages = null,
        redirect = null;
  const ChikCheckoutNavigation.restore()
      : action = ChikCheckoutNavigationAction.restore,
        url = null,
        fallbackUrl = null,
        androidPackages = null,
        redirect = null;
  const ChikCheckoutNavigation.resume(this.url)
      : action = ChikCheckoutNavigationAction.resume,
        fallbackUrl = null,
        androidPackages = null,
        redirect = null;
  const ChikCheckoutNavigation.complete(this.redirect)
      : action = ChikCheckoutNavigationAction.complete,
        url = null,
        fallbackUrl = null,
        androidPackages = null;
  const ChikCheckoutNavigation.external(
    this.url, {
    this.fallbackUrl,
    this.androidPackages,
  })  : action = ChikCheckoutNavigationAction.external,
        redirect = null;

  final ChikCheckoutNavigationAction action;
  final String? url;
  final String? fallbackUrl;
  final List<String>? androidPackages;
  final ChikCheckoutRedirect? redirect;
}

abstract interface class ChikMobileCheckoutHost {
  ChikMobilePlatform get platform;
  Future<String> present(ChikCheckoutPresentation presentation);
  Future<ChikMobileCheckoutRecovery?> restoreCheckout(String sessionScope);
  Future<void> completeCheckout(String approvalCapability, String sessionScope);
  Future<void> openExternal(String url, {List<String>? androidPackages});
}

enum ChikMobilePlatform { android, ios }

Future<ChikRestoredMobileCheckout?> restoreChikMobileCheckout(
  ChikCheckoutBridgeConfiguration configuration,
  ChikMobileCheckoutHost host,
  String? sessionScope,
  ChikSessionScopeLease? sessionScopeLease,
) async {
  final scope = _requireSessionScope(sessionScope);
  final lease = _requireSessionScopeLease(scope, sessionScopeLease);
  final config = _configuration(configuration);
  late final ChikMobileCheckoutRecovery? recovery;
  try {
    recovery = await host.restoreCheckout(scope);
  } on ChikCheckoutException {
    rethrow;
  } catch (cause) {
    throw ChikCheckoutException(
      ChikErrorCode.storageError,
      'The pending checkout could not be restored.',
      0,
      cause: cause,
    );
  }
  _requireSessionScopeLease(scope, lease);
  if (recovery == null) return null;
  var preparationValidated = false;
  try {
    final preparation = _preparation(recovery.preparation);
    preparationValidated = true;
    return ChikRestoredMobileCheckout(
      preparation: preparation,
      redirect: recovery.redirectUrl == null
          ? null
          : _parseCheckoutResponse(
              config,
              preparation,
              recovery.redirectUrl!,
            ),
    );
  } on ChikCheckoutException catch (cause) {
    if (preparationValidated && cause.code == ChikErrorCode.invalidResponse) {
      try {
        await host.completeCheckout(
          recovery.preparation.approvalCapability,
          scope,
        );
      } catch (cleanupCause) {
        throw ChikCheckoutException(
          ChikErrorCode.invalidResponse,
          'The pending checkout record is invalid and could not be cleared.',
          502,
          cause: <Object>[cause, cleanupCause],
        );
      }
      rethrow;
    }
    throw ChikCheckoutException(
      ChikErrorCode.invalidResponse,
      'The pending checkout record is invalid.',
      502,
      cause: cause,
    );
  }
}

Future<void> completeChikMobileCheckout(
  ChikCheckoutPreparation preparation,
  ChikMobileCheckoutHost host,
  String? sessionScope,
) async {
  try {
    await host.completeCheckout(
      preparation.approvalCapability,
      _requireSessionScope(sessionScope),
    );
  } on ChikCheckoutException {
    rethrow;
  } catch (cause) {
    throw ChikCheckoutException(
      ChikErrorCode.storageError,
      'The pending checkout could not be cleared.',
      0,
      cause: cause,
    );
  }
}

Future<ChikRestoredMobileCheckout> recoverChikMobileCheckout(
  ChikRestoredMobileCheckout? restored,
  ChikMobileCheckoutHost host,
  String? sessionScope,
  Future<ChikCheckoutPreparation> Function() prepare,
) async {
  _requireSessionScope(sessionScope);
  if (restored?.redirect != null) return restored!;
  if (restored != null) {
    await completeChikMobileCheckout(restored.preparation, host, sessionScope);
  }
  return ChikRestoredMobileCheckout(preparation: await prepare());
}

String createChikMobileCheckoutDocument(
  ChikCheckoutBridgeConfiguration configuration,
  ChikCheckoutPreparation preparation,
) {
  return _document(
    _configuration(configuration),
    _preparation(preparation),
  );
}

Future<ChikCheckoutRedirect> presentChikMobileCheckout(
  ChikCheckoutBridgeConfiguration configuration,
  ChikCheckoutPreparation preparation,
  ChikMobileCheckoutHost host,
  String? sessionScope,
  ChikSessionScopeLease? sessionScopeLease,
) async {
  final config = _configuration(configuration);
  final value = _preparation(preparation);
  final document = _document(config, value);
  final scope = _requireSessionScope(sessionScope);
  final lease = _requireSessionScopeLease(scope, sessionScopeLease);
  late final String redirectUrl;
  try {
    redirectUrl = await host.present(ChikCheckoutPresentation(
      document: document,
      returnScheme: '${config.appScheme}://',
      sessionScope: scope,
      sessionScopeLease: lease,
      recovery: ChikMobileCheckoutRecovery(preparation: value),
      navigate: (url) {
        final decision = _navigation(config, url, host.platform);
        if (decision.action == ChikCheckoutNavigationAction.complete) {
          _parseCheckoutResponse(config, value, url);
        }
        return decision;
      },
    ));
  } on ChikCheckoutException {
    rethrow;
  } catch (cause) {
    throw ChikCheckoutException(
      ChikErrorCode.unavailable,
      'The checkout UI could not be displayed.',
      503,
      cause: cause,
    );
  }
  _requireSessionScopeLease(scope, lease);
  try {
    return _parseCheckoutResponse(config, value, redirectUrl);
  } on ChikCheckoutException catch (cause) {
    if (cause.code == ChikErrorCode.invalidResponse && cause.status == 502) {
      rethrow;
    }
    throw ChikCheckoutException(
      ChikErrorCode.invalidResponse,
      'The checkout host response is invalid.',
      502,
      cause: cause,
    );
  }
}

ChikSessionScopeLease _requireSessionScopeLease(
  String sessionScope,
  ChikSessionScopeLease? lease,
) {
  if (lease == null || !lease.isActive || lease.sessionScope != sessionScope) {
    throw const ChikCheckoutException(
      ChikErrorCode.unauthenticated,
      'The customer session changed during checkout.',
      401,
    );
  }
  return lease;
}

ChikCheckoutRedirect _parseCheckoutResponse(
  ChikCheckoutBridgeConfiguration configuration,
  ChikCheckoutPreparation preparation,
  String redirectUrl,
) {
  ChikCheckoutRedirect? redirect;
  Object? cause;
  try {
    redirect = parseChikCheckoutRedirect(configuration, redirectUrl);
  } catch (error) {
    cause = error;
  }
  if (redirect == null) {
    throw _checkoutHostResponseMismatch(cause: cause);
  }
  final callback = Uri.parse(redirectUrl);
  final capabilities = callback.queryParametersAll[_checkoutStateParameter];
  final matchesCapability = capabilities != null &&
      capabilities.length == 1 &&
      capabilities.single == preparation.approvalCapability;
  final matchesResult = switch (redirect) {
    ChikCheckoutSuccess(:final orderId, :final amount) =>
      orderId == preparation.orderId && amount == preparation.amount,
    ChikCheckoutFailure(:final orderId) =>
      orderId == null || orderId == preparation.orderId,
  };
  if (!matchesCapability || !matchesResult) {
    throw _checkoutHostResponseMismatch();
  }
  return redirect;
}

ChikCheckoutException _checkoutHostResponseMismatch({Object? cause}) =>
    ChikCheckoutException(
      ChikErrorCode.invalidResponse,
      'The checkout host response does not match the active checkout.',
      502,
      cause: cause,
    );

ChikCheckoutRedirect parseChikCheckoutRedirect(
    ChikCheckoutBridgeConfiguration configuration, String value) {
  if (value.isEmpty || value.length > 16 * 1024) {
    throw const ChikCheckoutException(ChikErrorCode.invalidArgument,
        'The checkout redirect URL is invalid.', 400);
  }
  final config = _configuration(configuration);
  final url = Uri.tryParse(value);
  if (url == null || url.userInfo.isNotEmpty || url.fragment.isNotEmpty)
    throw const ChikCheckoutException(ChikErrorCode.invalidArgument,
        'The checkout redirect URL is invalid.', 400);
  if (_sameRedirect(url, Uri.parse(config.successUrl))) {
    final paymentKey = _singleQueryParameter(url, 'paymentKey');
    final orderId = _singleQueryParameter(url, 'orderId');
    final amountText = _singleQueryParameter(url, 'amount');
    final paymentType = _optionalSingleQueryParameter(url, 'paymentType');
    final paymentTypeInRedirect =
        tossClientKeyProfile(config.clientKey)!.paymentTypeInRedirect;
    final amount = amountText != null && _decimalInteger.hasMatch(amountText)
        ? int.tryParse(amountText)
        : null;
    final approvalCapability =
        _singleQueryParameter(url, _checkoutStateParameter);
    if (paymentKey == null ||
        paymentKey.isEmpty ||
        utf8.encode(paymentKey).length > 200 ||
        orderId == null ||
        !_orderId.hasMatch(orderId) ||
        amount == null ||
        amount <= 0 ||
        amount > _maxSafeInteger ||
        (paymentTypeInRedirect
            ? paymentType != 'NORMAL'
            : paymentType != null) ||
        approvalCapability == null ||
        !_approvalCapability.hasMatch(approvalCapability)) {
      throw const ChikCheckoutException(ChikErrorCode.invalidArgument,
          'The successful checkout redirect is invalid.', 400);
    }
    return ChikCheckoutSuccess(
        paymentKey: paymentKey,
        orderId: orderId,
        amount: amount,
        paymentType: 'NORMAL',
        approvalCapability: approvalCapability);
  }
  if (_sameRedirect(url, Uri.parse(config.failUrl))) {
    final code = _singleQueryParameter(url, 'code');
    final message = _singleQueryParameter(url, 'message');
    final orderId = _optionalSingleQueryParameter(url, 'orderId');
    final approvalCapability =
        _singleQueryParameter(url, _checkoutStateParameter);
    if (code == null ||
        code.isEmpty ||
        code.length > 512 ||
        message == null ||
        message.isEmpty ||
        message.length > 2048 ||
        (orderId != null && !_orderId.hasMatch(orderId)) ||
        approvalCapability == null ||
        !_approvalCapability.hasMatch(approvalCapability)) {
      throw const ChikCheckoutException(ChikErrorCode.invalidArgument,
          'The failed checkout redirect is invalid.', 400);
    }
    final failure = _checkoutFailure(code);
    return ChikCheckoutFailure(
      code: failure.$1,
      message: failure.$2,
      orderId: orderId,
    );
  }
  throw const ChikCheckoutException(ChikErrorCode.invalidArgument,
      'The checkout redirect URL is invalid.', 400);
}

ChikCheckoutBridgeConfiguration _configuration(
    ChikCheckoutBridgeConfiguration value) {
  if (value.extension != _supportedExtension ||
      value.clientKey.length > 512 ||
      tossClientKeyProfile(value.clientKey) == null ||
      !_scheme.hasMatch(value.appScheme) ||
      _reservedMobileSchemes.contains(value.appScheme)) {
    throw const ChikCheckoutException(ChikErrorCode.invalidArgument,
        'The checkout bridge configuration is invalid.', 400);
  }
  final callbacks = <Uri>[];
  for (final entry in [
    (
      value.successUrl,
      const [
        'paymentKey',
        'orderId',
        'amount',
        'paymentType',
        _checkoutStateParameter,
      ]
    ),
    (
      value.failUrl,
      const ['code', 'message', 'orderId', _checkoutStateParameter]
    ),
  ]) {
    final source = entry.$1;
    if (source.length > 2048) {
      throw const ChikCheckoutException(ChikErrorCode.invalidArgument,
          'The checkout bridge configuration is invalid.', 400);
    }
    final url = Uri.tryParse(source);
    if (url == null ||
        url.scheme != 'https' ||
        url.host.isEmpty ||
        url.userInfo.isNotEmpty ||
        url.fragment.isNotEmpty) {
      throw const ChikCheckoutException(ChikErrorCode.invalidArgument,
          'The checkout bridge configuration is invalid.', 400);
    }
    if (entry.$2.any(url.queryParametersAll.containsKey)) {
      throw const ChikCheckoutException(ChikErrorCode.invalidArgument,
          'The checkout bridge configuration is invalid.', 400);
    }
    callbacks.add(url);
  }
  if (_sameRedirect(callbacks[0], callbacks[1]) ||
      _sameRedirect(callbacks[1], callbacks[0])) {
    throw const ChikCheckoutException(
      ChikErrorCode.invalidArgument,
      'The checkout bridge callback URLs overlap.',
      400,
    );
  }
  return value;
}

ChikCheckoutPreparation _preparation(ChikCheckoutPreparation value) {
  if (value.requestId.trim().isEmpty ||
      value.requestId.trim() != value.requestId ||
      utf8.encode(value.requestId).length > 512 ||
      !_orderId.hasMatch(value.orderId) ||
      value.orderName.trim().isEmpty ||
      value.orderName.trim() != value.orderName ||
      value.orderName.runes.length > 100 ||
      value.amount <= 0 ||
      value.amount > _maxSafeInteger ||
      value.currency != 'KRW' ||
      (value.customerKey != 'ANONYMOUS' &&
          !_customerKey.hasMatch(value.customerKey)) ||
      !_approvalCapability.hasMatch(value.approvalCapability)) {
    throw const ChikCheckoutException(ChikErrorCode.invalidArgument,
        'The checkout preparation is invalid.', 400);
  }
  return value;
}

String _requireSessionScope(String? value) {
  if (value == null || !_sessionScope.hasMatch(value)) {
    throw const ChikCheckoutException(
      ChikErrorCode.unauthenticated,
      'Checkout requires an authenticated customer session.',
      401,
    );
  }
  return value;
}

String _document(
    ChikCheckoutBridgeConfiguration config, ChikCheckoutPreparation value) {
  final callbacks = _checkoutCallbacks(config, value.approvalCapability);
  final checkout = tossClientKeyProfile(config.clientKey)!.profile ==
          TossCheckoutProfile.widgets
      ? 'const widgets=payments.widgets({customerKey:input.value.customerKey});await widgets.setAmount({value:input.value.amount,currency:input.value.currency});const window=await widgets.renderPaymentWindow();window.on("paymentRequest",async()=>{try{await widgets.requestPayment({orderId:input.value.orderId,orderName:input.value.orderName,successUrl:input.config.successUrl,failUrl:input.config.failUrl,card:{appScheme:input.config.appScheme+"://"}})}catch{fail("CHECKOUT_REQUEST_FAILED","The checkout request failed.")}});window.on("cancel",()=>fail("CHECKOUT_CANCELED","Checkout was canceled."))'
      : 'const payment=payments.payment({customerKey:input.value.customerKey});try{await payment.requestPayment({method:"CARD",amount:{value:input.value.amount,currency:input.value.currency},orderId:input.value.orderId,orderName:input.value.orderName,successUrl:input.config.successUrl,failUrl:input.config.failUrl,windowTarget:"self",card:{useEscrow:false,flowMode:"DEFAULT",useCardPoint:false,useAppCardOnly:false,appScheme:input.config.appScheme+"://"}})}catch{fail("CHECKOUT_REQUEST_FAILED","The checkout request failed.")}';
  final encoded = jsonEncode({
    'config': {
      'clientKey': config.clientKey,
      ...callbacks,
      'appScheme': config.appScheme,
    },
    'value': {
      'requestId': value.requestId,
      'orderId': value.orderId,
      'orderName': value.orderName,
      'amount': value.amount,
      'currency': value.currency,
      'customerKey': value.customerKey,
    },
  })
      .replaceAll('<', r'\u003c')
      .replaceAll('>', r'\u003e')
      .replaceAll('&', r'\u0026');
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script src="$_reviewedCheckoutScript"></script></head><body><main id="checkout"></main><script>const input=$encoded;const fail=(code,message)=>{const redirect=new URL(input.config.failUrl);redirect.searchParams.set("code",code);redirect.searchParams.set("message",message);redirect.searchParams.set("orderId",input.value.orderId);location.replace(redirect.href)};(async()=>{try{const payments=TossPayments(input.config.clientKey);$checkout}catch{fail("CHECKOUT_UI_UNAVAILABLE","The checkout UI could not be loaded.")}})();</script></body></html>';
}

ChikCheckoutNavigation _navigation(ChikCheckoutBridgeConfiguration config,
    String value, ChikMobilePlatform platform) {
  if (value.isEmpty || value.length > 16 * 1024) {
    throw const ChikCheckoutException(ChikErrorCode.invalidArgument,
        'The checkout navigation URL is invalid.', 400);
  }
  final redirect = Uri.tryParse(value);
  if (redirect != null &&
      (_sameRedirect(redirect, Uri.parse(config.successUrl)) ||
          _sameRedirect(redirect, Uri.parse(config.failUrl)))) {
    return ChikCheckoutNavigation.complete(
      parseChikCheckoutRedirect(config, value),
    );
  }
  if (value.startsWith('intent:')) {
    if (platform != ChikMobilePlatform.android) {
      throw const ChikCheckoutException(
        ChikErrorCode.invalidArgument,
        'The checkout navigation URL is invalid.',
        400,
      );
    }
    final parsed = _intent(value);
    if (parsed == null)
      throw const ChikCheckoutException(ChikErrorCode.invalidArgument,
          'The checkout navigation URL is invalid.', 400);
    return ChikCheckoutNavigation.external(
      parsed.$1,
      fallbackUrl: parsed.$2,
      androidPackages: List<String>.unmodifiable([parsed.$3]),
    );
  }
  final url = Uri.tryParse(value);
  if (url == null || !url.hasScheme) {
    throw const ChikCheckoutException(ChikErrorCode.invalidArgument,
        'The checkout navigation URL is invalid.', 400);
  }
  if (_safeCheckoutPageNavigation(url)) {
    return const ChikCheckoutNavigation.allow();
  }
  if (url.scheme == config.appScheme) {
    if (!value.startsWith('${config.appScheme}://')) {
      throw const ChikCheckoutException(
        ChikErrorCode.invalidArgument,
        'The checkout return URL is invalid.',
        400,
      );
    }
    return _checkoutReturnNavigation(config, url);
  }
  if (!_reviewedCheckoutSchemes.contains(url.scheme)) {
    throw const ChikCheckoutException(ChikErrorCode.invalidArgument,
        'The checkout navigation URL is invalid.', 400);
  }
  if (platform == ChikMobilePlatform.android) {
    final packages = _reviewedAndroidCheckoutPackages[url.scheme];
    if (packages == null || packages.isEmpty) {
      throw const ChikCheckoutException(
        ChikErrorCode.invalidArgument,
        'The Android checkout application link is not bound to a reviewed package.',
        400,
      );
    }
    final androidPackages = List<String>.unmodifiable(packages);
    final androidPackage = androidPackages.first;
    return ChikCheckoutNavigation.external(
      value,
      fallbackUrl: 'https://play.google.com/store/apps/details?'
          'id=${Uri.encodeComponent(androidPackage)}',
      androidPackages: androidPackages,
    );
  }
  final fallback = _reviewedIOSCheckoutFallbacks[url.scheme];
  if (fallback == null) {
    throw const ChikCheckoutException(
      ChikErrorCode.invalidArgument,
      'The checkout application does not have a reviewed store fallback.',
      400,
    );
  }
  return ChikCheckoutNavigation.external(value, fallbackUrl: fallback);
}

ChikCheckoutNavigation _checkoutReturnNavigation(
  ChikCheckoutBridgeConfiguration config,
  Uri wrapper,
) {
  final rootPath = wrapper.path.isEmpty || wrapper.path == '/';
  final nestedValues = wrapper.queryParametersAll['url'];
  if (nestedValues == null || nestedValues.isEmpty) {
    if (wrapper.userInfo.isEmpty &&
        wrapper.host.isEmpty &&
        rootPath &&
        wrapper.fragment.isEmpty &&
        wrapper.queryParametersAll.isEmpty) {
      return const ChikCheckoutNavigation.restore();
    }
    throw const ChikCheckoutException(
      ChikErrorCode.invalidArgument,
      'The checkout return URL is invalid.',
      400,
    );
  }
  if (wrapper.userInfo.isNotEmpty ||
      wrapper.host.isNotEmpty ||
      !rootPath ||
      wrapper.fragment.isNotEmpty ||
      nestedValues.length != 1 ||
      wrapper.queryParametersAll.keys.any((name) => name != 'url')) {
    throw const ChikCheckoutException(
      ChikErrorCode.invalidArgument,
      'The checkout return URL is invalid.',
      400,
    );
  }
  final nestedValue = nestedValues.single;
  final nested = Uri.tryParse(nestedValue);
  if (nestedValue.isEmpty ||
      nestedValue.length > 16 * 1024 ||
      nested == null ||
      nested.scheme != 'https' ||
      nested.host.isEmpty ||
      nested.userInfo.isNotEmpty ||
      nested.fragment.isNotEmpty) {
    throw const ChikCheckoutException(
      ChikErrorCode.invalidArgument,
      'The checkout return URL is invalid.',
      400,
    );
  }
  final isRedirect = _sameRedirect(nested, Uri.parse(config.successUrl)) ||
      _sameRedirect(nested, Uri.parse(config.failUrl));
  if (isRedirect) {
    parseChikCheckoutRedirect(config, nested.toString());
  } else if (!_reviewedAppReturnHttpsNavigation(nested)) {
    throw const ChikCheckoutException(
      ChikErrorCode.invalidArgument,
      'The checkout return URL is invalid.',
      400,
    );
  }
  return ChikCheckoutNavigation.resume(nested.toString());
}

(String, String, String)? _intent(String value) {
  const marker = '#Intent;';
  final index = value.indexOf(marker);
  if (index < 0 || !value.endsWith(';end')) return null;
  final fields = <String, String>{};
  for (final field
      in value.substring(index + marker.length, value.length - 4).split(';')) {
    final equal = field.indexOf('=');
    if (equal > 0) {
      final name = field.substring(0, equal);
      if ((name == 'scheme' ||
              name == 'package' ||
              name == 'S.browser_fallback_url') &&
          fields.containsKey(name)) return null;
      fields[name] = field.substring(equal + 1);
    }
  }
  final scheme = fields['scheme'];
  if (scheme == null || !_reviewedCheckoutSchemes.contains(scheme)) return null;
  final packageName = fields['package'];
  if (packageName == null ||
      _reviewedAndroidCheckoutPackages[scheme]?.contains(packageName) != true) {
    return null;
  }
  final base = value.substring(0, index);
  final target = base.startsWith('intent://')
      ? '$scheme://${base.substring(9)}'
      : base.replaceFirst('intent:', '$scheme:');
  final defaultFallback = 'https://play.google.com/store/apps/details?'
      'id=${Uri.encodeComponent(packageName)}';
  final encodedFallback = fields['S.browser_fallback_url'];
  if (encodedFallback == null) {
    return (target, defaultFallback, packageName);
  }
  final String decodedFallback;
  try {
    decodedFallback = Uri.decodeComponent(encodedFallback);
  } catch (_) {
    return null;
  }
  if (!_reviewedFallback(decodedFallback, packageName)) return null;
  final fallback = Uri.parse(decodedFallback).scheme == 'market'
      ? defaultFallback
      : decodedFallback;
  return (target, fallback, packageName);
}

Map<String, String> _checkoutCallbacks(
    ChikCheckoutBridgeConfiguration config, String approvalCapability) {
  if (!_approvalCapability.hasMatch(approvalCapability)) {
    throw const ChikCheckoutException(ChikErrorCode.invalidArgument,
        'The checkout approval capability is invalid.', 400);
  }
  return {
    'successUrl': _checkoutCallback(config.successUrl, approvalCapability),
    'failUrl': _checkoutCallback(config.failUrl, approvalCapability),
  };
}

String _checkoutCallback(String value, String approvalCapability) {
  final url = Uri.parse(value);
  final query = <String, List<String>>{
    for (final entry in url.queryParametersAll.entries)
      entry.key: List<String>.of(entry.value),
    _checkoutStateParameter: [approvalCapability],
  };
  return url.replace(queryParameters: query).toString();
}

(String, String) _checkoutFailure(String code) {
  if (code == 'CHECKOUT_CANCELED' ||
      code == 'PAY_PROCESS_CANCELED' ||
      code == 'canceled') {
    return ('canceled', 'Checkout was canceled.');
  }
  if (code == 'CHECKOUT_UI_UNAVAILABLE' || code == 'ui_unavailable') {
    return ('ui_unavailable', 'The checkout UI could not be loaded.');
  }
  return ('payment_failed', 'Checkout could not be completed.');
}

bool _safeCheckoutPageNavigation(Uri url) =>
    url.scheme == 'https' &&
    url.host.isNotEmpty &&
    url.userInfo.isEmpty &&
    url.port == 443;

bool _reviewedAppReturnHttpsNavigation(Uri url) =>
    _safeCheckoutPageNavigation(url) &&
    url.fragment.isEmpty &&
    tossReviewedAppReturnHttpsHosts.contains(url.host);

bool _reviewedFallback(String value, String packageName) {
  final url = Uri.tryParse(value);
  if (url == null ||
      url.userInfo.isNotEmpty ||
      url.fragment.isNotEmpty ||
      _singleQueryParameter(url, 'id') != packageName ||
      url.queryParametersAll.keys.any((name) => name != 'id')) return false;
  if (url.scheme == 'market') {
    return url.host == 'details' && (url.path.isEmpty || url.path == '/');
  }
  return url.scheme == 'https' &&
      url.host == 'play.google.com' &&
      url.path == '/store/apps/details';
}

bool _sameRedirect(Uri actual, Uri expected) {
  if (actual.scheme != expected.scheme ||
      actual.host != expected.host ||
      actual.port != expected.port ||
      actual.path != expected.path) return false;
  for (final entry in expected.queryParametersAll.entries) {
    final received = actual.queryParametersAll[entry.key];
    if (received == null || received.length != entry.value.length) return false;
    for (var index = 0; index < entry.value.length; index += 1) {
      if (entry.value[index] != received[index]) return false;
    }
  }
  return true;
}

String? _singleQueryParameter(Uri value, String name) {
  final values = value.queryParametersAll[name];
  return values != null && values.length == 1 ? values.single : null;
}

String? _optionalSingleQueryParameter(Uri value, String name) {
  final values = value.queryParametersAll[name];
  if (values == null || values.isEmpty) return null;
  if (values.length != 1) {
    throw const ChikCheckoutException(ChikErrorCode.invalidArgument,
        'The checkout redirect URL is invalid.', 400);
  }
  return values.single;
}

final _scheme = RegExp(r'^[a-z][a-z0-9+.-]{1,62}$');
final _approvalCapability = RegExp(r'^[A-Za-z0-9_-]{43}$');
final _sessionScope = RegExp(r'^[a-f0-9]{64}$');
final _decimalInteger = RegExp(r'^[0-9]+$');
const _reviewedCheckoutSchemes = {
  'supertoss',
  'kb-acp',
  'liivbank',
  'newliiv',
  'kbbank',
  'nhappcardansimclick',
  'nhallonepayansimclick',
  'nonghyupcardansimclick',
  'lottesmartpay',
  'lotteappcard',
  'mpocket.online.ansimclick',
  'mpocket.ansimclick.cert',
  'vguardstart',
  'samsungpay',
  'monimopay',
  'monimopayauth',
  'shinhan-sr-ansimclick',
  'smshinhanansimclick',
  'com.wooricard.wcard',
  'newsmartpib',
  'citispay',
  'citicardappkr',
  'citimobileapp',
  'cloudpay',
  'hanawalletmembers',
  'hdcardappcardansimclick',
  'smhyundaiansimclick',
  'shinsegaeeasypayment',
  'payco',
  'lpayapp',
  'ispmobile',
  'kakaobank',
  'lmslpay',
  'wooripay',
  'naversearchthirdlogin',
  'kakaotalk',
  'kftc-bankpay',
  'v3mobileplusweb',
  'mvaccinestart',
};
const _reservedMobileSchemes = {
  ..._reviewedCheckoutSchemes,
  'about',
  'blob',
  'data',
  'file',
  'http',
  'https',
  'intent',
  'javascript',
  'market',
  'ws',
  'wss',
};
const _reviewedAndroidCheckoutPackages = <String, List<String>>{
  'supertoss': ['viva.republica.toss'],
  'kb-acp': ['com.kbcard.cxh.appcard'],
  'liivbank': ['com.kbstar.liivbank'],
  'newliiv': ['com.kbstar.reboot'],
  'kbbank': ['com.kbstar.kbbank'],
  'nhappcardansimclick': ['nh.smart.nhallonepay'],
  'nhallonepayansimclick': ['nh.smart.nhallonepay'],
  'nonghyupcardansimclick': ['nh.smart.nhallonepay'],
  'lottesmartpay': ['com.lcacApp'],
  'lotteappcard': ['com.lcacApp'],
  'mpocket.online.ansimclick': ['kr.co.samsungcard.mpocket'],
  'mpocket.ansimclick.cert': ['kr.co.samsungcard.mpocket'],
  'vguardstart': ['kr.co.shiftworks.vguardweb'],
  'samsungpay': ['com.samsung.android.spay', 'com.samsung.android.spaylite'],
  'monimopay': ['net.ib.android.smcard'],
  'monimopayauth': ['net.ib.android.smcard'],
  'shinhan-sr-ansimclick': ['com.shcard.smartpay'],
  'smshinhanansimclick': ['com.shinhancard.smartshinhan'],
  'com.wooricard.wcard': [
    'com.wooricard.wcard',
    'com.wooricard.smartapp',
  ],
  'newsmartpib': ['com.wooribank.smart.npib'],
  'citispay': ['kr.co.citibank.citimobile'],
  'citicardappkr': ['kr.co.citibank.citimobile'],
  'citimobileapp': ['kr.co.citibank.citimobile'],
  'cloudpay': ['com.hanaskcard.paycla', 'com.hanaskcard.rocomo.potal'],
  'hanawalletmembers': ['kr.co.hanamembers.hmscustomer'],
  'hdcardappcardansimclick': ['com.hyundaicard.appcard'],
  'smhyundaiansimclick': ['com.lumensoft.touchenappfree'],
  'shinsegaeeasypayment': ['com.ssg.serviceapp.android.egiftcertificate'],
  'payco': ['com.nhnent.payapp'],
  'lpayapp': ['com.lottemembers.android'],
  'ispmobile': ['kvp.jjy.MispAndroid320'],
  'kakaobank': ['com.kakaobank.channel'],
  'kakaotalk': ['com.kakao.talk'],
  'kftc-bankpay': ['com.kftc.bankpay.android'],
  'naversearchthirdlogin': ['com.nhn.android.search'],
  'v3mobileplusweb': ['com.ahnlab.v3mobileplus'],
  'mvaccinestart': ['com.TouchEn.mVaccine.webs'],
  'wooripay': ['com.wooricard.wpay'],
};
const _reviewedIOSCheckoutFallbacks = <String, String>{
  'supertoss': 'https://apps.apple.com/app/id839333328',
  'ispmobile': 'https://apps.apple.com/app/id369125087',
  'kb-acp': 'https://apps.apple.com/app/id695436326',
  'newliiv': 'https://apps.apple.com/app/id1573528126',
  'kbbank': 'https://apps.apple.com/app/id373742138',
  'mpocket.online.ansimclick': 'https://apps.apple.com/app/id535125356',
  'lottesmartpay': 'https://apps.apple.com/app/id668497947',
  'lotteappcard': 'https://apps.apple.com/app/id688047200',
  'lpayapp': 'https://apps.apple.com/app/id1036098908',
  'cloudpay': 'https://apps.apple.com/app/id847268987',
  'hanawalletmembers': 'https://apps.apple.com/app/id1038288833',
  'hdcardappcardansimclick': 'https://apps.apple.com/app/id702653088',
  'shinhan-sr-ansimclick': 'https://apps.apple.com/app/id572462317',
  'com.wooricard.wcard': 'https://apps.apple.com/app/id1499598869',
  'newsmartpib': 'https://apps.apple.com/app/id1470181651',
  'nhallonepayansimclick': 'https://apps.apple.com/app/id1177889176',
  'citimobileapp': 'https://apps.apple.com/app/id1179759666',
  'shinsegaeeasypayment': 'https://apps.apple.com/app/id666237916',
  'payco': 'https://apps.apple.com/app/id924292102',
  'lmslpay': 'https://apps.apple.com/app/id473250588',
  'wooripay': 'https://apps.apple.com/app/id1201113419',
  'naversearchthirdlogin': 'https://apps.apple.com/app/id393499958',
  'kakaotalk': 'https://apps.apple.com/app/id362057947',
  'kftc-bankpay': 'https://apps.apple.com/app/id398456030',
};
final _orderId = RegExp(r'^[A-Za-z0-9_-]{6,64}$');
final _customerKey = RegExp(r'^(?=.{2,50}$)(?=.*[-_=.@])[A-Za-z0-9_=.@-]+$');
