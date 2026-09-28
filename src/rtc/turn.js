"use strict";

// Facebook hands out TURN relay credentials for calls through a small endpoint
// the web client calls before creating its SDP offer. The captured request
// uses the fixed identifier `ZenonPlatform` (the credentials are not tied to a
// specific call):
//
//   POST /videocall/turndiscovery/?call_id=ZenonPlatform&version=1
//
// The reply carries relay entries with `turnIP`/`turnIP_6`,
// `udpPort`/`tcpPort`/`sslPort`, `turnUsername` and `turnPassword`; they are
// turned into WebRTC iceServers here. Calls still work without them when the
// peers can reach each other directly, so failures are non-fatal.

var log = require("npmlog");

// The web call window lives on messenger.com, but this library's session
// cookies belong to facebook.com, so try that host first (the endpoint answers
// "Log in to continue" when the session cookies are not sent).
var discoveryURLs = [
  "https://www.facebook.com/videocall/turndiscovery/",
  "https://www.messenger.com/videocall/turndiscovery/"
];
var defaultCallID = "ZenonPlatform";

function parseBody(body) {
  var text = String(body || "").trim();
  if (!text) return null;
  // Facebook's AsyncRequest responses start with a JSON-hijacking prefix.
  text = text.replace(/^for\s*\(\s*;;\s*\)\s*;/, "");
  try {
    var parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && parsed.payload !== undefined) {
      return parsed.payload;
    }
    return parsed;
  } catch (e) {
    log.verbose("call", "TURN discovery: reply is not JSON (" + text.slice(0, 120) + ")");
    return null;
  }
}

function entriesOf(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.turns)) return payload.turns;
  if (Array.isArray(payload.relayInfo && payload.relayInfo.turns)) return payload.relayInfo.turns;
  return [payload];
}

// The discovery reply uses `ip`/`ip_6`/`udp_port`/`tcp_port`/`tls_port`/
// `ssl_tcp_port`/`username`/`password`; the thrift RelayInfo uses camelCase
// and binary IPv4/IPv6 addresses.
function bufferToIp(value) {
  if (!value) return null;
  var bytes = null;
  if (Buffer.isBuffer(value)) bytes = value;
  else if (value && value.type === "Buffer" && Array.isArray(value.data)) bytes = Buffer.from(value.data);
  if (!bytes) return null;
  if (bytes.length === 4) return bytes[0] + "." + bytes[1] + "." + bytes[2] + "." + bytes[3];
  if (bytes.length === 16) {
    var groups = [];
    for (var i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
    return groups.join(":");
  }
  return null;
}

function hostOf(entry) {
  if (entry.ip) return String(entry.ip);
  if (entry.ip_6) return "[" + String(entry.ip_6) + "]";
  if (entry.turnIP) return String(entry.turnIP);
  if (entry.turnIP_6) return "[" + String(entry.turnIP_6) + "]";
  if (entry.host) return String(entry.host);
  var ipv4 = bufferToIp(entry.ipv4);
  if (ipv4) return ipv4;
  var ipv6 = bufferToIp(entry.ipv6);
  if (ipv6) return "[" + ipv6 + "]";
  return null;
}

function toIceServers(payload) {
  var servers = [];
  // The discovery reply carries the credentials per entry; the thrift
  // RelayInfo carries them once on the relayInfo itself.
  var payloadUsername = payload && (payload.username || payload.turnUsername);
  var payloadCredential = payload && (payload.password || payload.turnPassword || payload.credential);
  entriesOf(payload).forEach(function(entry) {
    if (!entry) return;
    var host = hostOf(entry);
    var username = entry.username || entry.turnUsername || payloadUsername;
    var credential = entry.password || entry.turnPassword || entry.credential || payloadCredential;
    if (!host || !username || !credential) return;
    var ports = [
      { port: entry.udp_port != null ? entry.udp_port : entry.udpPort, transport: "udp", scheme: "turn" },
      { port: entry.tcp_port != null ? entry.tcp_port : entry.tcpPort, transport: "tcp", scheme: "turn" },
      // `ssl_tcp_port` is plain TURN over TCP (works through firewalls that
      // block UDP); `tls_port` is TURN over TLS.
      {
        port: entry.ssl_tcp_port != null ? entry.ssl_tcp_port
          : (entry.sslTcpPort != null ? entry.sslTcpPort : entry.sslPort),
        transport: "tcp",
        scheme: "turn"
      },
      { port: entry.tls_port != null ? entry.tls_port : entry.tlsPort, transport: "tcp", scheme: "turns" }
    ];
    var seen = {};
    ports.forEach(function(candidate) {
      var port = Number(candidate.port);
      if (!port || seen[candidate.scheme + port]) return;
      seen[candidate.scheme + port] = true;
      servers.push({
        urls: candidate.scheme + ":" + host + ":" + port + "?transport=" + candidate.transport,
        username: String(username),
        credential: String(credential)
      });
    });
  });
  return servers;
}

// defaultFuncs: the library's request helpers (they carry the session cookies).
// options (all optional): `callId` (defaults to a random one), `version`,
// `params` (extra query parameters) and `headers`.
function fetchTurnCredentials(defaultFuncs, ctx, callback, options) {
  if (!defaultFuncs || !defaultFuncs.post) return callback(null, []);
  options = options || {};
  var callId = options.callId != null ? String(options.callId) : defaultCallID;
  var params = Object.assign({ call_id: callId, version: options.version != null ? options.version : 1 }, options.params || {});
  var query = Object.keys(params).map(function(key) {
    return encodeURIComponent(key) + "=" + encodeURIComponent(params[key]);
  }).join("&");

  function tryHost(index) {
    if (index >= discoveryURLs.length) {
      log.info("call", "Media: TURN discovery returned no usable relays");
      return callback(null, []);
    }
    var url = discoveryURLs[index] + "?" + query;
    defaultFuncs
      .post(url, ctx.jar, {}, options.headers ? { headers: options.headers } : undefined)
      .then(function(res) {
        log.verbose("call", "TURN discovery raw reply (" + url.split("/")[2] + "): " +
          String((res && res.body) || "").slice(0, 300));
        var servers = toIceServers(parseBody(res && res.body));
        if (servers.length) {
          log.info("call", "Media: got " + servers.length + " TURN relay(s) for the call");
          return callback(null, servers);
        }
        tryHost(index + 1);
      })
      .catch(function(err) {
        log.warn("call", "Media: TURN discovery failed: " + (err && err.message ? err.message : err));
        tryHost(index + 1);
      });
  }
  tryHost(0);
}

// werift uses a single TURN server (the first one), so let callers prefer a
// transport: "tcp" puts plain TURN-over-TCP first (works on networks that
// block UDP to Facebook, where the TURN relay tunnels the media), "tls" the
// TURN-over-TLS relays, "udp" keeps the default order.
function orderForTransport(servers, transport) {
  if (transport !== "tcp" && transport !== "tls") return servers;
  function rank(server) {
    var isTls = server.urls.indexOf("turns:") === 0;
    var isUdp = server.urls.indexOf("transport=udp") !== -1;
    if (transport === "tls") {
      if (isTls) return 0;
      if (!isUdp) return 1;
      return 2;
    }
    // "tcp": plain TCP first (prefer the 8080 relay), then UDP, then TLS.
    if (!isTls && !isUdp) return 0;
    if (isUdp) return 1;
    return 2;
  }
  return servers.slice().sort(function(a, b) { return rank(a) - rank(b); });
}

module.exports = {
  fetchTurnCredentials: fetchTurnCredentials,
  toIceServers: toIceServers,
  orderForTransport: orderForTransport,
  parseBody: parseBody
};
