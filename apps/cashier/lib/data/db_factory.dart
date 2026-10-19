// Picks the on-device database: a file on Android/iOS, IndexedDB when run in a browser.
export 'db_factory_io.dart' if (dart.library.js_interop) 'db_factory_web.dart';
