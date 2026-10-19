import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

class ApiError implements Exception {
  final int status;
  final String code, message;
  final Map<String, dynamic>? details;
  ApiError(this.status, this.code, this.message, [this.details]);
  bool get isRetryable => status == 429 || status >= 500;
  @override
  String toString() => message;
}

/// The network is down or the server didn't answer in time: keep the change and try later.
class OfflineError implements Exception {
  @override
  String toString() => 'No connection to the server';
}

/// Where the backend runs. On an Android emulator the Mac is 10.0.2.2; on a real
/// tablet it's the Mac's Wi-Fi IP; in a browser it's localhost.
class ServerConfig {
  String host;
  ServerConfig(this.host);
  String get demoUrl => 'http://$host:4000';
  String get orderUrl => 'http://$host:4001';
  String get paymentUrl => 'http://$host:4002';
}

/// Thin HTTP client: JSON, bearer token, a short timeout, typed errors.
/// A 401 renews the token once (tokens expire) and retries.
class Api {
  final ServerConfig server;
  String? token;
  Future<String?> Function()? renewToken;
  final _client = http.Client();

  Api(this.server);

  Future<dynamic> send(String method, String url, {Object? body, Map<String, String>? headers, bool retried = false}) async {
    final req = http.Request(method, Uri.parse(url))
      ..headers.addAll({if (body != null) 'content-type': 'application/json', if (token != null) 'authorization': 'Bearer $token', ...?headers});
    if (body != null) req.body = jsonEncode(body);
    http.Response res;
    try {
      res = await http.Response.fromStream(await _client.send(req).timeout(const Duration(seconds: 8)));
    } on TimeoutException {
      throw OfflineError();
    } catch (_) {
      throw OfflineError();
    }
    if (res.statusCode == 401 && !retried && renewToken != null) {
      token = await renewToken!();
      return send(method, url, body: body, headers: headers, retried: true);
    }
    final data = res.body.isEmpty ? null : jsonDecode(utf8.decode(res.bodyBytes));
    if (res.statusCode >= 400) {
      final e = (data is Map ? data['error'] : null) as Map?;
      throw ApiError(res.statusCode, e?['code'] ?? 'HTTP_${res.statusCode}', e?['message'] ?? 'Request failed (${res.statusCode})', e?['details'] is Map ? Map<String, dynamic>.from(e!['details']) : null);
    }
    return data;
  }

  Future<dynamic> get(String url) => send('GET', url);
}
