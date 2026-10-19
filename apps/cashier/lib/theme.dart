import 'package:flutter/material.dart';

/// Design system shared with the web dashboard: soft sage surfaces, near-black ink,
/// black pill actions, large radii, a thin dark outline on the focused card,
/// Syne (wide geometric) for headings and numbers, Manrope for everything else.
class Sage {
  static const page = Color(0xFFE8EFE5);
  static const card = Color(0xFFB3D8AD);
  static const inner = Color(0xFFC6E3C1);
  static const ink = Color(0xFF0E130E);
  static const muted = Color(0xFF3A4A39);
  static const good = Color(0xFF17692E);
  static const warn = Color(0xFF8A5A00);
  static const bad = Color(0xFFA52A1C);

  // Dark variant: same hues stepped for a dark surface.
  static const darkPage = Color(0xFF0D120D);
  static const darkCard = Color(0xFF1B2A1A);
  static const darkInner = Color(0xFF243723);
  static const darkInk = Color(0xFFE6F2E2);

  static const radiusCard = 24.0;
  static const radiusInner = 16.0;
  static const display = 'Syne';
  static const body = 'Manrope';
}

ThemeData sageTheme(Brightness b) {
  final dark = b == Brightness.dark;
  final ink = dark ? Sage.darkInk : Sage.ink;
  final page = dark ? Sage.darkPage : Sage.page;
  final card = dark ? Sage.darkCard : Sage.card;
  final inner = dark ? Sage.darkInner : Sage.inner;
  // Primary action: black pill on light, sage pill on dark.
  final primary = dark ? Sage.card : Sage.ink;
  final onPrimary = dark ? Sage.ink : Colors.white;

  final scheme = ColorScheme(
    brightness: b,
    primary: primary,
    onPrimary: onPrimary,
    primaryContainer: inner,
    onPrimaryContainer: ink,
    secondary: ink,
    onSecondary: page,
    secondaryContainer: inner,
    onSecondaryContainer: ink,
    surface: page,
    onSurface: ink,
    surfaceContainerHighest: card,
    surfaceContainerHigh: card,
    surfaceContainer: card,
    surfaceContainerLow: inner,
    onSurfaceVariant: dark ? const Color(0xFFA7BBA4) : Sage.muted,
    outline: ink.withValues(alpha: 0.5),
    outlineVariant: ink.withValues(alpha: 0.16),
    error: Sage.bad,
    onError: Colors.white,
  );

  TextStyle d(double size, FontWeight w) => TextStyle(fontFamily: Sage.display, fontSize: size, fontWeight: w, color: ink, letterSpacing: -0.2);
  final base = ThemeData(useMaterial3: true, colorScheme: scheme, fontFamily: Sage.body).textTheme;
  final text = base.copyWith(
    displaySmall: d(34, FontWeight.w700),
    headlineMedium: d(28, FontWeight.w700),
    headlineSmall: d(24, FontWeight.w700),
    titleLarge: d(20, FontWeight.w700),
    titleMedium: base.titleMedium?.copyWith(fontWeight: FontWeight.w700),
  );
  final pill = WidgetStatePropertyAll<OutlinedBorder>(const StadiumBorder());

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: page,
    fontFamily: Sage.body,
    textTheme: text,
    appBarTheme: AppBarTheme(backgroundColor: page, foregroundColor: ink, elevation: 0, scrolledUnderElevation: 0, titleTextStyle: d(22, FontWeight.w700)),
    cardTheme: CardThemeData(color: card, elevation: 0, margin: const EdgeInsets.symmetric(vertical: 5), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Sage.radiusCard))),
    filledButtonTheme: FilledButtonThemeData(
      style: ButtonStyle(shape: pill, padding: const WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: 22, vertical: 16)), textStyle: const WidgetStatePropertyAll(TextStyle(fontFamily: Sage.body, fontWeight: FontWeight.w700, fontSize: 15))),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: ButtonStyle(
        shape: pill,
        foregroundColor: WidgetStatePropertyAll(ink),
        side: WidgetStatePropertyAll(BorderSide(color: ink, width: 1.5)),
        padding: const WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: 20, vertical: 15)),
        textStyle: const WidgetStatePropertyAll(TextStyle(fontFamily: Sage.body, fontWeight: FontWeight.w700)),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: inner,
      contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(Sage.radiusInner), borderSide: BorderSide.none),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(Sage.radiusInner), borderSide: BorderSide.none),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(Sage.radiusInner), borderSide: BorderSide(color: ink, width: 1.5)),
    ),
    chipTheme: ChipThemeData(backgroundColor: inner, selectedColor: primary, labelStyle: TextStyle(fontWeight: FontWeight.w600, color: ink), secondaryLabelStyle: TextStyle(color: onPrimary, fontWeight: FontWeight.w700), shape: const StadiumBorder(), side: BorderSide.none, checkmarkColor: onPrimary),
    navigationRailTheme: NavigationRailThemeData(backgroundColor: page, indicatorColor: primary, selectedIconTheme: IconThemeData(color: onPrimary), selectedLabelTextStyle: TextStyle(fontWeight: FontWeight.w700, color: ink)),
    navigationBarTheme: NavigationBarThemeData(backgroundColor: card, indicatorColor: primary, iconTheme: WidgetStateProperty.resolveWith((s) => IconThemeData(color: s.contains(WidgetState.selected) ? onPrimary : ink))),
    bottomSheetTheme: BottomSheetThemeData(backgroundColor: card, shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Sage.radiusCard)))),
    dialogTheme: DialogThemeData(backgroundColor: card, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Sage.radiusCard))),
    snackBarTheme: SnackBarThemeData(backgroundColor: primary, contentTextStyle: TextStyle(color: onPrimary, fontWeight: FontWeight.w600), shape: const StadiumBorder()),
    dividerTheme: DividerThemeData(color: ink.withValues(alpha: 0.16)),
    listTileTheme: ListTileThemeData(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Sage.radiusInner))),
  );
}
