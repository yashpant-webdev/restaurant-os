import '../money.dart';

class MenuItem {
  final String id, name;
  final int pricePaise, gstRateBp;
  final String category;
  final String? shortCode;
  final String foodType;
  final bool isAvailable;

  MenuItem.fromJson(Map<String, dynamic> j)
      : id = j['id'],
        name = j['name'],
        pricePaise = j['pricePaise'],
        gstRateBp = j['gstRateBp'],
        category = j['category'] ?? 'Other',
        shortCode = j['shortCode'],
        foodType = j['foodType'] ?? 'VEG',
        isAvailable = j['isAvailable'] ?? true;
}

class StaffMember {
  final String id, name, role;
  StaffMember.fromJson(Map<String, dynamic> j)
      : id = j['id'],
        name = j['name'],
        role = j['role'];
}

/// A table on the floor (from the server, possibly overlaid with this device's unsynced orders).
class FloorTable {
  final String label;
  final int seats;
  final String status; // FREE, OCCUPIED, BILL_REQUESTED, PAYING
  final String? orderId;
  final int totalPaise;
  final int? guests;
  final String? captainName;
  final DateTime? openedAt;
  final int kotCount;
  final bool pendingSync;

  const FloorTable({
    required this.label,
    required this.seats,
    required this.status,
    this.orderId,
    this.totalPaise = 0,
    this.guests,
    this.captainName,
    this.openedAt,
    this.kotCount = 0,
    this.pendingSync = false,
  });

  factory FloorTable.fromJson(Map<String, dynamic> j) {
    final o = j['order'] as Map<String, dynamic>?;
    return FloorTable(
      label: j['label'],
      seats: j['seats'],
      status: j['status'],
      orderId: o?['id'],
      totalPaise: o?['totalPaise'] ?? 0,
      guests: o?['guests'],
      captainName: (o?['captain'] as Map?)?['name'],
      openedAt: o?['openedAt'] != null ? DateTime.parse(o!['openedAt']) : null,
      kotCount: o?['kotCount'] ?? 0,
    );
  }
}

class OrderLine {
  final String name;
  final int quantity, netPaise, gstRateBp, kotNo;
  const OrderLine(this.name, this.quantity, this.netPaise, this.gstRateBp, this.kotNo);
}

class Payment {
  final String id, method, status;
  final int amountPaise;
  const Payment(this.id, this.method, this.status, this.amountPaise);
}

/// One order as the cashier sees it: from the server when synced, otherwise from this device.
class OrderView {
  final String id;
  final String channel; // DINE_IN, TAKEAWAY, DELIVERY
  final String? tableRef, captainName, invoiceNo;
  final int? guests;
  final String status; // OPEN, SETTLED, CANCELLED
  final List<OrderLine> lines;
  final BillTotals totals;
  final int paidPaise;
  final List<Payment> payments;
  final bool pendingSync;

  const OrderView({
    required this.id,
    required this.channel,
    this.tableRef,
    this.captainName,
    this.invoiceNo,
    this.guests,
    required this.status,
    required this.lines,
    required this.totals,
    required this.paidPaise,
    required this.payments,
    this.pendingSync = false,
  });

  int get kotCount => lines.fold(0, (m, l) => l.kotNo > m ? l.kotNo : m);
  int get committedPaise => payments.where((p) => p.status == 'CAPTURED' || p.status == 'PENDING').fold(0, (s, p) => s + p.amountPaise);
  int get duePaise {
    if (status != 'OPEN') return 0;
    final due = totals.total - committedPaise;
    return due < 0 ? 0 : due; // no bit shifts here: on the web they are 32-bit
  }

  factory OrderView.fromServer(Map<String, dynamic> j) {
    final lines = (j['lines'] as List)
        .map((l) => OrderLine(l['name'], l['quantity'], l['line_subtotal_paise'], l['gst_rate_bp'], l['kot_no'] ?? 1))
        .toList();
    return OrderView(
      id: j['id'],
      channel: j['channel'],
      tableRef: j['tableRef'],
      captainName: (j['captain'] as Map?)?['name'],
      invoiceNo: j['invoiceNo'],
      guests: j['guests'],
      status: j['status'],
      lines: lines,
      totals: BillTotals(j['subtotalPaise'], j['cgstPaise'], j['sgstPaise'], j['roundOffPaise'], j['totalPaise']),
      paidPaise: j['paidPaise'],
      payments: (j['payments'] as List).map((p) => Payment(p['paymentId'], p['method'], p['status'], p['amountPaise'])).toList(),
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'channel': channel,
        'tableRef': tableRef,
        'captainName': captainName,
        'invoiceNo': invoiceNo,
        'guests': guests,
        'status': status,
        'lines': [for (final l in lines) [l.name, l.quantity, l.netPaise, l.gstRateBp, l.kotNo]],
        'paidPaise': paidPaise,
        'payments': [for (final p in payments) [p.id, p.method, p.status, p.amountPaise]],
        'pendingSync': pendingSync,
      };

  factory OrderView.fromJson(Map<String, dynamic> j) {
    final lines = [for (final l in (j['lines'] as List)) OrderLine(l[0], l[1], l[2], l[3], l[4])];
    return OrderView(
      id: j['id'],
      channel: j['channel'],
      tableRef: j['tableRef'],
      captainName: j['captainName'],
      invoiceNo: j['invoiceNo'],
      guests: j['guests'],
      status: j['status'],
      lines: lines,
      totals: BillTotals.fromLines(lines.map((l) => (net: l.netPaise, gstBp: l.gstRateBp))),
      paidPaise: j['paidPaise'],
      payments: [for (final p in (j['payments'] as List)) Payment(p[0], p[1], p[2], p[3])],
      pendingSync: j['pendingSync'] ?? false,
    );
  }
}
