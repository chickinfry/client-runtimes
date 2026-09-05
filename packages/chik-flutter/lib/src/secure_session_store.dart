import 'dart:convert';

import 'package:chik_client/chik_client.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const _defaultSessionKey = 'chik.session';

/// A native session store backed by operating-system secure storage.
///
/// The stored value is one opaque Chick application session record and never a
/// provider credential. Wrappers for the same physical record must use the same
/// `coordinationKey`.
final class ChikFlutterSecureSessionStore
    implements ChikNativeSessionStore, ChikNativeSessionStoreCoordination {
  ChikFlutterSecureSessionStore({
    FlutterSecureStorage? storage,
    String key = _defaultSessionKey,
    Object? coordinationKey,
  }) : _storage = _requireNativeStorage(storage),
       _key = _validStorageKey(key),
       _coordinationKey =
           coordinationKey ?? _flutterCoordinationKey(storage, key);

  final FlutterSecureStorage _storage;
  final String _key;
  final Object _coordinationKey;

  @override
  Object get coordinationKey => _coordinationKey;

  @override
  Future<ChikNativeStoredSession?> read() async {
    final value = await _storage.read(key: _key);
    if (value == null || value.trim().isEmpty) {
      return null;
    }
    Object? decoded;
    try {
      decoded = jsonDecode(value);
      if (decoded is! Map) {
        throw const FormatException('session is not an object');
      }
      return ChikNativeStoredSession.fromJson(<String, Object?>{
        for (final entry in decoded.entries) entry.key.toString(): entry.value,
      });
    } catch (_) {
      final sessionScope = decoded is Map ? decoded['sessionScope'] : null;
      if (sessionScope is String &&
          RegExp(r'^[a-f0-9]{64}$').hasMatch(sessionScope)) {
        await clearSessionScope(sessionScope);
      }
      await _storage.delete(key: _key);
      return null;
    }
  }

  @override
  Future<void> write(ChikNativeStoredSession session) {
    return _storage.write(key: _key, value: jsonEncode(session.toJson()));
  }

  @override
  Future<void> clear() => _storage.delete(key: _key);

  @override
  Future<void> clearSessionScope(String sessionScope) {
    return _storage.delete(key: 'chik.checkout.$sessionScope');
  }
}

Object _flutterCoordinationKey(FlutterSecureStorage? storage, String key) {
  final storageKey = _validStorageKey(key);
  if (storage == null) return 'chik.flutter.secure-session:$storageKey';
  final keys = _customFlutterSessionCoordinationKeys[storage] ??=
      <String, Object>{};
  return keys.putIfAbsent(storageKey, Object.new);
}

final Expando<Map<String, Object>> _customFlutterSessionCoordinationKeys =
    Expando<Map<String, Object>>();

/// Creates native authentication backed by Flutter secure storage.
///
/// Applications provide [storage] only to customize platform-specific secure
/// storage options, never to pass an individual session credential.
ChikNativeAuth createChikFlutterAuth({
  required String baseUrl,
  FlutterSecureStorage? storage,
  String storageKey = _defaultSessionKey,
  Object? coordinationKey,
  String? apiKey,
  Map<String, String> headers = const {},
  ChikAuthFetch? fetch,
}) {
  return ChikNativeAuth(
    baseUrl: baseUrl,
    sessionStore: ChikFlutterSecureSessionStore(
      storage: storage,
      key: storageKey,
      coordinationKey: coordinationKey,
    ),
    apiKey: apiKey,
    headers: headers,
    fetch: fetch,
  );
}

String _validStorageKey(String value) {
  final normalized = value.trim();
  if (normalized.isEmpty || normalized.length > 255) {
    throw ArgumentError.value(
      value,
      'key',
      'must be between 1 and 255 characters',
    );
  }
  return normalized;
}

FlutterSecureStorage _requireNativeStorage(FlutterSecureStorage? storage) {
  if (kIsWeb) {
    throw UnsupportedError(
      'Flutter web must use the browser cookie authentication path, not a native credential store.',
    );
  }
  return storage ?? const FlutterSecureStorage();
}
