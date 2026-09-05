// Code generated from apps/chickinfry/internal/extensions/payments/toss/key-profiles.json; DO NOT EDIT.

enum TossKeyEnvironment {
  test("test"),
  live("live"),
  ;

  const TossKeyEnvironment(this.wireValue);
  final String wireValue;
}

enum TossCheckoutProfile {
  widgets("widgets"),
  payment("payment"),
  ;

  const TossCheckoutProfile(this.wireValue);
  final String wireValue;
}

typedef TossKeyProfile = ({TossKeyEnvironment environment, TossCheckoutProfile profile, bool paymentTypeInRedirect});

final _environments = <String, TossKeyEnvironment>{
  "test": TossKeyEnvironment.test,
  "live": TossKeyEnvironment.live,
};
final _clientMarkers = <String, TossCheckoutProfile>{
  "gck": TossCheckoutProfile.widgets,
  "ck": TossCheckoutProfile.payment,
};
final _serverMarkers = <String, TossCheckoutProfile>{
  "gsk": TossCheckoutProfile.widgets,
  "sk": TossCheckoutProfile.payment,
};
final _paymentTypeInRedirect = <TossCheckoutProfile, bool>{
  TossCheckoutProfile.widgets: true,
  TossCheckoutProfile.payment: false,
};
final _keyPattern = RegExp(r'^([a-z]+)_([a-z]+)_([A-Za-z0-9_-]+)$');

TossKeyProfile? tossClientKeyProfile(Object? value) => _tossKeyProfile(value, _clientMarkers);
TossKeyProfile? tossServerKeyProfile(Object? value) => _tossKeyProfile(value, _serverMarkers);

TossKeyProfile? _tossKeyProfile(Object? value, Map<String, TossCheckoutProfile> markers) {
  if (value is! String || value.length > 512) return null;
  final match = _keyPattern.firstMatch(value);
  if (match == null) return null;
  final environment = _environments[match.group(1)];
  final profile = markers[match.group(2)];
  return environment == null || profile == null ? null : (environment: environment, profile: profile, paymentTypeInRedirect: _paymentTypeInRedirect[profile]!);
}
