import 'dart:async';
import 'dart:convert';

import 'package:app_links/app_links.dart';
import 'package:chik_client/chik_client.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

typedef ChikFlutterExternalUrlLauncher = Future<bool> Function(Uri url);

/// Opens ACTION_VIEW against [packageNames] in order, one explicitly bound
/// Android package at a time.
typedef ChikFlutterAndroidPackagesLauncher =
    Future<bool> Function(Uri url, List<String> packageNames);

const _defaultCheckoutRecoveryKey = 'chik.checkout';
const _checkoutRecoveryLifetime = Duration(minutes: 40);
const _checkoutRecoveryRecordVersion = 1;
const _androidCheckoutChannel = MethodChannel('dev.chik.checkout/android');

/// Default mobile checkout host that presents a checkout document in Flutter.
///
/// Attach [navigatorKey] to `MaterialApp.navigatorKey`. This host subscribes to
/// initial and warm application links itself; the generated client owns only
/// payment-specific URL decisions.
final class ChikFlutterMobileCheckoutHost implements ChikMobileCheckoutHost {
  ChikFlutterMobileCheckoutHost({
    GlobalKey<NavigatorState>? navigatorKey,
    Duration timeout = const Duration(minutes: 10),
    ChikFlutterExternalUrlLauncher? externalLauncher,
    ChikFlutterAndroidPackagesLauncher? androidPackagesLauncher,
    FlutterSecureStorage? recoveryStorage,
  }) : this._(
         navigatorKey: navigatorKey,
         timeout: timeout,
         externalLauncher: externalLauncher,
         androidPackagesLauncher: androidPackagesLauncher,
         incomingLinks: AppLinks().uriLinkStream,
         recoveryStorage: recoveryStorage,
       );

  @visibleForTesting
  ChikFlutterMobileCheckoutHost.withIncomingLinks({
    required Stream<Uri> incomingLinks,
    GlobalKey<NavigatorState>? navigatorKey,
    Duration timeout = const Duration(minutes: 10),
    ChikFlutterExternalUrlLauncher? externalLauncher,
    ChikFlutterAndroidPackagesLauncher? androidPackagesLauncher,
    FlutterSecureStorage? recoveryStorage,
  }) : this._(
         navigatorKey: navigatorKey,
         timeout: timeout,
         externalLauncher: externalLauncher,
         androidPackagesLauncher: androidPackagesLauncher,
         incomingLinks: incomingLinks,
         recoveryStorage: recoveryStorage,
       );

  ChikFlutterMobileCheckoutHost._({
    required GlobalKey<NavigatorState>? navigatorKey,
    required Duration timeout,
    required ChikFlutterExternalUrlLauncher? externalLauncher,
    required ChikFlutterAndroidPackagesLauncher? androidPackagesLauncher,
    required Stream<Uri> incomingLinks,
    required FlutterSecureStorage? recoveryStorage,
  }) : navigatorKey = navigatorKey ?? GlobalKey<NavigatorState>(),
       timeout = _validTimeout(timeout),
       _externalLauncher = externalLauncher ?? _launchExternalUrl,
       _androidPackagesLauncher =
           androidPackagesLauncher ?? _launchAndroidPackages,
       _recoveryStorage = recoveryStorage ?? const FlutterSecureStorage() {
    _linkSubscription = incomingLinks.listen(
      _handleSubscribedLink,
      onError: _handleLinkError,
    );
  }

  final GlobalKey<NavigatorState> navigatorKey;
  final Duration timeout;
  final ChikFlutterExternalUrlLauncher _externalLauncher;
  final ChikFlutterAndroidPackagesLauncher _androidPackagesLauncher;
  final FlutterSecureStorage _recoveryStorage;

  _CheckoutSession? _activeSession;
  Uri? _pendingReturnUrl;
  Object? _pendingLinkError;
  late final StreamSubscription<Uri> _linkSubscription;
  bool _opening = false;
  bool _initialReturnConsumed = false;
  bool _disposed = false;

  bool get hasActiveSession => _activeSession != null;

  @override
  ChikMobilePlatform get platform {
    _requireMobilePlatform();
    return defaultTargetPlatform == TargetPlatform.android
        ? ChikMobilePlatform.android
        : ChikMobilePlatform.ios;
  }

  @override
  Future<String> present(ChikCheckoutPresentation presentation) async {
    _requireMobilePlatform();
    final checkoutPlatform = platform;
    if (_disposed) {
      throw const ChikCheckoutException(
        ChikErrorCode.failedPrecondition,
        'The checkout host has been disposed.',
        412,
      );
    }
    if (_activeSession != null || _opening) {
      throw const ChikCheckoutException(
        ChikErrorCode.failedPrecondition,
        'A checkout window is already open.',
        412,
      );
    }
    final returnScheme = _validReturnScheme(presentation.returnScheme);
    final sessionScope = _validSessionScope(presentation.sessionScope);
    final sessionScopeLease = presentation.sessionScopeLease;
    _requireActiveSessionLease(sessionScope, sessionScopeLease);
    final linkError = _pendingLinkError;
    _pendingLinkError = null;
    if (linkError != null) {
      throw ChikCheckoutException(
        ChikErrorCode.unavailable,
        'The checkout return could not be received.',
        503,
        cause: linkError,
      );
    }
    _opening = true;
    late final int recoveryExpiresAt;
    try {
      final recovery = _validRecoveryInput(presentation.recovery);
      final previous = await _readRecovery(sessionScope);
      _requireActiveSessionLease(sessionScope, sessionScopeLease);
      if (previous != null &&
          previous.recovery.preparation.approvalCapability !=
              recovery.preparation.approvalCapability) {
        throw const ChikCheckoutException(
          ChikErrorCode.failedPrecondition,
          'Another checkout is awaiting completion.',
          412,
        );
      }
      recoveryExpiresAt =
          previous?.expiresAt ??
          DateTime.now().add(_checkoutRecoveryLifetime).millisecondsSinceEpoch;
      await _writeRecovery(
        sessionScope,
        sessionScopeLease,
        recovery,
        recoveryExpiresAt,
      );
    } finally {
      _opening = false;
    }
    final navigator = navigatorKey.currentState;
    if (navigator == null) {
      await _clearRecovery(
        sessionScope,
        presentation.recovery.preparation.approvalCapability,
      );
      throw const ChikCheckoutException(
        ChikErrorCode.failedPrecondition,
        'The checkout navigator is not attached.',
        412,
      );
    }
    late final WebViewController controller;
    try {
      controller = WebViewController();
    } catch (cause) {
      await _clearRecovery(
        sessionScope,
        presentation.recovery.preparation.approvalCapability,
      );
      throw ChikCheckoutException(
        ChikErrorCode.unavailable,
        'The checkout UI could not be displayed.',
        503,
        cause: cause,
      );
    }

    final session = _CheckoutSession(
      host: this,
      presentation: presentation,
      platform: checkoutPlatform,
      recoveryExpiresAt: recoveryExpiresAt,
      returnScheme: returnScheme,
      controller: controller,
    );
    _activeSession = session;
    if (!sessionScopeLease.isActive) {
      session.fail(
        const ChikCheckoutException(
          ChikErrorCode.unauthenticated,
          'The customer session changed during checkout.',
          401,
        ),
        StackTrace.current,
      );
      try {
        return await session.result;
      } finally {
        if (identical(_activeSession, session)) _activeSession = null;
        session.dispose();
      }
    }
    final route = MaterialPageRoute<void>(
      builder: (_) => _CheckoutPage(session: session),
      fullscreenDialog: true,
    );
    session.route = route;
    late final Future<void> routeResult;
    try {
      routeResult = navigator.push<void>(route);
    } catch (cause, stackTrace) {
      _activeSession = null;
      session.dispose();
      await _clearRecovery(
        sessionScope,
        presentation.recovery.preparation.approvalCapability,
      );
      Error.throwWithStackTrace(
        ChikCheckoutException(
          ChikErrorCode.unavailable,
          'The checkout UI could not be displayed.',
          503,
          cause: cause,
        ),
        stackTrace,
      );
    }
    unawaited(
      routeResult.then<void>(
        (_) => session.dismissedByNavigator(),
        onError: (Object error, StackTrace stackTrace) {
          session.fail(error, stackTrace);
        },
      ),
    );
    session.start(timeout);
    unawaited(session.initialize());

    final pendingReturnUrl = _pendingReturnUrl;
    _pendingReturnUrl = null;
    if (pendingReturnUrl != null) {
      unawaited(session.handleReturnUrl(pendingReturnUrl, coldStart: true));
    }

    try {
      return await session.result;
    } finally {
      if (identical(_activeSession, session)) {
        _activeSession = null;
      }
      session.dispose();
    }
  }

  @override
  Future<ChikMobileCheckoutRecovery?> restoreCheckout(
    String sessionScope,
  ) async {
    final scope = _validSessionScope(sessionScope);
    return (await _readRecovery(scope))?.recovery;
  }

  Future<_StoredCheckoutRecovery?> _readRecovery(String sessionScope) async {
    final recoveryKey = _checkoutRecoveryKey(sessionScope);
    late final String? encoded;
    try {
      encoded = await _recoveryStorage.read(key: recoveryKey);
    } catch (cause) {
      throw ChikCheckoutException(
        ChikErrorCode.storageError,
        'The pending checkout could not be restored.',
        0,
        cause: cause,
      );
    }
    if (encoded == null) return null;
    try {
      final stored = _checkoutRecoveryRecordFromJson(jsonDecode(encoded));
      if (stored.sessionScope != sessionScope) {
        throw const FormatException('checkout session scope mismatch');
      }
      if (stored.expiresAt <= DateTime.now().millisecondsSinceEpoch) {
        await _deleteRecovery(sessionScope);
        return null;
      }
      return stored;
    } catch (cause) {
      try {
        await _recoveryStorage.delete(key: recoveryKey);
      } catch (_) {
        // The invalid record remains the canonical public cause.
      }
      throw ChikCheckoutException(
        ChikErrorCode.storageError,
        'The pending checkout record is invalid.',
        0,
        cause: cause,
      );
    }
  }

  @override
  Future<void> completeCheckout(
    String approvalCapability,
    String sessionScope,
  ) async {
    final scope = _validSessionScope(sessionScope);
    final stored = await _readRecovery(scope);
    if (stored == null) return;
    if (stored.recovery.preparation.approvalCapability != approvalCapability) {
      throw const ChikCheckoutException(
        ChikErrorCode.failedPrecondition,
        'The pending checkout does not match this completion.',
        412,
      );
    }
    await _deleteRecovery(scope);
  }

  Future<void> _deleteRecovery(String sessionScope) async {
    try {
      await _recoveryStorage.delete(key: _checkoutRecoveryKey(sessionScope));
    } catch (cause) {
      throw ChikCheckoutException(
        ChikErrorCode.storageError,
        'The pending checkout could not be cleared.',
        0,
        cause: cause,
      );
    }
  }

  Future<void> _clearRecovery(
    String sessionScope,
    String approvalCapability,
  ) async {
    final stored = await _readRecovery(sessionScope);
    if (stored == null ||
        stored.recovery.preparation.approvalCapability != approvalCapability) {
      return;
    }
    await _deleteRecovery(sessionScope);
  }

  Future<void> _writeRecovery(
    String sessionScope,
    ChikSessionScopeLease sessionScopeLease,
    ChikMobileCheckoutRecovery recovery,
    int expiresAt,
  ) async {
    _requireActiveSessionLease(sessionScope, sessionScopeLease);
    try {
      await _recoveryStorage.write(
        key: _checkoutRecoveryKey(sessionScope),
        value: jsonEncode(<String, Object?>{
          'version': _checkoutRecoveryRecordVersion,
          'expiresAt': expiresAt,
          'sessionScope': sessionScope,
          'recovery': _checkoutRecoveryToJson(recovery),
        }),
      );
    } catch (cause) {
      throw ChikCheckoutException(
        ChikErrorCode.storageError,
        'The pending checkout could not be stored.',
        0,
        cause: cause,
      );
    }
    if (!sessionScopeLease.isActive) {
      await _deleteRecovery(sessionScope);
      throw const ChikCheckoutException(
        ChikErrorCode.unauthenticated,
        'The customer session changed during checkout.',
        401,
      );
    }
  }

  Future<void> _storeRedirect(
    String sessionScope,
    ChikSessionScopeLease sessionScopeLease,
    ChikMobileCheckoutRecovery recovery,
    String redirectUrl,
    int expiresAt,
  ) {
    return _writeRecovery(
      sessionScope,
      sessionScopeLease,
      ChikMobileCheckoutRecovery(
        preparation: recovery.preparation,
        redirectUrl: redirectUrl,
      ),
      expiresAt,
    );
  }

  Future<bool> _handleReturnUrl(Uri url) async {
    final incoming = _tryIncomingUrl(url);
    if (incoming == null) return false;
    final session = _activeSession;
    if (session != null) return session.handleReturnUrl(incoming);
    if (_initialReturnConsumed) return false;
    if (_pendingReturnUrl != null && _pendingReturnUrl != incoming) {
      return false;
    }
    _pendingReturnUrl = incoming;
    _initialReturnConsumed = true;
    return true;
  }

  /// Dismisses the active checkout presentation, if any.
  Future<void> dismiss() async {
    _pendingReturnUrl = null;
    final session = _activeSession;
    if (session == null) return;
    session.cancel();
    try {
      await session.result;
    } catch (_) {
      // The present caller receives the public error; dismiss only waits for closure.
    }
  }

  /// Stops the application-link subscription and dismisses any open checkout.
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    await _linkSubscription.cancel();
    await dismiss();
  }

  void _handleLinkError(Object error, StackTrace stackTrace) {
    final session = _activeSession;
    if (session == null) {
      _pendingLinkError ??= error;
      return;
    }
    session.fail(
      ChikCheckoutException(
        ChikErrorCode.unavailable,
        'The checkout return could not be received.',
        503,
        cause: error,
      ),
      stackTrace,
    );
  }

  void _handleSubscribedLink(Uri url) {
    if (_activeSession != null) _initialReturnConsumed = true;
    unawaited(_handleReturnUrl(url));
  }

  @override
  Future<void> openExternal(String url, {List<String>? androidPackages}) async {
    final uri = Uri.tryParse(url);
    if (uri == null || uri.scheme.isEmpty || url.length > 16 * 1024) {
      throw const ChikCheckoutException(
        ChikErrorCode.invalidArgument,
        'The checkout navigation URL is invalid.',
        400,
      );
    }
    if (androidPackages != null) {
      if ((_activeSession?.platform ?? platform) !=
              ChikMobilePlatform.android ||
          !_validAndroidPackages(androidPackages) ||
          !_packageTarget(uri)) {
        throw const ChikCheckoutException(
          ChikErrorCode.invalidArgument,
          'The package-bound Android checkout target is invalid.',
          400,
        );
      }
      Object? cause;
      try {
        if (await _androidPackagesLauncher(uri, androidPackages)) return;
      } catch (error) {
        cause = error;
      }
      throw ChikCheckoutException(
        ChikErrorCode.unavailable,
        'The payment application could not be opened.',
        503,
        cause: cause,
      );
    }
    if ((_activeSession?.platform ?? platform) == ChikMobilePlatform.android &&
        !_unboundAndroidTarget(uri)) {
      throw const ChikCheckoutException(
        ChikErrorCode.invalidArgument,
        'Android checkout application links require a reviewed package.',
        400,
      );
    }
    Object? cause;
    try {
      if (await _externalLauncher(uri)) return;
    } catch (error) {
      cause = error;
    }
    throw ChikCheckoutException(
      ChikErrorCode.unavailable,
      'The payment application could not be opened.',
      503,
      cause: cause,
    );
  }
}

final class _CheckoutSession {
  _CheckoutSession({
    required this.host,
    required this.presentation,
    required this.platform,
    required this.recoveryExpiresAt,
    required this.returnScheme,
    required this.controller,
  }) {
    _stopListeningForSessionInvalidation = presentation.sessionScopeLease
        .listen(() {
          fail(
            const ChikCheckoutException(
              ChikErrorCode.unauthenticated,
              'The customer session changed during checkout.',
              401,
            ),
            StackTrace.current,
          );
        });
  }

  final ChikFlutterMobileCheckoutHost host;
  final ChikCheckoutPresentation presentation;
  final ChikMobilePlatform platform;
  final int recoveryExpiresAt;
  final String returnScheme;
  final WebViewController controller;
  final Completer<String> _result = Completer<String>();

  Route<void>? route;
  Timer? _timer;
  Future<void>? _initialization;
  bool _settling = false;
  late final void Function() _stopListeningForSessionInvalidation;

  Future<String> get result => _result.future;

  void start(Duration timeout) {
    _timer = Timer(
      timeout,
      () => fail(
        const ChikCheckoutException(
          ChikErrorCode.deadlineExceeded,
          'Checkout timed out.',
          504,
        ),
        StackTrace.current,
      ),
    );
  }

  Future<void> initialize() => _initialization ??= _initialize();

  Future<void> _initialize() async {
    try {
      await controller.setJavaScriptMode(JavaScriptMode.unrestricted);
      await controller.setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: _navigate,
          onWebResourceError: (error) {
            if (error.isForMainFrame == true) {
              fail(
                ChikCheckoutException(
                  ChikErrorCode.unavailable,
                  'The checkout UI could not be displayed.',
                  503,
                  cause: error,
                ),
                StackTrace.current,
              );
            }
          },
        ),
      );
      await controller.loadHtmlString(presentation.document);
    } catch (error, stackTrace) {
      fail(error, stackTrace);
    }
  }

  Future<NavigationDecision> _navigate(NavigationRequest request) async {
    if (_result.isCompleted) return NavigationDecision.prevent;
    if (request.url == 'about:blank') return NavigationDecision.navigate;
    try {
      final navigation = presentation.navigate(request.url);
      switch (navigation.action) {
        case ChikCheckoutNavigationAction.allow:
          return NavigationDecision.navigate;
        case ChikCheckoutNavigationAction.restore:
          final url = Uri.tryParse(request.url);
          if (url == null || '${url.scheme}://' != returnScheme) {
            throw const ChikCheckoutException(
              ChikErrorCode.invalidResponse,
              'The checkout navigation result is invalid.',
              502,
            );
          }
          return NavigationDecision.prevent;
        case ChikCheckoutNavigationAction.resume:
          await _resume(navigation.url);
          return NavigationDecision.prevent;
        case ChikCheckoutNavigationAction.complete:
          await complete(request.url);
          return NavigationDecision.prevent;
        case ChikCheckoutNavigationAction.external:
          await _openExternal(navigation);
          return NavigationDecision.prevent;
      }
    } catch (error, stackTrace) {
      fail(_navigationError(error), stackTrace);
      return NavigationDecision.prevent;
    }
  }

  Future<bool> handleReturnUrl(Uri url, {bool coldStart = false}) async {
    if (_result.isCompleted) return false;
    try {
      await initialize();
      if (_result.isCompleted) return false;
      final navigation = presentation.navigate(url.toString());
      switch (navigation.action) {
        case ChikCheckoutNavigationAction.complete:
          await complete(url.toString());
          return true;
        case ChikCheckoutNavigationAction.allow:
          return false;
        case ChikCheckoutNavigationAction.restore:
          if ('${url.scheme}://' != returnScheme) return false;
          if (coldStart) {
            fail(
              const ChikCheckoutException(
                ChikErrorCode.failedPrecondition,
                'The checkout return cannot be resumed.',
                412,
              ),
              StackTrace.current,
            );
          }
          return true;
        case ChikCheckoutNavigationAction.resume:
          await _resume(navigation.url);
          return true;
        case ChikCheckoutNavigationAction.external:
          await _openExternal(navigation);
          return true;
      }
    } on ChikCheckoutException catch (error, stackTrace) {
      if (error.code == ChikErrorCode.invalidArgument) {
        if (coldStart && '${url.scheme}://' == returnScheme) {
          fail(
            ChikCheckoutException(
              ChikErrorCode.failedPrecondition,
              'The checkout return cannot be resumed.',
              412,
              cause: error,
            ),
            stackTrace,
          );
          return true;
        }
        return false;
      }
      fail(error, stackTrace);
      return true;
    } catch (error, stackTrace) {
      fail(_navigationError(error), stackTrace);
      return true;
    }
  }

  Future<void> _openExternal(ChikCheckoutNavigation navigation) async {
    final target = navigation.url;
    if (target == null || target.isEmpty) {
      throw const ChikCheckoutException(
        ChikErrorCode.invalidResponse,
        'The checkout navigation result is invalid.',
        502,
      );
    }
    Object? primaryCause;
    try {
      await host.openExternal(
        target,
        androidPackages: navigation.androidPackages,
      );
      return;
    } catch (cause) {
      primaryCause = cause;
      final fallback = navigation.fallbackUrl;
      if (fallback == null || fallback.isEmpty) {
        throw ChikCheckoutException(
          ChikErrorCode.unavailable,
          'The payment application could not be opened.',
          503,
          cause: primaryCause,
        );
      }
      try {
        await host.openExternal(fallback);
        return;
      } catch (fallbackCause) {
        throw ChikCheckoutException(
          ChikErrorCode.unavailable,
          'The payment application fallback could not be opened.',
          503,
          cause: _ExternalOpenCauses(primaryCause, fallbackCause),
        );
      }
    }
  }

  Future<void> _resume(String? value) async {
    final url = Uri.tryParse(value ?? '');
    if (url == null ||
        url.scheme != 'https' ||
        url.host.isEmpty ||
        url.userInfo.isNotEmpty ||
        url.fragment.isNotEmpty) {
      throw const ChikCheckoutException(
        ChikErrorCode.invalidResponse,
        'The checkout navigation result is invalid.',
        502,
      );
    }
    try {
      await controller.loadRequest(url);
    } catch (cause) {
      throw ChikCheckoutException(
        ChikErrorCode.unavailable,
        'The checkout UI could not be displayed.',
        503,
        cause: cause,
      );
    }
  }

  Future<void> complete(String url) async {
    if (_result.isCompleted || _settling) return;
    _settling = true;
    try {
      await host._storeRedirect(
        presentation.sessionScope,
        presentation.sessionScopeLease,
        presentation.recovery,
        url,
        recoveryExpiresAt,
      );
    } catch (error, stackTrace) {
      _settling = false;
      fail(error, stackTrace);
      return;
    }
    if (_result.isCompleted) return;
    _timer?.cancel();
    _closeRoute();
    _result.complete(url);
  }

  void cancel() {
    fail(
      const ChikCheckoutException(
        ChikErrorCode.canceled,
        'Checkout was canceled.',
        499,
      ),
      StackTrace.current,
    );
  }

  void dismissedByNavigator() {
    if (!_result.isCompleted) cancel();
  }

  void fail(Object error, StackTrace stackTrace) {
    if (_result.isCompleted || _settling) return;
    _settling = true;
    _timer?.cancel();
    _closeRoute();
    final publicError = error is ChikCheckoutException
        ? error
        : ChikCheckoutException(
            ChikErrorCode.unavailable,
            'The checkout UI could not be displayed.',
            503,
            cause: error,
          );
    unawaited(_fail(publicError, stackTrace));
  }

  Future<void> _fail(ChikCheckoutException error, StackTrace stackTrace) async {
    ChikCheckoutException result = error;
    try {
      await host._clearRecovery(
        presentation.sessionScope,
        presentation.recovery.preparation.approvalCapability,
      );
    } catch (cleanupCause) {
      result = ChikCheckoutException(
        ChikErrorCode.storageError,
        'The pending checkout could not be cleared.',
        0,
        cause: _CheckoutCleanupCauses(error, cleanupCause),
      );
    }
    if (!_result.isCompleted) _result.completeError(result, stackTrace);
  }

  void _closeRoute() {
    final currentRoute = route;
    final navigator = currentRoute?.navigator;
    if (currentRoute != null && navigator != null && currentRoute.isActive) {
      navigator.removeRoute(currentRoute);
    }
  }

  void dispose() {
    _timer?.cancel();
    _stopListeningForSessionInvalidation();
  }
}

final class _CheckoutPage extends StatelessWidget {
  const _CheckoutPage({required this.session});

  final _CheckoutSession session;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: false,
        title: const Text('Checkout'),
        actions: <Widget>[
          IconButton(
            onPressed: session.cancel,
            tooltip: 'Close checkout',
            icon: const Icon(Icons.close),
          ),
        ],
      ),
      body: SafeArea(child: WebViewWidget(controller: session.controller)),
    );
  }
}

Duration _validTimeout(Duration value) {
  if (value < const Duration(seconds: 1) ||
      value > const Duration(minutes: 10)) {
    throw const ChikCheckoutException(
      ChikErrorCode.invalidArgument,
      'The checkout timeout is invalid.',
      400,
    );
  }
  return value;
}

String _validReturnScheme(String value) {
  final match = RegExp(r'^([a-z][a-z0-9+.-]{1,62})://$').firstMatch(value);
  if (match == null || match.group(1) == 'http' || match.group(1) == 'https') {
    throw const ChikCheckoutException(
      ChikErrorCode.invalidArgument,
      'The checkout return scheme is invalid.',
      400,
    );
  }
  return value;
}

String _validSessionScope(String value) {
  if (!_sessionScopePattern.hasMatch(value)) {
    throw const ChikCheckoutException(
      ChikErrorCode.invalidArgument,
      'The checkout session scope is invalid.',
      400,
    );
  }
  return value;
}

void _requireActiveSessionLease(
  String sessionScope,
  ChikSessionScopeLease lease,
) {
  if (!lease.isActive || lease.sessionScope != sessionScope) {
    throw const ChikCheckoutException(
      ChikErrorCode.unauthenticated,
      'The customer session changed during checkout.',
      401,
    );
  }
}

String _checkoutRecoveryKey(String sessionScope) =>
    '$_defaultCheckoutRecoveryKey.$sessionScope';

Uri? _tryIncomingUrl(Uri value) {
  final encoded = value.toString();
  if (value.scheme.isEmpty || encoded.isEmpty || encoded.length > 16 * 1024) {
    return null;
  }
  return value;
}

Map<String, Object?> _checkoutRecoveryToJson(
  ChikMobileCheckoutRecovery recovery,
) => <String, Object?>{
  'preparation': recovery.preparation.toJson(),
  if (recovery.redirectUrl != null) 'redirectUrl': recovery.redirectUrl,
};

_StoredCheckoutRecovery _checkoutRecoveryRecordFromJson(Object? value) {
  if (value is! Map ||
      value.length != 4 ||
      value.keys.any(
        (key) => !const <String>{
          'version',
          'expiresAt',
          'sessionScope',
          'recovery',
        }.contains(key),
      ) ||
      value['version'] != _checkoutRecoveryRecordVersion) {
    throw const FormatException('recovery record has invalid fields');
  }
  final expiresAt = value['expiresAt'];
  if (expiresAt is! int ||
      expiresAt <= 0 ||
      expiresAt >
          DateTime.now()
              .add(_checkoutRecoveryLifetime)
              .millisecondsSinceEpoch) {
    throw const FormatException('recovery expiration is invalid');
  }
  final sessionScope = value['sessionScope'];
  if (sessionScope is! String || !_sessionScopePattern.hasMatch(sessionScope)) {
    throw const FormatException('recovery session scope is invalid');
  }
  return _StoredCheckoutRecovery(
    expiresAt: expiresAt,
    sessionScope: sessionScope,
    recovery: _checkoutRecoveryFromJson(value['recovery']),
  );
}

ChikMobileCheckoutRecovery _checkoutRecoveryFromJson(Object? value) {
  if (value is! Map) throw const FormatException('recovery is not an object');
  final hasRedirectUrl = value.containsKey('redirectUrl');
  if (!value.containsKey('preparation') ||
      value.length != (hasRedirectUrl ? 2 : 1) ||
      value.keys.any((key) => key != 'preparation' && key != 'redirectUrl')) {
    throw const FormatException('recovery has invalid fields');
  }
  final rawPreparation = value['preparation'];
  if (rawPreparation is! Map ||
      rawPreparation.length != 7 ||
      rawPreparation.keys.any(
        (key) => !const <String>{
          'requestId',
          'orderId',
          'orderName',
          'amount',
          'currency',
          'customerKey',
          'approvalCapability',
        }.contains(key),
      )) {
    throw const FormatException('preparation is not an object');
  }
  String stringValue(String key) {
    final field = rawPreparation[key];
    if (field is! String || field.isEmpty) {
      throw FormatException('$key is invalid');
    }
    return field;
  }

  final requestId = stringValue('requestId');
  final orderId = stringValue('orderId');
  final orderName = stringValue('orderName');
  final currency = stringValue('currency');
  final customerKey = stringValue('customerKey');
  final approvalCapability = stringValue('approvalCapability');
  final amount = rawPreparation['amount'];
  if (amount is! int || amount <= 0 || amount > 9007199254740991) {
    throw const FormatException('amount is invalid');
  }
  if (requestId.trim().isEmpty ||
      requestId.trim() != requestId ||
      utf8.encode(requestId).length > 512 ||
      !_recoveryOrderId.hasMatch(orderId) ||
      orderName.trim().isEmpty ||
      orderName.trim() != orderName ||
      orderName.runes.length > 100 ||
      currency != 'KRW' ||
      (customerKey != 'ANONYMOUS' &&
          !_recoveryCustomerKey.hasMatch(customerKey)) ||
      !_recoveryApprovalCapability.hasMatch(approvalCapability)) {
    throw const FormatException('preparation is invalid');
  }
  String? redirectUrl;
  if (hasRedirectUrl) {
    final redirect = value['redirectUrl'];
    if (redirect is! String ||
        redirect.isEmpty ||
        redirect.length > 16 * 1024) {
      throw const FormatException('redirectUrl is invalid');
    }
    final url = Uri.tryParse(redirect);
    if (url == null ||
        url.scheme != 'https' ||
        url.host.isEmpty ||
        url.userInfo.isNotEmpty ||
        url.fragment.isNotEmpty) {
      throw const FormatException('redirectUrl is invalid');
    }
    redirectUrl = redirect;
  }
  return ChikMobileCheckoutRecovery(
    preparation: ChikCheckoutPreparation(
      requestId: requestId,
      orderId: orderId,
      orderName: orderName,
      amount: amount,
      currency: currency,
      customerKey: customerKey,
      approvalCapability: approvalCapability,
    ),
    redirectUrl: redirectUrl,
  );
}

ChikMobileCheckoutRecovery _validRecoveryInput(
  ChikMobileCheckoutRecovery recovery,
) {
  try {
    return _checkoutRecoveryFromJson(_checkoutRecoveryToJson(recovery));
  } catch (cause) {
    throw ChikCheckoutException(
      ChikErrorCode.invalidArgument,
      'The checkout recovery record is invalid.',
      400,
      cause: cause,
    );
  }
}

void _requireMobilePlatform() {
  if (kIsWeb ||
      (defaultTargetPlatform != TargetPlatform.android &&
          defaultTargetPlatform != TargetPlatform.iOS)) {
    throw const ChikCheckoutException(
      ChikErrorCode.failedPrecondition,
      'The mobile checkout host is unavailable on this platform.',
      412,
    );
  }
}

Future<bool> _launchExternalUrl(Uri url) {
  return launchUrl(url, mode: LaunchMode.externalApplication);
}

Future<bool> _launchAndroidPackages(Uri url, List<String> packageNames) async {
  final opened = await _androidCheckoutChannel.invokeMethod<bool>(
    'openPackages',
    <String, Object>{'url': url.toString(), 'packageNames': packageNames},
  );
  return opened == true;
}

bool _validAndroidPackage(String value) {
  return value.length <= 255 &&
      RegExp(
        r'^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$',
      ).hasMatch(value);
}

bool _validAndroidPackages(List<String> values) {
  return values.isNotEmpty &&
      values.length <= 32 &&
      values.every(_validAndroidPackage) &&
      values.toSet().length == values.length;
}

bool _packageTarget(Uri value) {
  return value.scheme != 'http' &&
      value.scheme != 'https' &&
      value.scheme != 'intent' &&
      value.scheme != 'javascript' &&
      value.scheme != 'market';
}

bool _unboundAndroidTarget(Uri value) {
  return value.scheme == 'https';
}

ChikCheckoutException _navigationError(Object error) {
  return error is ChikCheckoutException &&
          error.code == ChikErrorCode.invalidResponse
      ? error
      : ChikCheckoutException(
          ChikErrorCode.invalidResponse,
          'The checkout navigation result is invalid.',
          502,
          cause: error,
        );
}

final class _ExternalOpenCauses {
  const _ExternalOpenCauses(this.primary, this.fallback);

  final Object? primary;
  final Object fallback;
}

final class _CheckoutCleanupCauses {
  const _CheckoutCleanupCauses(this.checkout, this.cleanup);

  final Object checkout;
  final Object cleanup;
}

final class _StoredCheckoutRecovery {
  const _StoredCheckoutRecovery({
    required this.expiresAt,
    required this.sessionScope,
    required this.recovery,
  });

  final int expiresAt;
  final String sessionScope;
  final ChikMobileCheckoutRecovery recovery;
}

final _sessionScopePattern = RegExp(r'^[a-f0-9]{64}$');
final _recoveryOrderId = RegExp(r'^[A-Za-z0-9_-]{6,64}$');
final _recoveryCustomerKey = RegExp(
  r'^(?=.{2,50}$)(?=.*[-_=.@])[A-Za-z0-9_=.@-]+$',
);
final _recoveryApprovalCapability = RegExp(r'^[A-Za-z0-9_-]{43}$');
