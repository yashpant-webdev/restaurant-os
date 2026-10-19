import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../app_state.dart';
import '../data/api.dart';
import '../data/models.dart';
import '../money.dart';
import '../widgets/common.dart';

/// Punch items, send KOTs, print the bill and settle.
/// Wide screens: categories | items | bill. Phones: items with a bill sheet.
class OrderScreen extends StatefulWidget {
  final String channel; // DINE_IN, TAKEAWAY, DELIVERY
  final String? tableRef, orderId;
  final int? seats;
  const OrderScreen({super.key, required this.channel, this.tableRef, this.orderId, this.seats});
  @override
  State<OrderScreen> createState() => _OrderScreenState();
}

class _OrderScreenState extends State<OrderScreen> {
  OrderView? order;
  final cart = <MenuItem, int>{};
  String? category;
  final search = TextEditingController();
  final searchFocus = FocusNode();
  bool loading = true;
  bool busy = false;
  final changes = ValueNotifier(0); // tells the phone bill sheet to redraw

  @override
  void setState(VoidCallback fn) {
    super.setState(fn);
    changes.value++;
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (widget.orderId != null) order = await context.read<AppState>().loadOrder(widget.orderId!);
    if (mounted) setState(() => loading = false);
  }

  String get title => switch (widget.channel) {
        'DINE_IN' => 'Table ${widget.tableRef}',
        'DELIVERY' => 'Delivery',
        _ => 'Takeaway',
      };

  void _add(MenuItem m, [int by = 1]) {
    if (!m.isAvailable) return toast(context, '${m.name} is sold out', error: true);
    setState(() {
      final q = (cart[m] ?? 0) + by;
      q <= 0 ? cart.remove(m) : cart[m] = q;
    });
  }

  /// Typing a short code and pressing Enter adds the item, the fastest way to bill.
  void _submitSearch(String text) {
    final m = context.read<AppState>().itemByCode(text);
    if (m != null) {
      _add(m);
      search.clear();
      setState(() {});
    } else if (text.trim().isNotEmpty) {
      toast(context, 'No item with code "${text.trim().toUpperCase()}"', error: true);
    }
    searchFocus.requestFocus();
  }

  Future<int?> _askGuests() async {
    var g = (widget.seats ?? 2).clamp(1, 4);
    return showDialog<int>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, set) => AlertDialog(
          title: Text('Guests at ${widget.tableRef}'),
          content: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            IconButton.filledTonal(onPressed: () => set(() => g = (g - 1).clamp(1, 50)), icon: const Icon(Icons.remove)),
            Padding(padding: const EdgeInsets.symmetric(horizontal: 24), child: Text('$g', style: Theme.of(c).textTheme.headlineMedium)),
            IconButton.filledTonal(onPressed: () => set(() => g = (g + 1).clamp(1, 50)), icon: const Icon(Icons.add)),
          ]),
          actions: [TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')), FilledButton(onPressed: () => Navigator.pop(c, g), child: const Text('Continue'))],
        ),
      ),
    );
  }

  Future<void> _kot({bool thenSettle = false}) async {
    if (cart.isEmpty || busy) return;
    final s = context.read<AppState>();
    int? guests;
    if (order == null && widget.channel == 'DINE_IN') {
      guests = await _askGuests();
      if (guests == null) return;
    }
    setState(() => busy = true);
    try {
      final kotItems = Map.of(cart);
      final o = await s.sendKot(existing: order, channel: widget.channel, tableRef: widget.tableRef, guests: guests, cart: kotItems);
      setState(() {
        order = o;
        cart.clear();
      });
      if (mounted) {
        await _showKot(o.kotCount, kotItems);
        if (thenSettle && mounted) await _settle();
      }
    } catch (e) {
      if (mounted) toast(context, e.toString(), error: true);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  /// KOT preview: what the kitchen printer receives (no prices). Printer drivers come next.
  Future<void> _showKot(int kotNo, Map<MenuItem, int> items) => showDialog(
        context: context,
        builder: (c) => AlertDialog(
          title: Text('KOT #$kotNo · $title'),
          content: SizedBox(
            width: 280,
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(TimeOfDay.now().format(c), style: Theme.of(c).textTheme.bodySmall),
              const Divider(),
              for (final e in items.entries) Text('${e.value} × ${e.key.name}', style: const TextStyle(fontSize: 18, fontFamily: 'monospace')),
              const Divider(),
              Text(context.read<AppState>().online ? 'Sent to the kitchen.' : 'Saved offline: the kitchen ticket prints here; the server gets it when the internet is back.',
                  style: Theme.of(c).textTheme.bodySmall),
            ]),
          ),
          actions: [FilledButton(onPressed: () => Navigator.pop(c), child: const Text('OK'))],
        ),
      );

  Future<void> _bill() async {
    final o = order;
    if (o == null) return;
    final agg = <String, ({int qty, int net})>{};
    for (final l in o.lines) {
      final a = agg[l.name];
      agg[l.name] = (qty: (a?.qty ?? 0) + l.quantity, net: (a?.net ?? 0) + l.netPaise);
    }
    await showDialog(
      context: context,
      builder: (c) => AlertDialog(
        title: Text('Bill · $title'),
        content: SizedBox(
          width: 320,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            for (final e in agg.entries) _kv('${e.value.qty} × ${e.key}', inr(e.value.net)),
            const Divider(),
            _kv('Subtotal', inr(o.totals.subtotal)),
            _kv('CGST', inr(o.totals.cgst)),
            _kv('SGST', inr(o.totals.sgst)),
            _kv('Round off', inr(o.totals.roundOff)),
            const Divider(),
            _kv('Total', inr(o.totals.total), bold: true),
            if (o.paidPaise > 0) _kv('Paid', inr(o.paidPaise)),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Close')),
          FilledButton.icon(
            icon: const Icon(Icons.print),
            label: const Text('Print bill'),
            onPressed: () {
              Navigator.pop(c);
              toast(context, 'Bill sent to the printer');
            },
          ),
        ],
      ),
    );
  }

  Future<void> _settle() async {
    if (order == null) return;
    final done = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => ChangeNotifierProvider.value(value: context.read<AppState>(), child: SettleSheet(order: order!)),
    );
    if (done == true && mounted) Navigator.pop(context);
    if (mounted && order != null) {
      final fresh = await context.read<AppState>().loadOrder(order!.id);
      if (mounted && fresh != null) setState(() => order = fresh);
    }
  }

  Future<void> _toggleSoldOut(MenuItem m) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(m.isAvailable ? 'Mark ${m.name} sold out?' : 'Back in stock: ${m.name}?'),
        content: Text(m.isAvailable ? 'It will be hidden from captains and online menus until you switch it back.' : 'Captains and online menus can order it again.'),
        actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')), FilledButton(onPressed: () => Navigator.pop(c, true), child: Text(m.isAvailable ? 'Sold out' : 'Available'))],
      ),
    );
    if (ok == true && mounted) await context.read<AppState>().setSoldOut(m, m.isAvailable);
  }

  @override
  Widget build(BuildContext context) {
    final s = context.watch<AppState>();
    final wide = MediaQuery.sizeOf(context).width >= 900;
    final cats = <String>{for (final m in s.menu) m.category}.toList();
    final q = search.text.trim().toLowerCase();
    final items = s.menu.where((m) => (category == null || m.category == category) && (q.isEmpty || m.name.toLowerCase().contains(q) || (m.shortCode?.toLowerCase().startsWith(q) ?? false))).toList();

    final searchBox = TextField(
      controller: search,
      focusNode: searchFocus,
      autofocus: wide,
      textCapitalization: TextCapitalization.characters,
      decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Item name or short code (e.g. CB) + Enter', border: OutlineInputBorder(), isDense: true),
      onChanged: (_) => setState(() {}),
      onSubmitted: _submitSearch,
    );

    final grid = GridView.builder(
      padding: const EdgeInsets.all(12),
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 200, mainAxisExtent: 92, crossAxisSpacing: 10, mainAxisSpacing: 10),
      itemCount: items.length,
      itemBuilder: (context, i) {
        final m = items[i];
        final inCart = cart[m] ?? 0;
        return Opacity(
          opacity: m.isAvailable ? 1 : 0.45,
          child: Material(
            color: inCart > 0 ? Theme.of(context).colorScheme.primaryContainer : Theme.of(context).colorScheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(10),
            child: InkWell(
              borderRadius: BorderRadius.circular(10),
              onTap: () => _add(m),
              onLongPress: () => _toggleSoldOut(m),
              child: Padding(
                padding: const EdgeInsets.all(10),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    FoodMark(m.foodType),
                    const SizedBox(width: 6),
                    Expanded(child: Text(m.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700))),
                    if (inCart > 0) CircleAvatar(radius: 11, child: Text('$inCart', style: const TextStyle(fontSize: 12))),
                  ]),
                  const Spacer(),
                  Row(children: [
                    Text(inr(m.pricePaise)),
                    const Spacer(),
                    Text(m.isAvailable ? (m.shortCode ?? '') : 'SOLD OUT', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: m.isAvailable ? Theme.of(context).colorScheme.outline : Colors.red)),
                  ]),
                ]),
              ),
            ),
          ),
        );
      },
    );

    final categoryList = wide
        ? SizedBox(
            width: 170,
            child: ListView(children: [
              for (final c in [null, ...cats])
                ListTile(
                  selected: category == c,
                  selectedTileColor: Theme.of(context).colorScheme.secondaryContainer,
                  title: Text(c ?? 'All items'),
                  onTap: () => setState(() => category = c),
                ),
            ]),
          )
        : SizedBox(
            height: 48,
            child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 8), children: [
              for (final c in [null, ...cats])
                Padding(padding: const EdgeInsets.all(4), child: ChoiceChip(label: Text(c ?? 'All'), selected: category == c, onSelected: (_) => setState(() => category = c))),
            ]),
          );

    Widget cartPanel() => _CartPanel(
      title: title,
      order: order,
      cart: cart,
      busy: busy,
      onAdd: _add,
      onKot: () => _kot(),
      onKotAndSettle: widget.channel == 'DINE_IN' ? null : () => _kot(thenSettle: true),
      onBill: _bill,
      onSettle: _settle,
    );

    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.f2): () => _kot(),
        const SingleActivator(LogicalKeyboardKey.f3): _bill,
        const SingleActivator(LogicalKeyboardKey.f4): _settle,
      },
      child: Scaffold(
        appBar: AppBar(title: Text(title), actions: [if (wide) const Padding(padding: EdgeInsets.only(right: 8), child: Center(child: Text('F2 KOT · F3 Bill · F4 Settle'))), const SyncChip(), const SizedBox(width: 8)]),
        body: loading
            ? const Center(child: CircularProgressIndicator())
            : wide
                ? Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    categoryList,
                    const VerticalDivider(width: 1),
                    Expanded(child: Column(children: [Padding(padding: const EdgeInsets.fromLTRB(12, 12, 12, 0), child: searchBox), Expanded(child: grid)])),
                    const VerticalDivider(width: 1),
                    SizedBox(width: 380, child: cartPanel()),
                  ])
                : Column(children: [
                    Padding(padding: const EdgeInsets.fromLTRB(12, 12, 12, 0), child: searchBox),
                    categoryList,
                    Expanded(child: grid),
                  ]),
        bottomNavigationBar: wide || loading
            ? null
            : SafeArea(
                child: Padding(
                  padding: const EdgeInsets.all(8),
                  child: FilledButton(
                    onPressed: () => showModalBottomSheet(
                      context: context,
                      isScrollControlled: true,
                      builder: (_) => SizedBox(height: MediaQuery.sizeOf(context).height * 0.8, child: ValueListenableBuilder(valueListenable: changes, builder: (_, _, _) => cartPanel())),
                    ).then((_) => setState(() {})),
                    child: Text('Bill · ${cart.values.fold(0, (a, b) => a + b)} new · ${inr((order?.totals.total ?? 0) + cart.entries.fold(0, (t, e) => t + e.key.pricePaise * e.value))}'),
                  ),
                ),
              ),
      ),
    );
  }
}

Widget _kv(String l, String v, {bool bold = false}) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(children: [Expanded(child: Text(l, style: TextStyle(fontWeight: bold ? FontWeight.w800 : null))), Text(v, style: TextStyle(fontWeight: bold ? FontWeight.w800 : null, fontSize: bold ? 18 : null))]),
    );

class _CartPanel extends StatelessWidget {
  final String title;
  final OrderView? order;
  final Map<MenuItem, int> cart;
  final bool busy;
  final void Function(MenuItem, [int]) onAdd;
  final VoidCallback onKot, onBill, onSettle;
  final VoidCallback? onKotAndSettle;
  const _CartPanel({required this.title, required this.order, required this.cart, required this.busy, required this.onAdd, required this.onKot, required this.onBill, required this.onSettle, this.onKotAndSettle});

  @override
  Widget build(BuildContext context) {
    final o = order;
    final byKot = <int, List<OrderLine>>{};
    for (final l in o?.lines ?? <OrderLine>[]) {
      (byKot[l.kotNo] ??= []).add(l);
    }
    final newTotals = BillTotals.fromLines([
      ...?o?.lines.map((l) => (net: l.netPaise, gstBp: l.gstRateBp)),
      for (final e in cart.entries) (net: e.key.pricePaise * e.value, gstBp: e.key.gstRateBp),
    ]);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      ListTile(
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.w800)),
        subtitle: Text([
          if (o?.guests != null) '${o!.guests} guests',
          if (o?.captainName != null) 'Captain ${o!.captainName}',
          if (o?.pendingSync == true) 'waiting to sync',
          if (o == null) 'New order',
        ].join(' · ')),
      ),
      const Divider(height: 1),
      Expanded(
        child: ListView(padding: const EdgeInsets.symmetric(horizontal: 12), children: [
          for (final e in byKot.entries) ...[
            Padding(padding: const EdgeInsets.only(top: 8), child: Text('KOT #${e.key} · sent', style: Theme.of(context).textTheme.labelSmall)),
            for (final l in e.value) _kv('${l.quantity} × ${l.name}', inr(l.netPaise)),
          ],
          if (cart.isNotEmpty) ...[
            Padding(padding: const EdgeInsets.only(top: 12), child: Text('New (not sent to kitchen)', style: Theme.of(context).textTheme.labelSmall?.copyWith(color: Theme.of(context).colorScheme.primary))),
            for (final e in cart.entries)
              Row(children: [
                Expanded(child: Text(e.key.name)),
                IconButton(visualDensity: VisualDensity.compact, onPressed: () => onAdd(e.key, -1), icon: const Icon(Icons.remove_circle_outline)),
                Text('${e.value}'),
                IconButton(visualDensity: VisualDensity.compact, onPressed: () => onAdd(e.key), icon: const Icon(Icons.add_circle_outline)),
                SizedBox(width: 72, child: Text(inr(e.key.pricePaise * e.value), textAlign: TextAlign.right)),
              ]),
          ],
          if (o == null && cart.isEmpty) const Padding(padding: EdgeInsets.all(24), child: Text('Tap items or type a short code to start.', textAlign: TextAlign.center)),
        ]),
      ),
      const Divider(height: 1),
      Padding(
        padding: const EdgeInsets.all(12),
        child: Column(children: [
          _kv('Subtotal', inr(newTotals.subtotal)),
          _kv('GST (CGST + SGST)', inr(newTotals.cgst + newTotals.sgst)),
          _kv('Total', inr(newTotals.total), bold: true),
          if ((o?.paidPaise ?? 0) > 0) _kv('Paid', inr(o!.paidPaise)),
          const SizedBox(height: 10),
          // The action dock.
          Row(children: [
            Expanded(child: FilledButton.icon(onPressed: cart.isEmpty || busy ? null : onKot, icon: const Icon(Icons.receipt_long), label: const Text('KOT'))),
            const SizedBox(width: 8),
            Expanded(child: OutlinedButton.icon(onPressed: o == null || cart.isNotEmpty ? null : onBill, icon: const Icon(Icons.print), label: const Text('Bill'))),
          ]),
          const SizedBox(height: 8),
          if (onKotAndSettle != null && cart.isNotEmpty)
            SizedBox(width: double.infinity, child: FilledButton.tonalIcon(onPressed: busy ? null : onKotAndSettle, icon: const Icon(Icons.bolt), label: const Text('KOT & settle')))
          else
            SizedBox(
              width: double.infinity,
              child: FilledButton.tonalIcon(onPressed: o == null || cart.isNotEmpty || o.status != 'OPEN' ? null : onSettle, icon: const Icon(Icons.payments), label: const Text('Settle')),
            ),
          if (cart.isNotEmpty && o != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Send the new items to the kitchen before billing.', style: Theme.of(context).textTheme.bodySmall)),
        ]),
      ),
    ]);
  }
}

/// Take payment: cash (works offline, shows change), UPI (needs internet), or several in a row.
class SettleSheet extends StatefulWidget {
  final OrderView order;
  const SettleSheet({super.key, required this.order});
  @override
  State<SettleSheet> createState() => _SettleSheetState();
}

class _SettleSheetState extends State<SettleSheet> {
  late OrderView o = widget.order;
  late final cash = TextEditingController(text: (o.duePaise / 100).toStringAsFixed(0));
  Map<String, dynamic>? upi;
  bool busy = false;

  int get due => o.duePaise;

  Future<void> _run(Future<void> Function() f) async {
    setState(() => busy = true);
    try {
      await f();
    } on ApiError catch (e) {
      if (mounted) toast(context, e.message, error: true);
    } catch (e) {
      if (mounted) toast(context, e.toString(), error: true);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = context.read<AppState>();
    final received = rupeesToPaise(cash.text) ?? 0;
    final take = received.clamp(0, due);
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
      child: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Settle · ${o.tableRef ?? (o.channel == 'DELIVERY' ? 'Delivery' : 'Takeaway')}', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 8),
          _kv('Bill total', inr(o.totals.total)),
          if (o.paidPaise > 0) _kv('Already paid', inr(o.paidPaise)),
          _kv(due == 0 ? 'Fully paid' : 'Due', inr(due), bold: true),
          const SizedBox(height: 16),
          if (due == 0)
            FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Done'))
          else if (upi != null) ...[
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(children: [
                  const Icon(Icons.qr_code_2, size: 120),
                  Text('Customer scans to pay ${inr(upi!['amountPaise'])}', style: const TextStyle(fontWeight: FontWeight.bold)),
                  Text('Razorpay order ${(upi!['checkout'] as Map?)?['gatewayOrderId'] ?? ''}', style: Theme.of(context).textTheme.bodySmall),
                  const SizedBox(height: 12),
                  FilledButton(
                    onPressed: busy
                        ? null
                        : () => _run(() async {
                              await s.simulateUpiPaid((upi!['checkout'] as Map)['gatewayOrderId'], upi!['amountPaise']);
                              await Future.delayed(const Duration(milliseconds: 800));
                              final fresh = await s.loadOrder(o.id);
                              setState(() {
                                if (fresh != null) o = fresh;
                                upi = null;
                              });
                              await s.sync();
                            }),
                    child: const Text('Customer paid (demo)'),
                  ),
                ]),
              ),
            ),
          ] else ...[
            Text('Cash', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 6),
            TextField(controller: cash, keyboardType: TextInputType.number, decoration: const InputDecoration(prefixText: '₹ ', labelText: 'Cash received', border: OutlineInputBorder()), onChanged: (_) => setState(() {})),
            const SizedBox(height: 6),
            Wrap(spacing: 8, children: [
              for (final n in [due ~/ 100, 500, 1000, 2000].where((n) => n * 100 >= due).toSet())
                ActionChip(label: Text(n * 100 == due ? 'Exact' : '₹$n'), onPressed: () => setState(() => cash.text = '${n == due ~/ 100 ? (due / 100).toStringAsFixed(0) : n}')),
            ]),
            if (received > due) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Return change: ${inr(received - due)}', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16))),
            const SizedBox(height: 10),
            FilledButton.icon(
              icon: const Icon(Icons.payments),
              label: Text(take < due ? 'Take ${inr(take)} cash (part)' : 'Take cash ${inr(due)}'),
              onPressed: busy || take <= 0
                  ? null
                  : () => _run(() async {
                        o = await s.payCash(o, take);
                        cash.text = (o.duePaise / 100).toStringAsFixed(0);
                        if (mounted && o.duePaise == 0) toast(context, received > take ? 'Settled. Return ${inr(received - take)} change' : 'Settled');
                      }),
            ),
            const SizedBox(height: 16),
            OutlinedButton.icon(
              icon: const Icon(Icons.qr_code),
              label: Text('UPI ${inr(due)}'),
              onPressed: busy
                  ? null
                  : () => _run(() async {
                        final r = await s.startUpi(o, due);
                        setState(() => upi = r);
                      }),
            ),
            if (!s.online) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Offline: UPI needs internet. Cash works.', style: TextStyle(color: Colors.orange.shade300))),
          ],
        ]),
      ),
    );
  }
}
