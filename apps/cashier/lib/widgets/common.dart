import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app_state.dart';

/// Online / offline / "N changes waiting" indicator, always visible in the top bar.
class SyncChip extends StatelessWidget {
  const SyncChip({super.key});
  @override
  Widget build(BuildContext context) {
    final s = context.watch<AppState>();
    final (color, icon, text) = !s.online
        ? (Colors.red, Icons.cloud_off, s.pending > 0 ? 'Offline · ${s.pending} to sync' : 'Offline')
        : s.pending > 0
            ? (Colors.orange, Icons.sync, 'Syncing ${s.pending}')
            : (Colors.green, Icons.cloud_done, 'Online');
    return Tooltip(
      message: s.online ? 'All changes are saved on this device and sent to the server.' : 'Billing continues. Changes are saved on this device and sent when the internet is back.',
      child: ActionChip(
        avatar: Icon(icon, size: 18, color: color),
        label: Text(text),
        onPressed: s.sync,
      ),
    );
  }
}

/// The green-square / red-triangle food mark used on Indian menus.
class FoodMark extends StatelessWidget {
  final String foodType;
  const FoodMark(this.foodType, {super.key});
  @override
  Widget build(BuildContext context) {
    final c = foodType == 'VEG' ? Colors.green.shade700 : foodType == 'EGG' ? Colors.amber.shade800 : Colors.red.shade700;
    return Container(
      width: 14,
      height: 14,
      decoration: BoxDecoration(border: Border.all(color: c, width: 1.5), borderRadius: BorderRadius.circular(2)),
      child: Center(child: Container(width: 6, height: 6, decoration: BoxDecoration(color: c, shape: BoxShape.circle))),
    );
  }
}

({Color bg, Color fg, String label}) tableStyle(BuildContext context, String status) {
  final cs = Theme.of(context).colorScheme;
  return switch (status) {
    'OCCUPIED' => (bg: Colors.blue.withValues(alpha: 0.15), fg: Colors.blue.shade300, label: 'Running'),
    'BILL_REQUESTED' => (bg: Colors.orange.withValues(alpha: 0.18), fg: Colors.orange.shade300, label: 'Bill asked'),
    'PAYING' => (bg: Colors.purple.withValues(alpha: 0.18), fg: Colors.purple.shade200, label: 'Paying'),
    _ => (bg: cs.surfaceContainerHighest, fg: cs.onSurfaceVariant, label: 'Free'),
  };
}

void toast(BuildContext context, String msg, {bool error = false}) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(msg), backgroundColor: error ? Colors.red.shade700 : null, behavior: SnackBarBehavior.floating));
}

int? rupeesToPaise(String text) {
  final v = double.tryParse(text.trim());
  if (v == null || v < 0) return null;
  return (v * 100).round();
}
