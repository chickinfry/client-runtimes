import 'package:chik_client/chik_client.dart';
import 'package:chik_flutter/chik_flutter.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_secure_storage_platform_interface/flutter_secure_storage_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('보안 저장소가 하나의 session record를 저장하고 손상 record를 제거한다', () async {
    if (kIsWeb) return;
    final previous = FlutterSecureStoragePlatform.instance;
    final platform = _MemorySecureStoragePlatform();
    FlutterSecureStoragePlatform.instance = platform;
    addTearDown(() => FlutterSecureStoragePlatform.instance = previous);

    final store = ChikFlutterSecureSessionStore();
    final samePhysicalStore = ChikFlutterSecureSessionStore();
    final otherPhysicalStore = ChikFlutterSecureSessionStore(key: 'other');
    expect(store.coordinationKey, samePhysicalStore.coordinationKey);
    expect(store.coordinationKey, isNot(otherPhysicalStore.coordinationKey));
    final session = ChikNativeStoredSession(
      user: const AuthUser(
        userId: 'user',
        projectId: 'project',
        email: 'user@example.test',
        emailVerified: true,
        disabled: false,
        createdAt: '2026-01-01T00:00:00Z',
      ),
      sessionToken: 'access',
      refreshToken: 'refresh',
      expiresAt: '2099-01-01T00:00:00Z',
      refreshExpiresAt: '2099-01-02T00:00:00Z',
      sessionScope:
          'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    );

    await store.write(session);
    expect(platform.values, hasLength(1));
    expect(await store.read(), isNotNull);

    final checkoutKey = 'chik.checkout.${session.sessionScope}';
    platform.values[checkoutKey] = 'sensitive recovery';
    await store.clearSessionScope(session.sessionScope);
    expect(platform.values.containsKey(checkoutKey), isFalse);

    platform.values['chik.session'] =
        '{"sessionScope":"${session.sessionScope}"}';
    platform.values[checkoutKey] = 'sensitive recovery';
    expect(await store.read(), isNull);
    expect(platform.values.containsKey(checkoutKey), isFalse);
    expect(platform.values.containsKey('chik.session'), isFalse);

    platform.values['chik.session'] = 'not json';
    expect(await store.read(), isNull);
    expect(platform.values, isEmpty);
  });

  test('같은 key의 서로 다른 custom storage는 coordinator를 공유하지 않는다', () {
    if (kIsWeb) return;
    final firstStorage = FlutterSecureStorage();
    final secondStorage = FlutterSecureStorage();
    final firstStore = ChikFlutterSecureSessionStore(storage: firstStorage);
    final sameStorageStore = ChikFlutterSecureSessionStore(
      storage: firstStorage,
    );
    final secondStore = ChikFlutterSecureSessionStore(storage: secondStorage);
    expect(firstStore.coordinationKey, same(sameStorageStore.coordinationKey));
    expect(firstStore.coordinationKey, isNot(secondStore.coordinationKey));

    final sharedCoordinationKey = Object();
    expect(
      ChikFlutterSecureSessionStore(
        storage: firstStorage,
        coordinationKey: sharedCoordinationKey,
      ).coordinationKey,
      ChikFlutterSecureSessionStore(
        storage: secondStorage,
        coordinationKey: sharedCoordinationKey,
      ).coordinationKey,
    );
  });
}

final class _MemorySecureStoragePlatform extends FlutterSecureStoragePlatform {
  final Map<String, String> values = <String, String>{};

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
  Future<void> deleteAll({required Map<String, String> options}) async {
    values.clear();
  }

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
    values[key] = value;
  }
}
