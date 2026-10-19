import 'package:path_provider/path_provider.dart';
import 'package:sembast/sembast_io.dart';

Future<Database> openLocalDatabase() async {
  final dir = await getApplicationSupportDirectory();
  return databaseFactoryIo.openDatabase('${dir.path}/cashier.db');
}
