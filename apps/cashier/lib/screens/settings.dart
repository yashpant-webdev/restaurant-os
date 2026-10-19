import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app_state.dart';
import '../money.dart';
import '../widgets/common.dart';

/// Server address and the sync queue (what is waiting, what the server refused).
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late final TextEditingController host = TextEditingController(text: context.read<AppState>().host);
  List<Map<String, Object?>> failed = [];

  @override
  void initState() {
    super.initState();
    _loadFailed();
  }

  Future<void> _loadFailed() async {
    final f = await context.read<AppState>().outbox.failed();
    if (mounted) setState(() => failed = f);
  }

  @override
  Widget build(BuildContext context) {
    final s = context.watch<AppState>();
    return Scaffold(
      appBar: AppBar(title: const Text('Sync & settings'), actions: const [SyncChip(), SizedBox(width: 8)]),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Text('Server', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        Row(children: [
          Expanded(
            child: TextField(
              controller: host,
              decoration: const InputDecoration(labelText: 'Backend address', helperText: 'Browser: localhost · Android emulator: 10.0.2.2 · Tablet: the computer\'s Wi-Fi IP', border: OutlineInputBorder()),
            ),
          ),
          const SizedBox(width: 12),
          FilledButton(
            onPressed: () async {
              await s.setHost(host.text);
              if (context.mounted) toast(context, s.online ? 'Connected' : 'Saved. Server not reachable yet.');
            },
            child: const Text('Save'),
          ),
        ]),
        const SizedBox(height: 24),
        Text('Sync', style: Theme.of(context).textTheme.titleMedium),
        ListTile(
          leading: Icon(s.online ? Icons.cloud_done : Icons.cloud_off),
          title: Text(s.online ? 'Online' : 'Offline'),
          subtitle: Text('${s.pending} change(s) waiting · last sync ${s.lastSync == null ? 'never' : TimeOfDay.fromDateTime(s.lastSync!).format(context)}'),
          trailing: FilledButton.tonal(onPressed: () async {
            await s.sync();
            await _loadFailed();
          }, child: const Text('Sync now')),
        ),
        if (failed.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text('Refused by the server (needs a manager)', style: Theme.of(context).textTheme.titleSmall?.copyWith(color: Colors.red.shade300)),
          for (final f in failed)
            Card(
              child: ListTile(
                title: Text('${f['label']}'),
                subtitle: Text('${f['error']}'),
                trailing: IconButton(icon: const Icon(Icons.close), tooltip: 'Dismiss', onPressed: () async {
                  await s.outbox.dismissFailed(f['key'] as int);
                  await _loadFailed();
                }),
              ),
            ),
        ],
        const SizedBox(height: 24),
        Text('Menu on this device: ${s.menu.length} items · ${s.menu.where((m) => !m.isAvailable).length} sold out', style: Theme.of(context).textTheme.bodySmall),
        Text('Unsynced orders: ${s.localOrders.values.where((o) => o.pendingSync).length} (${inr(s.localOrders.values.where((o) => o.pendingSync).fold(0, (t, o) => t + o.totals.total))})', style: Theme.of(context).textTheme.bodySmall),
      ]),
    );
  }
}
