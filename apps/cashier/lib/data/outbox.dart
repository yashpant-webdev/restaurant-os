import 'package:sembast/sembast.dart';

import 'api.dart';

/// Every change the cashier makes (open a table, KOT, cash payment…) is first saved
/// on the device, then sent to the server in order. The server endpoints are
/// idempotent (client-generated ids, Idempotency-Key headers), so sending the
/// same change twice after a flaky connection never creates a duplicate.
class Outbox {
  final Database db;
  final Api api;
  final _store = intMapStoreFactory.store('outbox');
  final _failed = intMapStoreFactory.store('outbox_failed');
  bool _flushing = false;

  Outbox(this.db, this.api);

  Future<void> add({required String label, required String method, required String url, Object? body, Map<String, String>? headers, String? orderId}) async {
    await _store.add(db, {
      'label': label,
      'method': method,
      'url': url,
      'body': body,
      'headers': headers,
      'orderId': orderId,
      'createdAt': DateTime.now().toIso8601String(),
      'attempts': 0,
    });
  }

  Future<int> pendingCount() => _store.count(db);
  Future<Set<String>> pendingOrderIds() async =>
      (await _store.find(db)).map((r) => r.value['orderId'] as String?).whereType<String>().toSet();
  Future<List<Map<String, Object?>>> failed() async => (await _failed.find(db)).map((r) => {...r.value, 'key': r.key}).toList();
  Future<void> dismissFailed(int key) => _failed.record(key).delete(db);

  /// Sends queued changes oldest first. Stops at the first network problem (to keep
  /// order: a KOT must never reach the server before its table was opened).
  /// A change the server rejects outright (e.g. item sold out) is moved aside for
  /// the manager instead of blocking everything behind it.
  Future<({int sent, bool online})> flush() async {
    if (_flushing) return (sent: 0, online: true);
    _flushing = true;
    var sent = 0;
    try {
      final records = await _store.find(db, finder: Finder(sortOrders: [SortOrder(Field.key)]));
      for (final r in records) {
        final v = r.value;
        try {
          await api.send(v['method'] as String, v['url'] as String,
              body: v['body'], headers: (v['headers'] as Map?)?.cast<String, String>());
          await _store.record(r.key).delete(db);
          sent++;
        } on OfflineError {
          return (sent: sent, online: false);
        } on ApiError catch (e) {
          if (e.isRetryable) {
            await _store.record(r.key).update(db, {'attempts': (v['attempts'] as int) + 1, 'lastError': e.message});
            return (sent: sent, online: true);
          }
          await db.transaction((txn) async {
            await _failed.add(txn, {...v, 'error': e.message, 'failedAt': DateTime.now().toIso8601String()});
            await _store.record(r.key).delete(txn);
          });
        }
      }
      return (sent: sent, online: true);
    } finally {
      _flushing = false;
    }
  }
}
