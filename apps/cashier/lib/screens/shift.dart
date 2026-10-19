import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app_state.dart';
import '../money.dart';
import '../widgets/common.dart';

/// Start of shift: count the opening cash float in the drawer.
class StartShiftScreen extends StatefulWidget {
  const StartShiftScreen({super.key});
  @override
  State<StartShiftScreen> createState() => _StartShiftScreenState();
}

class _StartShiftScreenState extends State<StartShiftScreen> {
  final amount = TextEditingController(text: '2000');

  @override
  Widget build(BuildContext context) {
    final s = context.watch<AppState>();
    return Scaffold(
      appBar: AppBar(title: Text('Hi ${s.user?.name ?? ''}'), actions: [const SyncChip(), TextButton(onPressed: s.logout, child: const Text('Sign out')), const SizedBox(width: 8)]),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Text('Start shift', style: Theme.of(context).textTheme.headlineSmall),
              const SizedBox(height: 8),
              const Text('Count the cash in the drawer before the first bill.'),
              const SizedBox(height: 20),
              TextField(controller: amount, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Opening cash (₹)', prefixText: '₹ ', border: OutlineInputBorder())),
              const SizedBox(height: 20),
              FilledButton.icon(
                icon: const Icon(Icons.play_arrow),
                label: const Text('Start shift'),
                onPressed: () {
                  final p = rupeesToPaise(amount.text);
                  if (p == null) return toast(context, 'Enter the cash amount', error: true);
                  s.startShift(p);
                },
              ),
            ]),
          ),
        ),
      ),
    );
  }
}

/// Shift summary, pay-in / pay-out, and closing with a denomination count.
class ShiftPanel extends StatefulWidget {
  const ShiftPanel({super.key});
  @override
  State<ShiftPanel> createState() => _ShiftPanelState();
}

class _ShiftPanelState extends State<ShiftPanel> {
  static const notes = [500, 200, 100, 50, 20, 10, 5, 2, 1];
  final counts = <int, int>{};

  int get counted => counts.entries.fold(0, (t, e) => t + e.key * 100 * e.value);

  Future<void> _movement(bool payIn) async {
    final amt = TextEditingController(), reason = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(payIn ? 'Cash in' : 'Cash out (petty expense)'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: amt, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Amount (₹)')),
          TextField(controller: reason, decoration: InputDecoration(labelText: 'Reason', hintText: payIn ? 'Change from bank' : 'Milk, ice, gas…')),
        ]),
        actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')), FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Save'))],
      ),
    );
    final p = rupeesToPaise(amt.text);
    if (ok == true && p != null && p > 0 && reason.text.trim().isNotEmpty && mounted) {
      await context.read<AppState>().cashMovement(payIn: payIn, paise: p, reason: reason.text.trim());
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = context.watch<AppState>();
    final sh = s.shift!;
    final diff = counted - s.expectedCash;
    Widget row(String l, int v, {bool bold = false}) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: Row(children: [Expanded(child: Text(l)), Text(inr(v), style: TextStyle(fontWeight: bold ? FontWeight.bold : null))]),
        );
    return ListView(padding: const EdgeInsets.all(16), children: [
      Text('Shift · opened ${TimeOfDay.fromDateTime(DateTime.parse(sh['openedAt'])).format(context)} by ${sh['openedBy']}', style: Theme.of(context).textTheme.titleLarge),
      const SizedBox(height: 12),
      Wrap(spacing: 16, runSpacing: 16, children: [
        SizedBox(
          width: 360,
          child: Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(children: [
                row('Opening cash', sh['openingFloat']),
                row('Cash sales', sh['cashSales']),
                row('Cash in', sh['payIns']),
                row('Cash out', -(sh['payOuts'] as int)),
                const Divider(),
                row('Expected in drawer', s.expectedCash, bold: true),
                const SizedBox(height: 8),
                row('UPI / card sales', sh['otherSales']),
                Row(children: [const Expanded(child: Text('Bills settled')), Text('${sh['bills']}')]),
                const SizedBox(height: 12),
                Row(children: [
                  Expanded(child: OutlinedButton.icon(onPressed: () => _movement(true), icon: const Icon(Icons.add), label: const Text('Cash in'))),
                  const SizedBox(width: 8),
                  Expanded(child: OutlinedButton.icon(onPressed: () => _movement(false), icon: const Icon(Icons.remove), label: const Text('Cash out'))),
                ]),
              ]),
            ),
          ),
        ),
        SizedBox(
          width: 360,
          child: Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Text('Close shift: count the drawer', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 8),
                for (final n in notes)
                  Row(children: [
                    SizedBox(width: 60, child: Text('₹$n')),
                    IconButton(onPressed: () => setState(() => counts[n] = ((counts[n] ?? 0) - 1).clamp(0, 9999)), icon: const Icon(Icons.remove_circle_outline)),
                    SizedBox(width: 36, child: Text('${counts[n] ?? 0}', textAlign: TextAlign.center)),
                    IconButton(onPressed: () => setState(() => counts[n] = (counts[n] ?? 0) + 1), icon: const Icon(Icons.add_circle_outline)),
                    const Spacer(),
                    Text(inr(n * 100 * (counts[n] ?? 0))),
                  ]),
                const Divider(),
                row('Counted', counted, bold: true),
                Row(children: [const Expanded(child: Text('Difference')), Text(inr(diff), style: TextStyle(fontWeight: FontWeight.bold, color: diff == 0 ? Colors.green : Colors.red))]),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: () async {
                    final ok = await showDialog<bool>(
                      context: context,
                      builder: (c) => AlertDialog(
                        title: const Text('Close shift?'),
                        content: Text('Counted ${inr(counted)} vs expected ${inr(s.expectedCash)} (difference ${inr(diff)}).'),
                        actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Back')), FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Close shift'))],
                      ),
                    );
                    if (ok == true) await s.closeShift(counted, counts);
                  },
                  child: const Text('Close shift'),
                ),
              ]),
            ),
          ),
        ),
      ]),
    ]);
  }
}
