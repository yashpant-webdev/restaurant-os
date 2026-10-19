import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app_state.dart';
import '../data/models.dart';
import '../widgets/common.dart';
import 'settings.dart';

/// Staff pick their name and enter a PIN. Works offline for anyone who signed in on this device before.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  StaffMember? selected;
  String pin = '';
  bool busy = false;

  Future<void> _tap(String d) async {
    if (busy) return;
    if (d == '⌫') return setState(() => pin = pin.isEmpty ? '' : pin.substring(0, pin.length - 1));
    if (pin.length >= 4) return;
    setState(() => pin += d);
    if (pin.length == 4) {
      setState(() => busy = true);
      try {
        await context.read<AppState>().login(selected!, pin);
      } catch (e) {
        if (mounted) toast(context, e.toString(), error: true);
        setState(() => pin = '');
      } finally {
        if (mounted) setState(() => busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = context.watch<AppState>();
    final people = s.staff.where((x) => x.role != 'CAPTAIN').toList() + s.staff.where((x) => x.role == 'CAPTAIN').toList();
    return Scaffold(
      appBar: AppBar(
        title: Text(s.outletName.isEmpty ? 'Restaurant OS · Cashier' : s.outletName),
        actions: [const SyncChip(), IconButton(icon: const Icon(Icons.settings), tooltip: 'Server settings', onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const SettingsScreen()))), const SizedBox(width: 8)],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 820),
          child: people.isEmpty
              ? Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    const Icon(Icons.wifi_off, size: 48),
                    const SizedBox(height: 12),
                    Text('Can\'t reach the server at ${s.host}', style: Theme.of(context).textTheme.titleMedium),
                    const SizedBox(height: 8),
                    const Text('Set the server address (the computer running the backend), then try again.'),
                    const SizedBox(height: 16),
                    FilledButton(onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const SettingsScreen())), child: const Text('Server settings')),
                  ]),
                )
              : Wrap(
                  alignment: WrapAlignment.center,
                  spacing: 32,
                  runSpacing: 24,
                  children: [
                    SizedBox(
                      width: 320,
                      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                        Text('Who is billing?', style: Theme.of(context).textTheme.titleLarge),
                        const SizedBox(height: 12),
                        for (final p in people)
                          Card(
                            color: selected?.id == p.id ? Theme.of(context).colorScheme.primaryContainer : null,
                            child: ListTile(
                              leading: CircleAvatar(child: Text(p.name[0])),
                              title: Text(p.name),
                              subtitle: Text(p.role[0] + p.role.substring(1).toLowerCase()),
                              onTap: () => setState(() {
                                selected = p;
                                pin = '';
                              }),
                            ),
                          ),
                      ]),
                    ),
                    if (selected != null)
                      SizedBox(
                        width: 300,
                        child: Column(children: [
                          Text('PIN for ${selected!.name}', style: Theme.of(context).textTheme.titleLarge),
                          const SizedBox(height: 16),
                          Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                            for (var i = 0; i < 4; i++)
                              Container(
                                margin: const EdgeInsets.all(8),
                                width: 18,
                                height: 18,
                                decoration: BoxDecoration(shape: BoxShape.circle, color: i < pin.length ? Theme.of(context).colorScheme.primary : Colors.transparent, border: Border.all(color: Theme.of(context).colorScheme.outline)),
                              ),
                          ]),
                          const SizedBox(height: 12),
                          GridView.count(
                            crossAxisCount: 3,
                            shrinkWrap: true,
                            mainAxisSpacing: 8,
                            crossAxisSpacing: 8,
                            childAspectRatio: 1.6,
                            physics: const NeverScrollableScrollPhysics(),
                            children: [
                              for (final d in ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'])
                                d.isEmpty ? const SizedBox() : FilledButton.tonal(onPressed: () => _tap(d), child: Text(d, style: const TextStyle(fontSize: 22))),
                            ],
                          ),
                          const SizedBox(height: 12),
                          Text('Demo PIN: 1234', style: Theme.of(context).textTheme.bodySmall),
                        ]),
                      ),
                  ],
                ),
        ),
      ),
    );
  }
}
