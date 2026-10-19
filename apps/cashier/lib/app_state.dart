import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:sembast/sembast.dart';
import 'package:uuid/uuid.dart';

import 'data/api.dart';
import 'data/db_factory.dart';
import 'data/models.dart';
import 'data/outbox.dart';
import 'money.dart';

const _uuid = Uuid();
String newId() => _uuid.v7();

/// Everything the cashier app knows, saved on the device so it survives
/// restarts and keeps working without internet.
class AppState extends ChangeNotifier {
  late final Database _db;
  late final Api api;
  late final Outbox outbox;
  final _kv = stringMapStoreFactory.store('kv');
  final _orders = stringMapStoreFactory.store('orders'); // this device's orders not yet confirmed by the server

  bool ready = false;
  bool online = false;
  int pending = 0;
  String? lastError;
  DateTime? lastSync;

  String outletId = '';
  String outletName = '';
  List<StaffMember> staff = [];
  List<MenuItem> menu = [];
  List<FloorTable> serverFloor = [];
  Map<String, OrderView> localOrders = {};

  StaffMember? user;
  Map<String, dynamic>? shift; // {openedAt, openingFloat, cashSales, upiSales, payIns, payOuts, bills}

  Timer? _timer;

  Future<void> init() async {
    _db = await openLocalDatabase();
    final host = (await _kv.record('host').get(_db))?['v'] as String? ?? (kIsWeb ? Uri.base.host : '10.0.2.2'); // in a browser: the computer that served the app
    api = Api(ServerConfig(host))..renewToken = _renewToken;
    outbox = Outbox(_db, api);

    // Restore the last known state first: the app is usable even if the server is unreachable.
    final cached = await _kv.record('cache').get(_db);
    if (cached != null) {
      outletId = cached['outletId'] as String? ?? '';
      outletName = cached['outletName'] as String? ?? '';
      staff = [for (final s in (cached['staff'] as List? ?? [])) StaffMember.fromJson(Map<String, dynamic>.from(s as Map))];
      menu = [for (final m in (cached['menu'] as List? ?? [])) MenuItem.fromJson(Map<String, dynamic>.from(m as Map))];
      serverFloor = [for (final t in (cached['floor'] as List? ?? [])) FloorTable.fromJson(Map<String, dynamic>.from(t as Map))];
    }
    for (final r in await _orders.find(_db)) {
      localOrders[r.key] = OrderView.fromJson(Map<String, dynamic>.from(r.value));
    }
    final session = await _kv.record('session').get(_db);
    if (session != null) {
      api.token = session['token'] as String?;
      user = staff.where((s) => s.id == session['userId']).firstOrNull;
    }
    shift = (await _kv.record('shift').get(_db))?.cast<String, dynamic>();
    pending = await outbox.pendingCount();
    ready = true;
    notifyListeners();

    unawaited(sync());
    _timer = Timer.periodic(const Duration(seconds: 5), (_) => sync());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  String get host => api.server.host;
  Future<void> setHost(String host) async {
    api.server.host = host.trim();
    await _kv.record('host').put(_db, {'v': api.server.host});
    await sync();
  }

  // ---------------------------------------------------------------- sync

  bool _syncing = false;

  /// Push this device's changes, then pull the latest menu and floor.
  Future<void> sync() async {
    if (_syncing) return;
    _syncing = true;
    try {
      final r = await outbox.flush();
      online = r.online;
      if (online) {
        await _pull();
        await _confirmSyncedOrders();
        lastSync = DateTime.now();
      }
      lastError = null;
    } on OfflineError {
      online = false;
    } catch (e) {
      lastError = e.toString();
    } finally {
      pending = await outbox.pendingCount();
      _syncing = false;
      notifyListeners();
    }
  }

  Future<void> _pull() async {
    final info = await api.get('${api.server.demoUrl}/demo/staff') as Map;
    outletId = info['outletId'];
    outletName = info['outletName'];
    staff = [for (final s in info['staff'] as List) StaffMember.fromJson(Map<String, dynamic>.from(s))];
    if (api.token == null) return;
    final rawMenu = await api.get('${api.server.orderUrl}/menu-items?outletId=$outletId') as List;
    final rawFloor = await api.get('${api.server.orderUrl}/floor?outletId=$outletId') as Map;
    menu = [for (final m in rawMenu) MenuItem.fromJson(Map<String, dynamic>.from(m))];
    serverFloor = [for (final t in rawFloor['tables'] as List) FloorTable.fromJson(Map<String, dynamic>.from(t))];
    await _kv.record('cache').put(_db, {
      'outletId': outletId,
      'outletName': outletName,
      'staff': [for (final s in info['staff'] as List) s],
      'menu': rawMenu,
      'floor': rawFloor['tables'],
    });
  }

  /// Once all of an order's changes reached the server, the server's copy replaces ours
  /// (it has the invoice number, other devices' KOTs and confirmed payments).
  Future<void> _confirmSyncedOrders() async {
    final waiting = await outbox.pendingOrderIds();
    for (final id in localOrders.keys.toList()) {
      if (waiting.contains(id)) continue;
      try {
        final o = OrderView.fromServer(Map<String, dynamic>.from(await api.get('${api.server.orderUrl}/orders/$id') as Map));
        if (o.status == 'OPEN') {
          localOrders[id] = o;
        } else {
          localOrders.remove(id);
          await _orders.record(id).delete(_db);
        }
      } on ApiError catch (e) {
        if (e.status == 404) {
          localOrders.remove(id);
          await _orders.record(id).delete(_db);
        }
      }
    }
  }

  Future<String?> _renewToken() async {
    if (user == null) return null;
    final t = await api.send('GET', '${api.server.demoUrl}/demo/token?staffId=${user!.id}', retried: true) as Map;
    await _kv.record('session').put(_db, {'userId': user!.id, 'token': t['token']});
    return t['token'] as String;
  }

  // ---------------------------------------------------------------- login & shift

  /// Demo PIN check. Real PINs (hashed, per user) come with the identity service.
  Future<void> login(StaffMember s, String pin) async {
    if (pin != '1234') throw ApiError(401, 'BAD_PIN', 'Wrong PIN');
    user = s;
    try {
      api.token = await _renewToken();
    } on OfflineError {
      final saved = await _kv.record('session').get(_db);
      if (saved?['userId'] != s.id) {
        user = null;
        throw ApiError(0, 'OFFLINE', 'First sign-in on this device needs internet');
      }
      api.token = saved!['token'] as String?;
    }
    notifyListeners();
    unawaited(sync());
  }

  Future<void> logout() async {
    user = null;
    api.token = null;
    await _kv.record('session').delete(_db);
    notifyListeners();
  }

  Future<void> startShift(int openingFloatPaise) async {
    shift = {
      'openedAt': DateTime.now().toIso8601String(),
      'openedBy': user?.name,
      'openingFloat': openingFloatPaise,
      'cashSales': 0,
      'otherSales': 0,
      'payIns': 0,
      'payOuts': 0,
      'bills': 0,
    };
    await _kv.record('shift').put(_db, shift!);
    notifyListeners();
  }

  int get expectedCash => shift == null ? 0 : (shift!['openingFloat'] as int) + (shift!['cashSales'] as int) + (shift!['payIns'] as int) - (shift!['payOuts'] as int);

  Future<void> cashMovement({required bool payIn, required int paise, required String reason}) async {
    shift![payIn ? 'payIns' : 'payOuts'] = (shift![payIn ? 'payIns' : 'payOuts'] as int) + paise;
    (shift!['movements'] ??= <Object>[]);
    (shift!['movements'] as List).add({'in': payIn, 'paise': paise, 'reason': reason, 'at': DateTime.now().toIso8601String()});
    await _kv.record('shift').put(_db, shift!);
    notifyListeners();
  }

  Future<Map<String, dynamic>> closeShift(int countedPaise, Map<int, int> denominations) async {
    final report = {
      ...shift!,
      'closedAt': DateTime.now().toIso8601String(),
      'closedBy': user?.name,
      'expectedCash': expectedCash,
      'countedCash': countedPaise,
      'difference': countedPaise - expectedCash,
      'denominations': {for (final e in denominations.entries) '${e.key}': e.value},
    };
    await intMapStoreFactory.store('shift_reports').add(_db, report);
    await _kv.record('shift').delete(_db);
    shift = null;
    notifyListeners();
    return report;
  }

  // ---------------------------------------------------------------- floor & orders

  /// The server's floor, with this device's not-yet-synced orders laid on top.
  List<FloorTable> get floor => [
        for (final t in serverFloor)
          () {
            final local = localOrders.values.where((o) => o.tableRef == t.label && o.status == 'OPEN').firstOrNull;
            if (local == null || (t.orderId != null && !local.pendingSync)) return t;
            return FloorTable(
              label: t.label,
              seats: t.seats,
              status: 'OCCUPIED',
              orderId: local.id,
              totalPaise: local.totals.total,
              guests: local.guests,
              captainName: local.captainName ?? t.captainName,
              openedAt: t.openedAt ?? DateTime.now(),
              kotCount: local.kotCount,
              pendingSync: local.pendingSync,
            );
          }()
      ];

  List<OrderView> get openTakeaways => localOrders.values.where((o) => o.channel != 'DINE_IN' && o.status == 'OPEN').toList();

  /// Loads an order: the local copy if it has unsynced changes, otherwise the server's.
  Future<OrderView?> loadOrder(String id) async {
    final local = localOrders[id];
    if (local != null && local.pendingSync) return local;
    try {
      final o = OrderView.fromServer(Map<String, dynamic>.from(await api.get('${api.server.orderUrl}/orders/$id') as Map));
      online = true;
      return o;
    } on OfflineError {
      online = false;
      return local;
    }
  }

  MenuItem? itemByCode(String code) => menu.where((m) => m.shortCode?.toUpperCase() == code.trim().toUpperCase()).firstOrNull;

  Future<void> _saveLocal(OrderView o) async {
    localOrders[o.id] = o;
    await _orders.record(o.id).put(_db, o.toJson());
  }

  /// Sends a round of items to the kitchen. Opens the order on the first KOT.
  /// Saved locally first, so it works offline and the KOT prints immediately.
  Future<OrderView> sendKot({OrderView? existing, required String channel, String? tableRef, int? guests, required Map<MenuItem, int> cart}) async {
    final lines = [for (final e in cart.entries) {'itemId': e.key.id, 'quantity': e.value}];
    final id = existing?.id ?? newId();
    final kotNo = (existing?.kotCount ?? 0) + 1;
    if (existing == null) {
      await outbox.add(
        label: '${tableRef ?? 'Takeaway'}: open + KOT #1',
        method: 'POST',
        url: '${api.server.orderUrl}/orders',
        body: {'id': id, 'outletId': outletId, 'channel': channel, if (tableRef != null) 'tableRef': tableRef, if (guests != null) 'guests': guests, 'lines': lines},
        orderId: id,
      );
    } else {
      await outbox.add(
        label: '${tableRef ?? 'Order'}: KOT #$kotNo',
        method: 'POST',
        url: '${api.server.orderUrl}/orders/$id/items',
        body: {'kotId': newId(), 'lines': lines},
        orderId: id,
      );
    }
    final newLines = [for (final e in cart.entries) OrderLine(e.key.name, e.value, e.key.pricePaise * e.value, e.key.gstRateBp, kotNo)];
    final all = [...?existing?.lines, ...newLines];
    final o = OrderView(
      id: id,
      channel: channel,
      tableRef: tableRef ?? existing?.tableRef,
      captainName: existing?.captainName,
      guests: guests ?? existing?.guests,
      status: 'OPEN',
      lines: all,
      totals: BillTotals.fromLines(all.map((l) => (net: l.netPaise, gstBp: l.gstRateBp))),
      paidPaise: existing?.paidPaise ?? 0,
      payments: existing?.payments ?? [],
      pendingSync: true,
    );
    await _saveLocal(o);
    notifyListeners();
    unawaited(sync());
    return o;
  }

  /// Cash works offline: recorded locally and sent with an idempotency key.
  Future<OrderView> payCash(OrderView o, int amountPaise) async {
    final paymentId = newId();
    await outbox.add(
      label: '${o.tableRef ?? 'Order'}: cash ${inr(amountPaise)}',
      method: 'POST',
      url: '${api.server.orderUrl}/orders/${o.id}/payments',
      body: {'method': 'CASH', 'amountPaise': amountPaise},
      headers: {'idempotency-key': paymentId},
      orderId: o.id,
    );
    final payments = [...o.payments, Payment(paymentId, 'CASH', 'CAPTURED', amountPaise)];
    final paid = o.paidPaise + amountPaise;
    final settled = paid >= o.totals.total;
    final updated = OrderView(
      id: o.id, channel: o.channel, tableRef: o.tableRef, captainName: o.captainName, guests: o.guests,
      status: settled ? 'SETTLED' : 'OPEN', lines: o.lines, totals: o.totals, paidPaise: paid, payments: payments, pendingSync: true,
    );
    await _saveLocal(updated);
    shift?['cashSales'] = (shift?['cashSales'] as int? ?? 0) + amountPaise;
    if (settled) shift?['bills'] = (shift?['bills'] as int? ?? 0) + 1;
    if (shift != null) await _kv.record('shift').put(_db, shift!);
    notifyListeners();
    unawaited(sync());
    return updated;
  }

  /// UPI needs the internet (the QR comes from the payment gateway). Returns the checkout.
  Future<Map<String, dynamic>> startUpi(OrderView o, int amountPaise) async {
    await sync();
    if (!online) throw ApiError(0, 'OFFLINE', 'UPI needs internet. Take cash, or retry when online.');
    if (pending > 0) throw ApiError(0, 'SYNCING', 'Still sending earlier changes; try again in a moment');
    final r = await api.send('POST', '${api.server.orderUrl}/orders/${o.id}/payments',
        body: {'method': 'UPI', 'amountPaise': amountPaise}, headers: {'idempotency-key': newId()}) as Map;
    return Map<String, dynamic>.from(r);
  }

  /// Demo only: plays the customer's phone paying the UPI QR (sends a signed gateway webhook).
  Future<void> simulateUpiPaid(String gatewayOrderId, int amountPaise) async {
    await api.send('POST', '${api.server.demoUrl}/demo/simulate-upi', body: {'gatewayOrderId': gatewayOrderId, 'succeed': true});
    shift?['otherSales'] = (shift?['otherSales'] as int? ?? 0) + amountPaise;
    if (shift != null) await _kv.record('shift').put(_db, shift!);
  }

  Future<void> setSoldOut(MenuItem item, bool soldOut) async {
    await outbox.add(
      label: '${item.name}: ${soldOut ? 'sold out' : 'back in stock'}',
      method: 'POST',
      url: '${api.server.orderUrl}/menu-items/${item.id}/availability',
      body: {'isAvailable': !soldOut},
    );
    menu = [
      for (final m in menu)
        m.id == item.id
            ? MenuItem.fromJson({'id': m.id, 'name': m.name, 'pricePaise': m.pricePaise, 'gstRateBp': m.gstRateBp, 'category': m.category, 'shortCode': m.shortCode, 'foodType': m.foodType, 'isAvailable': !soldOut})
            : m
    ];
    notifyListeners();
    unawaited(sync());
  }
}
