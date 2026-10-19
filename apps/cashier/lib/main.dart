import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'app_state.dart';
import 'screens/home.dart';
import 'screens/login.dart';
import 'screens/shift.dart';
import 'theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(ChangeNotifierProvider(create: (_) => AppState()..init(), child: const CashierApp()));
}

class CashierApp extends StatelessWidget {
  const CashierApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Restaurant OS Cashier',
      debugShowCheckedModeBanner: false,
      theme: sageTheme(Brightness.light),
      darkTheme: sageTheme(Brightness.dark),
      themeMode: ThemeMode.light, // the reference design is light; dark stays available as a setting
      home: const _Gate(),
    );
  }
}

/// Signed out → login. No shift open → start shift. Otherwise the floor.
class _Gate extends StatelessWidget {
  const _Gate();
  @override
  Widget build(BuildContext context) {
    final s = context.watch<AppState>();
    if (!s.ready) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    if (s.user == null) return const LoginScreen();
    if (s.shift == null) return const StartShiftScreen();
    return const HomeScreen();
  }
}
