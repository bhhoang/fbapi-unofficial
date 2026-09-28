"use strict";
/* global WebAssembly */

// Runs Meta's frame_encryption.wasm in Node and prints the generated
// `x-dtls-auth` value for a DTLS fingerprint.
//
// This file is spawned as a child process by src/rtc/dtlsAuth.js, because
// creating wasm callbacks from JS needs the
// `--experimental-wasm-type-reflection` flag (WebAssembly.Function), which
// cannot be enabled inside an already running process.
//
// Input (argv[2]): JSON { wasmPath, fingerprint, identityKeyPub, identityKeyPriv, userId, deviceId }
// Output (stdout): JSON { value } or { error }

var fs = require("fs");

function fail(message) {
  process.stdout.write(JSON.stringify({ error: message }));
  process.exit(0);
}

function makeImports(memory) {
  var noop = function() {};
  var env = {
    memory: memory,
    abort: function() { throw new Error("wasm abort"); },
    __cxa_throw: function() { throw new Error("wasm cxa_throw"); },
    __cxa_increment_exception_refcount: noop,
    __cxa_decrement_exception_refcount: noop,
    __cxa_is_pointer_type: function() { return 0; },
    setThrew: noop,
    strftime: function() { return 0; },
    strftime_l: function() { return 0; },
    _localtime_js: function() { return 0; },
    _tzset_js: function() { return 0; },
    emscripten_date_now: function() { return Date.now(); },
    emscripten_get_now: function() { return Date.now(); },
    _emscripten_get_now_is_monotonic: function() { return 1; },
    emscripten_get_heap_max: function() { return 2147483648; },
    emscripten_resize_heap: function(requested) {
      var current = memory.buffer.byteLength;
      if (requested <= current) return 1;
      try {
        memory.grow(Math.ceil((requested - current) / 65536));
        return 1;
      } catch (e) {
        return 0;
      }
    },
    emscripten_builtin_memalign: function() { return 0; },
    ntohs: function(v) { return ((v & 0xff) << 8) | ((v >> 8) & 0xff); },
    htons: function(v) { return ((v & 0xff) << 8) | ((v >> 8) & 0xff); },
    htonl: function(v) {
      return ((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >> 8) & 0xff00) | ((v >> 24) & 0xff);
    },
    __errno_location: function() { return 0; },
    __getTypeName: function() { return 0; },
    fflush: function() { return 0; },
    _embind_initialize_bindings: noop
  };
  [
    "_embind_register_void", "_embind_register_bool", "_embind_register_std_string",
    "_embind_register_std_wstring", "_embind_register_emval", "_embind_register_integer",
    "_embind_register_bigint", "_embind_register_float", "_embind_register_memory_view"
  ].forEach(function(name) { env[name] = noop; });
  [
    "__syscall_fcntl64", "__syscall_ioctl", "__syscall_openat", "__syscall_fstat64",
    "__syscall_stat64", "__syscall_lstat64", "__syscall_newfstatat", "__syscall_getdents64"
  ].forEach(function(name) { env[name] = function() { return -1; }; });

  return {
    env: env,
    wasi_snapshot_preview1: {
      environ_sizes_get: function() { return 0; },
      environ_get: function() { return 0; },
      fd_close: function() { return 0; },
      fd_read: function() { return 0; },
      fd_write: function() { return 0; },
      fd_sync: function() { return 0; },
      fd_seek: function() { return 0; }
    }
  };
}

function run(input) {
  if (typeof WebAssembly.Function !== "function") {
    return fail("WebAssembly.Function unavailable (needs --experimental-wasm-type-reflection)");
  }

  var wasmBytes;
  try {
    wasmBytes = fs.readFileSync(input.wasmPath);
  } catch (e) {
    return fail("cannot read the frame_encryption wasm: " + e.message);
  }

  var memory = new WebAssembly.Memory({ initial: 87, maximum: 32768 });
  return WebAssembly.instantiate(wasmBytes, makeImports(memory)).then(function(result) {
    return generate(result.instance.exports, input, memory);
  }).catch(function(e) {
    fail("wasm call failed: " + (e && e.message ? e.message : e));
  });
}

function generate(wasm, input, memory) {
  wasm.__wasm_call_ctors();
  wasm.emscripten_stack_init();
  wasm._embind_initialize_bindings();

  var HEAPU8 = new Uint8Array(memory.buffer);
  function refresh() { HEAPU8 = new Uint8Array(memory.buffer); }
  function writeBytes(bytes) {
    var ptr = wasm.malloc(bytes.length);
    refresh();
    HEAPU8.set(bytes, ptr);
    return { ptr: ptr, len: bytes.length };
  }
  function writeString(str) { return writeBytes(Buffer.from(str, "utf8")); }
  function readString(ptr, len) {
    refresh();
    return Buffer.from(HEAPU8.subarray(ptr, ptr + len)).toString("utf8");
  }

  var table = wasm.__indirect_function_table;
  function addFunction(params, results, fn) {
    var wasmFn = new WebAssembly.Function({ parameters: params, results: results }, fn);
    var slot = table.length;
    table.grow(1);
    table.set(slot, wasmFn);
    return slot;
  }
  var cbI = function(fn) { return addFunction([], ["i32"], fn); };
  var cbV = function(params, fn) { return addFunction(params, [], fn); };

  var identityPub = Buffer.from(input.identityKeyPub, "base64");
  // Signal's serialized public key is the 33-byte 0x05-prefixed form.
  if (identityPub.length === 32) {
    identityPub = Buffer.concat([Buffer.from([5]), identityPub]);
  }
  var identityPriv = Buffer.from(input.identityKeyPriv, "base64");

  try {
    var deps = wasm.proxyIdentityStoreDeps_create();
    // Logging callbacks are called with (severity, textPtr, textLen).
    var logCb = cbV(["i32", "i32", "i32"], function() {});

    wasm.proxyIdentityStoreDeps_setGetLocalPublicPrivateIdentityKeyCallback(deps, cbI(function() {
      var pub = writeBytes(identityPub);
      var priv = writeBytes(identityPriv);
      var key = wasm.identityKey_create(pub.ptr, pub.len, priv.ptr, priv.len);
      wasm.free(pub.ptr);
      wasm.free(priv.ptr);
      return key;
    }), logCb);

    wasm.proxyIdentityStoreDeps_setGetRemotePublicIdentityKeyCallback(deps,
      addFunction(["i32", "i32", "i32"], ["i32"], function() {
        var empty = writeBytes(Buffer.alloc(0));
        var key = wasm.publicKey_create(empty.ptr, 0);
        wasm.free(empty.ptr);
        return key;
      }), logCb);

    wasm.proxyIdentityStoreDeps_setSaveRemotePublicIdentityKeyCallback(deps,
      addFunction(["i32", "i32", "i32", "i32", "i32"], ["i32"], function() { return 0; }), logCb);

    wasm.proxyIdentityStoreDeps_setGetLocalDeviceIdCallback(deps, cbI(function() {
      return Number(input.deviceId) || 0;
    }), logCb);

    var userBuf = writeString(String(input.userId || ""));
    wasm.proxyIdentityStoreDeps_setLocalUserId(deps, userBuf.ptr, userBuf.len);
    wasm.free(userBuf.ptr);
    wasm.proxyIdentityStoreDeps_setLocalIdentityKeyMode(deps, 2);

    var ctx = wasm.e2eeContext_create(0, logCb, cbV(["i32"], function() {}), deps);
    wasm.proxyIdentityStoreDeps_free(deps);
    if (!ctx) return fail("could not create the E2EE context");

    var manager = wasm.dtlsAuthenticationManager_create(ctx);
    if (!manager) return fail("could not create the DTLS authentication manager");

    var algo = "sha-256";
    var digest = input.fingerprint; // the colon-separated SDP fingerprint
    var fp = wasm.dtlsFingerprint_create(Buffer.byteLength(algo), Buffer.byteLength(digest));
    refresh();
    HEAPU8.set(Buffer.from(algo, "utf8"), wasm.dtlsFingerprint_getAlgoDataPtr(fp));
    HEAPU8.set(Buffer.from(digest, "utf8"), wasm.dtlsFingerprint_getDigestDataPtr(fp));

    var result = wasm.dtlsAuthenticationManager_generateAuthenticationInfo(manager, fp);
    var succeeded = wasm.dtlsAuthenticatorGenerateResult_succeeded(result);
    var value = null;
    if (succeeded === 1) {
      value = readString(
        wasm.dtlsAuthenticatorGenerateResult_getDataPtr(result),
        wasm.dtlsAuthenticatorGenerateResult_getDataSize(result)
      );
    }
    wasm.dtlsFingerprint_free(fp);
    if (!value) return fail("the wasm did not produce an authentication value");

    process.stdout.write(JSON.stringify({ value: value }));
    process.exit(0);
  } catch (e) {
    return fail("wasm call failed: " + (e && e.message ? e.message : e));
  }
}

var input;
try {
  input = JSON.parse(process.argv[2]);
} catch (e) {
  fail("invalid runner input");
}
if (input) {
  run(input);
}
