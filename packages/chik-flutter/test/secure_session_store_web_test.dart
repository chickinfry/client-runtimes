import 'package:chik_flutter/chik_flutter.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Flutter Web은 native credential store를 거부한다', () {
    if (!kIsWeb) return;
    expect(
      () => ChikFlutterSecureSessionStore(),
      throwsA(isA<UnsupportedError>()),
    );
  });
}
