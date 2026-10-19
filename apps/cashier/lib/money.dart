// Money is integer paise everywhere, exactly like the server: no floating point.
import 'package:intl/intl.dart';

final _inr = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 2);
final _inr0 = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 0);

String inr(int paise) => _inr.format(paise / 100);
String inr0(int paise) => _inr0.format(paise / 100);

/// Round-half-up percentage in basis points (500 = 5%), same rule as the server.
int percentOf(int paise, int bp) => (paise * bp + 5000) ~/ 10000;

class BillTotals {
  final int subtotal, cgst, sgst, roundOff, total;
  const BillTotals(this.subtotal, this.cgst, this.sgst, this.roundOff, this.total);

  /// Mirrors the server: tax per line, CGST = floor(tax/2), SGST = rest, round to the rupee.
  /// Used to show the bill while offline; the server recomputes when it syncs.
  factory BillTotals.fromLines(Iterable<({int net, int gstBp})> lines) {
    var sub = 0, tax = 0;
    for (final l in lines) {
      sub += l.net;
      tax += percentOf(l.net, l.gstBp);
    }
    final cgst = tax ~/ 2, sgst = tax - cgst;
    final raw = sub + cgst + sgst;
    final rounded = ((raw + 50) ~/ 100) * 100;
    return BillTotals(sub, cgst, sgst, rounded - raw, rounded);
  }
}
