import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app_state.dart';
import '../money.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'order.dart';
import 'settings.dart';
import 'shift.dart';

/// Main screen: Tables · Takeaway & delivery · Shift & cash · Sync.
/// Side rail on tablets and desktops, bottom bar on phones.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int tab = 0;

  @override
  Widget build(BuildContext context) {
    final s = context.watch<AppState>();
    final wide = MediaQuery.sizeOf(context).width >= 760;
    const dests = [
      (Icons.table_restaurant, 'Tables'),
      (Icons.shopping_bag_outlined, 'Takeaway'),
      (Icons.point_of_sale, 'Shift & cash'),
    ];
    final body = switch (tab) { 0 => const TablesView(), 1 => const TakeawayView(), _ => const ShiftPanel() };
    return Scaffold(
      appBar: AppBar(
        title: Text(s.outletName),
        actions: [
          const SyncChip(),
          const SizedBox(width: 8),
          PopupMenuButton<String>(
            tooltip: 'Account',
            child: Padding(padding: const EdgeInsets.symmetric(horizontal: 12), child: Row(children: [const Icon(Icons.person), const SizedBox(width: 4), Text(s.user?.name ?? '')])),
            onSelected: (v) {
              if (v == 'settings') Navigator.push(context, MaterialPageRoute(builder: (_) => const SettingsScreen()));
              if (v == 'logout') s.logout();
            },
            itemBuilder: (_) => const [PopupMenuItem(value: 'settings', child: Text('Sync & settings')), PopupMenuItem(value: 'logout', child: Text('Sign out'))],
          ),
        ],
      ),
      body: wide
          ? Row(children: [
              NavigationRail(
                selectedIndex: tab,
                labelType: NavigationRailLabelType.all,
                onDestinationSelected: (i) => setState(() => tab = i),
                destinations: [for (final d in dests) NavigationRailDestination(icon: Icon(d.$1), label: Text(d.$2))],
              ),
              const VerticalDivider(width: 1),
              Expanded(child: body),
            ])
          : body,
      bottomNavigationBar: wide
          ? null
          : NavigationBar(
              selectedIndex: tab,
              onDestinationSelected: (i) => setState(() => tab = i),
              destinations: [for (final d in dests) NavigationDestination(icon: Icon(d.$1), label: d.$2)],
            ),
    );
  }
}

class TablesView extends StatelessWidget {
  const TablesView({super.key});
  @override
  Widget build(BuildContext context) {
    final s = context.watch<AppState>();
    final tables = s.floor;
    final busy = tables.where((t) => t.status != 'FREE').toList();
    return RefreshIndicator(
      onRefresh: s.sync,
      child: ListView(padding: const EdgeInsets.all(16), children: [
        Wrap(spacing: 12, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
          Text('Floor', style: Theme.of(context).textTheme.titleLarge),
          Chip(label: Text('${tables.length - busy.length} free')),
          Chip(label: Text('${busy.length} running · ${inr0(busy.fold(0, (t, x) => t + x.totalPaise))}')),
          if (tables.isEmpty) const Text('No tables yet. Sync with the server first.'),
        ]),
        const SizedBox(height: 12),
        GridView.builder(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 200, mainAxisExtent: 136, crossAxisSpacing: 12, mainAxisSpacing: 12),
          itemCount: tables.length,
          itemBuilder: (context, i) {
            final t = tables[i];
            final st = tableStyle(context, t.status);
            final mins = t.openedAt == null ? null : DateTime.now().difference(t.openedAt!).inMinutes;
            return Material(
              color: st.bg,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Sage.radiusInner + 4), side: st.border == null ? BorderSide.none : BorderSide(color: st.border!, width: 1.5)),
              child: InkWell(
                customBorder: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Sage.radiusInner + 4)),
                onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => OrderScreen(channel: 'DINE_IN', tableRef: t.label, orderId: t.orderId, seats: t.seats))),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Text(t.label, style: Theme.of(context).textTheme.titleLarge?.copyWith(color: st.fg)),
                      const Spacer(),
                      if (t.pendingSync) const Tooltip(message: 'Saved on this device, waiting to sync', child: Icon(Icons.sync, size: 16)),
                      Text(st.label, style: TextStyle(color: st.fg, fontWeight: FontWeight.w700, fontSize: 12)),
                    ]),
                    const Spacer(),
                    if (t.status == 'FREE')
                      Text('${t.seats} seats', style: TextStyle(color: st.fg))
                    else ...[
                      Text(inr(t.totalPaise), style: TextStyle(fontFamily: Sage.display, fontWeight: FontWeight.w700, fontSize: 18, color: st.fg)),
                      Text('${t.guests ?? '–'} guests · ${mins ?? 0} min · ${t.kotCount} KOT', style: TextStyle(fontSize: 12, color: st.fg)),
                      if (t.captainName != null) Text('Captain: ${t.captainName}', style: TextStyle(fontSize: 12, color: st.fg)),
                    ],
                  ]),
                ),
              ),
            );
          },
        ),
      ]),
    );
  }
}

class TakeawayView extends StatelessWidget {
  const TakeawayView({super.key});
  @override
  Widget build(BuildContext context) {
    final s = context.watch<AppState>();
    final open = s.openTakeaways;
    return ListView(padding: const EdgeInsets.all(16), children: [
      Wrap(spacing: 12, runSpacing: 12, children: [
        FilledButton.icon(
          icon: const Icon(Icons.shopping_bag),
          label: const Text('New takeaway'),
          onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const OrderScreen(channel: 'TAKEAWAY'))),
        ),
        FilledButton.tonalIcon(
          icon: const Icon(Icons.delivery_dining),
          label: const Text('New delivery'),
          onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const OrderScreen(channel: 'DELIVERY'))),
        ),
      ]),
      const SizedBox(height: 16),
      Text('On hold (not yet paid) on this device', style: Theme.of(context).textTheme.titleMedium),
      if (open.isEmpty) const Padding(padding: EdgeInsets.all(12), child: Text('None')),
      for (final o in open)
        Card(
          child: ListTile(
            leading: Icon(o.channel == 'DELIVERY' ? Icons.delivery_dining : Icons.shopping_bag_outlined),
            title: Text('${o.channel == 'DELIVERY' ? 'Delivery' : 'Takeaway'} · ${o.lines.length} items'),
            subtitle: Text(o.lines.map((l) => '${l.quantity}× ${l.name}').join(', '), maxLines: 1, overflow: TextOverflow.ellipsis),
            trailing: Text(inr(o.totals.total), style: const TextStyle(fontWeight: FontWeight.bold)),
            onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => OrderScreen(channel: o.channel, orderId: o.id))),
          ),
        ),
    ]);
  }
}
