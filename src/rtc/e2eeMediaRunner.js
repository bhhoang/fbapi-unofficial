"use strict";
/* global WebAssembly */

// Hosts Meta's frame_encryption.wasm call-E2EE stack for one call: the
// encryption-keys manager (session-key negotiation over the signaling
// channel) plus the SFrame frame encryptor/decryptor.
//
// This file is spawned as a child process by src/rtc/e2eeMedia.js, because
// creating wasm callbacks from JS needs the
// `--experimental-wasm-type-reflection` flag (WebAssembly.Function), which
// cannot be enabled inside an already running process. The parent talks to it
// over the Node IPC channel:
//
//   parent -> child: { t: "remoteKeys", keys }        add remote identity keys
//                    { t: "serverState", data }       E2eeState from the JOIN
//                    { t: "e2eeMessage", data }       E2eeKey DATA_MESSAGE
//                    { t: "setLocalE2eeId", id }      "<userId>:<local cname>"
//                    { t: "setRemoteE2eeId", id }     remote media cname
//                    { t: "encrypt", id, data }       encrypt one encoded frame
//                    { t: "decrypt", id, data }       decrypt one encoded frame
//                    { t: "close" }
//   child -> parent: { t: "ready" }
//                    { t: "sendE2eeKey", to, data }   send an E2eeKey DATA_MESSAGE
//                    { t: "frame", id, dir, errorCode, data }
//                    { t: "serverUpdate", ... }       negotiation result
//                    { t: "messageResult", ... }      E2eeKey processing result
//                    { t: "remoteIdentityKey", ... }  learned peer identity key
//                    { t: "log", message } / { t: "error", message }
//
// All byte payloads are base64 so the IPC messages stay JSON.

var fs = require("fs");

function send(message) {
  if (process.send) process.send(message);
}

function fail(message) {
  send({ t: "error", message: message });
  process.exit(0);
}

function makeImports(memory) {
  var noop = function() {};
  // The wasm opens /dev/urandom (and friends) for its CSPRNG; the emscripten
  // glue serves those from a virtual random device. Without it the key
  // negotiation fails with a wasm trap.
  var RANDOM_FD = 3;
  function heapU8() { return new Uint8Array(memory.buffer); }
  function readCString(ptr) {
    var heap = heapU8();
    var end = ptr;
    while (end < heap.length && heap[end] !== 0 && end - ptr < 256) end++;
    return Buffer.from(heap.subarray(ptr, end)).toString("utf8");
  }
  var env = {
    memory: memory,
    abort: function() { throw new Error("wasm abort"); },
    // C++ exception catching is disabled in this build: the glue records the
    // exception and continues, it does not raise a JS error.
    __cxa_throw: function() {},
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
    "__syscall_fcntl64", "__syscall_ioctl", "__syscall_fstat64",
    "__syscall_stat64", "__syscall_lstat64", "__syscall_newfstatat", "__syscall_getdents64"
  ].forEach(function(name) { env[name] = function() { return -1; }; });
  env.__syscall_fstat64 = function() { return 0; };
  env.__syscall_openat = function(dirfd, pathPtr) {
    var path = readCString(pathPtr);
    if (path === "/dev/urandom" || path === "/dev/random" ||
      path === "/dev/srandom" || path === "/dev/hwrng") {
      return RANDOM_FD;
    }
    return -1;
  };

  return {
    env: env,
    wasi_snapshot_preview1: {
      environ_sizes_get: function() { return 0; },
      environ_get: function() { return 0; },
      fd_close: function() { return 0; },
      fd_read: function(fd, iovPtr, iovcnt, numPtr) {
        if (fd !== RANDOM_FD) return -1;
        var heap = heapU8();
        var total = 0;
        var view = new DataView(memory.buffer);
        for (var i = 0; i < iovcnt; i++) {
          var buf = view.getUint32(iovPtr + i * 8, true);
          var len = view.getUint32(iovPtr + i * 8 + 4, true);
          if (!buf || !len) continue;
          var bytes = require("crypto").randomBytes(len);
          heap.set(bytes, buf);
          total += len;
        }
        view.setUint32(numPtr, total, true);
        return 0;
      },
      fd_write: function() { return 0; },
      fd_sync: function() { return 0; },
      fd_seek: function() { return 0; }
    }
  };
}

// Wraps every import so a trace of the wasm's host calls is available
// (E2EE_TRACE=1).
function traceImports(imports, memory) {
  Object.keys(imports).forEach(function(moduleName) {
    var moduleImports = imports[moduleName];
    Object.keys(moduleImports).forEach(function(name) {
      var original = moduleImports[name];
      if (typeof original !== "function") return;
      moduleImports[name] = function() {
        var extra = "";
        if (name === "__syscall_openat") {
          try {
            var heap = new Uint8Array(memory.buffer);
            var ptr = arguments[1];
            var end = ptr;
            while (end < heap.length && heap[end] !== 0 && end - ptr < 200) end++;
            extra = " path=" + Buffer.from(heap.subarray(ptr, end)).toString("utf8");
          } catch (e) { /* ignore */ }
        }
        send({ t: "log", message: "import " + name + "(" +
          Array.prototype.slice.call(arguments).join(",") + ")" + extra });
        return original.apply(this, arguments);
      };
    });
  });
  return imports;
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
  var imports = makeImports(memory);
  if (process.env.E2EE_TRACE) traceImports(imports, memory);
  return WebAssembly.instantiate(wasmBytes, imports).then(function(result) {
    try {
      main(result.instance.exports, input, memory);
    } catch (e) {
      fail("wasm call failed: " + (e && e.message ? e.message : e));
    }
  }).catch(function(e) {
    fail("wasm instantiation failed: " + (e && e.message ? e.message : e));
  });
}

function main(wasm, input, memory) {
  wasm.__wasm_call_ctors();
  wasm.emscripten_stack_init();
  wasm._embind_initialize_bindings();

  var heap = new Uint8Array(memory.buffer);
  function refresh() { heap = new Uint8Array(memory.buffer); }
  function alloc(bytes) {
    var ptr = wasm.malloc(bytes.length);
    refresh();
    heap.set(bytes, ptr);
    return ptr;
  }
  function allocZeros(size) {
    var ptr = wasm.malloc(size);
    refresh();
    heap.fill(0, ptr, ptr + size);
    return ptr;
  }
  function allocString(str) {
    return alloc(Buffer.from(str, "utf8"));
  }
  function readBytes(ptr, len) {
    refresh();
    return Buffer.from(heap.subarray(ptr, ptr + len));
  }
  function readString(ptr, len) {
    return readBytes(ptr, len).toString("utf8");
  }
  function readI32(ptr) {
    return new DataView(memory.buffer).getInt32(ptr, true);
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
  // Logging callbacks are called with (severity, textPtr, textLen).
  var logCb = cbV(["i32", "i32", "i32"], function(severity, ptr, len) {
    mark("log");
    try { send({ t: "log", message: readString(ptr, len) }); } catch (e) { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // Identity store (same shape as src/rtc/dtlsAuthRunner.js)
  // -------------------------------------------------------------------------

  var identityPub = Buffer.from(input.identityKeyPub, "base64");
  if (identityPub.length === 32) identityPub = Buffer.concat([Buffer.from([5]), identityPub]);
  var identityPriv = Buffer.from(input.identityKeyPriv, "base64");

  var remoteKeys = {};
  Object.keys(input.remoteKeys || {}).forEach(function(addr) {
    var key = Buffer.from(input.remoteKeys[addr], "base64");
    if (key.length === 32) key = Buffer.concat([Buffer.from([5]), key]);
    remoteKeys[addr] = key;
  });

  var localUserId = String(input.userId || "");
  var localDeviceId = Number(input.deviceId) || 0;

  // Diagnostics: remember the last wasm -> JS callback so a wasm trap can be
  // attributed to the callback that triggered it.
  var lastCallback = "(none)";
  function mark(name) {
    lastCallback = name;
    if (process.env.E2EE_TRACE) send({ t: "log", message: "callback " + name });
  }

  var deps = wasm.proxyIdentityStoreDeps_create();
  wasm.proxyIdentityStoreDeps_setGetLocalPublicPrivateIdentityKeyCallback(deps, cbI(function() {
    mark("getLocalPublicPrivateIdentityKey");
    var pub = alloc(identityPub);
    var priv = alloc(identityPriv);
    var key = wasm.identityKey_create(pub, identityPub.length, priv, identityPriv.length);
    wasm.free(pub);
    wasm.free(priv);
    return key;
  }), logCb);

  wasm.proxyIdentityStoreDeps_setGetRemotePublicIdentityKeyCallback(deps,
    addFunction(["i32", "i32", "i32"], ["i32"], function(ptr, len, deviceId) {
      var userId = readString(ptr, len);
      mark("getRemotePublicIdentityKey " + userId + ":" + deviceId);
      var key = remoteKeys[userId + ":" + deviceId];
      // The server state also lists this client's own endpoint; the identity
      // store answers with the local identity key for it.
      if (!key && userId === localUserId && Number(deviceId) === localDeviceId) key = identityPub;
      if (!key) key = Buffer.alloc(0);
      var buf = alloc(key);
      var out = wasm.publicKey_create(buf, key.length);
      wasm.free(buf);
      return out;
    }), logCb);

  wasm.proxyIdentityStoreDeps_setSaveRemotePublicIdentityKeyCallback(deps,
    addFunction(["i32", "i32", "i32", "i32", "i32"], ["i32"],
      function(userPtr, userLen, deviceId, keyPtr, keyLen) {
        var userId = readString(userPtr, userLen);
        mark("saveRemotePublicIdentityKey " + userId + ":" + deviceId);
        var key = readBytes(keyPtr, keyLen);
        remoteKeys[userId + ":" + deviceId] = key;
        send({ t: "remoteIdentityKey", userId: userId, deviceId: deviceId, key: key.toString("base64") });
        return 0;
      }), logCb);

  wasm.proxyIdentityStoreDeps_setGetLocalDeviceIdCallback(deps, cbI(function() {
    mark("getLocalDeviceId");
    return Number(input.deviceId) || 0;
  }), logCb);

  var userBuf = allocString(String(input.userId || ""));
  wasm.proxyIdentityStoreDeps_setLocalUserId(deps, userBuf, Buffer.byteLength(String(input.userId || "")));
  wasm.free(userBuf);
  wasm.proxyIdentityStoreDeps_setLocalIdentityKeyMode(deps, 2);

  var ctx = wasm.e2eeContext_create(input.mandated ? 1 : 0, logCb, cbV(["i32"], function() { mark("e2eeModelUpdate"); }), deps);
  wasm.proxyIdentityStoreDeps_free(deps);
  if (!ctx) return fail("could not create the E2EE context");

  // -------------------------------------------------------------------------
  // Encryption keys manager
  // -------------------------------------------------------------------------

  var ekmDeps = wasm.encryptionKeysManagerDeps_create();
  wasm.encryptionKeysManagerDeps_setE2eeContext(ekmDeps, ctx);
  wasm.encryptionKeysManagerDeps_setSendE2eeMessageCallback(ekmDeps,
    addFunction(["i32", "i32", "i32", "i32"], [], function(userPtr, userLen, dataPtr, dataLen) {
      var recipient = readString(userPtr, userLen);
      var data = readBytes(dataPtr, dataLen);
      mark("sendE2eeMessage " + recipient);
      send({ t: "sendE2eeKey", to: recipient, data: data.toString("base64") });
    }));
  // The server config can route key messages over the WebRTC media data
  // channel; there is no SCTP channel here, so the messages are relayed over
  // the signaling channel instead. The callback still has to exist, or the
  // wasm calls a null function pointer.
  wasm.encryptionKeysManagerDeps_setSctpSendE2eeMessageCallback(ekmDeps,
    addFunction(["i32", "i32", "i32", "i32"], [], function(userPtr, userLen, dataPtr, dataLen) {
      var recipient = readString(userPtr, userLen);
      var data = readBytes(dataPtr, dataLen);
      mark("sctpSendE2eeMessage " + recipient);
      send({ t: "sendE2eeKey", to: recipient, data: data.toString("base64") });
    }));
  var timers = {};
  var nextTimerId = 2;
  wasm.encryptionKeysManagerDeps_setStartTimerCallback(ekmDeps,
    addFunction(["i32", "i32"], ["i32"], function(delayMs, token) {
      mark("startTimer");
      var id = nextTimerId++;
      timers[id] = setTimeout(function() {
        delete timers[id];
        wasm.wasmTimerAdapter_execute(token);
      }, delayMs);
      return id;
    }));
  wasm.encryptionKeysManagerDeps_setStopTimerCallback(ekmDeps,
    addFunction(["i32"], [], function(id) {
      mark("stopTimer");
      if (timers[id]) {
        clearTimeout(timers[id]);
        delete timers[id];
      }
    }));
  wasm.encryptionKeysManagerDeps_setIsSessionKeyEnabled(ekmDeps, 1);
  var managerUser = allocString(String(input.userId || ""));
  wasm.encryptionKeysManagerDeps_setUserIdStr(ekmDeps, managerUser, Buffer.byteLength(String(input.userId || "")));
  wasm.free(managerUser);
  // The web client passes `isE2eeMandated || isE2eeInfraMandated` here; for a
  // mandated 1:1 call that is 1, and the key negotiation needs it.
  wasm.encryptionKeysManagerDeps_setIsE2eeInfraMandated(ekmDeps, input.mandated ? 1 : 0);
  var ekm = wasm.encryptionKeysManager_create(ekmDeps);
  wasm.encryptionKeysManagerDeps_free(ekmDeps);
  if (!ekm) return fail("could not create the encryption keys manager");

  // State-sync provider for the key exchange: the wasm distributes session
  // keys through it (and uses it to send a state-sync snapshot once the
  // negotiation succeeds).
  var sdm = wasm.cryptoMessageHandlerWrapper_create(
    addFunction(["i32", "i32", "i32", "i32", "i32", "i32", "i32"], [],
      function(recipientPtr, recipientLen, topicPtr, topicLen, dataPtr, dataLen, version) {
        mark("stateSyncNotifyRequest");
        var recipient = readString(recipientPtr, recipientLen);
        var topic = readString(topicPtr, topicLen);
        var data = readBytes(dataPtr, dataLen);
        send({
          t: "stateSyncNotify",
          to: recipient,
          topic: topic,
          version: version,
          data: data.toString("base64")
        });
      }),
    addFunction([], [], function() {
      mark("stateSyncSnapshot");
      send({ t: "stateSyncSnapshot" });
    }),
    ekm);
  if (!sdm) return fail("could not create the secure data message manager");

  // The web client serializes its client state at join time (it goes into the
  // join's sync payload); the wasm signs the signed prekey itself, so the
  // bytes differ from one built outside the wasm. The parent uses these bytes
  // in the join request.
  try {
    var stateResult = wasm.encryptionKeysManager_getSerializedE2eeClientState(ekm);
    if (stateResult) {
      var stateCode = wasm.dataResult_getErrCode(stateResult);
      var stateBytes = readBytes(
        wasm.dataResult_getData(stateResult),
        wasm.dataResult_getDataSize(stateResult)
      );
      wasm.dataResult_free(stateResult);
      if (stateCode === 0 && stateBytes.length) {
        send({ t: "clientState", data: stateBytes.toString("base64") });
      } else {
        send({ t: "log", message: "getSerializedE2eeClientState failed with code " + stateCode });
      }
    }
  } catch (e) {
    send({ t: "log", message: "getSerializedE2eeClientState failed: " + e.message });
  }

  // -------------------------------------------------------------------------
  // Sender key-index timers (mirrors ZenonEncryptionKeysManager)
  // -------------------------------------------------------------------------

  var keyTimers = [];
  function scheduleKeyIndex(keyIndex, delayMs) {
    if (keyIndex === "0" || keyIndex === "" || delayMs < 0) return;
    var timer = setTimeout(function() {
      var buf = allocString(keyIndex);
      var result = wasm.encryptionKeysManager_updateSenderKeyIndex(ekm, buf, Buffer.byteLength(keyIndex));
      wasm.free(buf);
      var next = "";
      if (result) {
        next = readString(wasm.stringBuffer_getDataPtr(result), wasm.stringBuffer_getSize(result));
        wasm.stringBuffer_free(result);
      }
      scheduleKeyIndex(next, delayMs);
    }, delayMs);
    keyTimers.push(timer);
  }

  // -------------------------------------------------------------------------
  // Frame encryptor / decryptor
  // -------------------------------------------------------------------------

  var encryptionEnabled = false;

  var encDeps = wasm.frameEncryptorDeps_create();
  wasm.frameEncryptorDeps_setEncryptionKeysManager(encDeps, ekm);
  wasm.frameEncryptorDeps_setLoggingCallback(encDeps, logCb);
  var encryptor = wasm.frameEncryptor_create(encDeps);
  wasm.frameEncryptorDeps_free(encDeps);
  if (!encryptor) return fail("could not create the frame encryptor");

  var decryptor = null;
  function setRemoteE2eeId(id) {
    if (decryptor) {
      wasm.frameDecryptor_free(decryptor);
      decryptor = null;
    }
    if (!id) return;
    var dDeps = wasm.frameDecryptorDeps_create();
    wasm.frameDecryptorDeps_setEncryptionKeysManager(dDeps, ekm);
    var idBuf = allocString(id);
    wasm.frameDecryptorDeps_setE2eeId(dDeps, idBuf, Buffer.byteLength(id));
    wasm.free(idBuf);
    wasm.frameDecryptorDeps_setLoggingCallback(dDeps, logCb);
    decryptor = wasm.frameDecryptor_create(dDeps);
    wasm.frameDecryptorDeps_free(dDeps);
    if (decryptor) {
      var typesPtr = allocZeros(4);
      new DataView(memory.buffer).setInt32(typesPtr, 0, true); // Generic
      wasm.frameDecryptor_setSupportedFrameDataHandlerTypes(decryptor, typesPtr, 1);
      wasm.free(typesPtr);
      wasm.frameDecryptor_enableUnencryptedData(decryptor);
    }
  }

  function encryptFrame(data) {
    if (!encryptionEnabled) return { errorCode: 0, data: data };
    var len = data.length;
    var max = wasm.frameEncryptor_getMaxEncryptedSize(encryptor, len);
    if (max <= 0) return { errorCode: 1, data: null };
    var input = Buffer.alloc(max);
    data.copy(input);
    var buf = alloc(input);
    var sizePtr = allocZeros(4);
    var errorCode = wasm.frameEncryptor_encrypt(encryptor, 0, buf, len, buf, max, 0, 0, sizePtr);
    var outLen = readI32(sizePtr);
    var out = errorCode === 0 && outLen > 0 ? readBytes(buf, outLen) : null;
    wasm.free(buf);
    wasm.free(sizePtr);
    return { errorCode: errorCode, data: out };
  }

  function decryptFrame(data) {
    if (!decryptor) return { errorCode: 1, data: null };
    var len = data.length;
    var inBuf = alloc(data);
    var outBuf = allocZeros(len);
    var sizePtr = allocZeros(4);
    var errorCode = wasm.frameDecryptor_decrypt(decryptor, inBuf, len, outBuf, len, 0, 0, sizePtr);
    var outLen = readI32(sizePtr);
    var out = errorCode === 0 && outLen > 0 ? readBytes(outBuf, outLen) : null;
    wasm.free(inBuf);
    wasm.free(outBuf);
    wasm.free(sizePtr);
    return { errorCode: errorCode, data: out };
  }

  // -------------------------------------------------------------------------
  // IPC
  // -------------------------------------------------------------------------

  process.on("message", function(message) {
    if (!message || !message.t) return;
    try {
      switch (message.t) {
        case "remoteKeys":
          Object.keys(message.keys || {}).forEach(function(addr) {
            var key = Buffer.from(message.keys[addr], "base64");
            if (key.length === 32) key = Buffer.concat([Buffer.from([5]), key]);
            remoteKeys[addr] = key;
          });
          break;

        case "serverState": {
          var state = Buffer.from(message.data, "base64");
          var statePtr = alloc(state);
          var update = wasm.encryptionKeysManager_processE2eeServerUpdate(ekm, statePtr, state.length);
          wasm.free(statePtr);
          if (!update) { send({ t: "error", message: "processE2eeServerUpdate returned null" }); break; }
          var updateResult = {
            errorCode: wasm.encryptionKeysManagerProcessE2eeServerUpdateResult_getErrCode(update),
            keyIndex: readString(
              wasm.encryptionKeysManagerProcessE2eeServerUpdateResult_getKeyIndexDataPtr(update),
              wasm.encryptionKeysManagerProcessE2eeServerUpdateResult_getKeyIndexSize(update)
            ),
            keyUpdateDelayInMS: wasm.encryptionKeysManagerProcessE2eeServerUpdateResult_getKeyUpdateDelay(update),
            removeFrameDecryptorDelayMs:
              wasm.encryptionKeysManagerProcessE2eeServerUpdateResult_getRemoveFrameDecryptorDelayMs(update)
          };
          wasm.encryptionKeysManagerProcessE2eeServerUpdateResult_free(update);
          encryptionEnabled = updateResult.errorCode === 0;
          scheduleKeyIndex(updateResult.keyIndex, updateResult.keyUpdateDelayInMS);
          send({ t: "serverUpdate", result: updateResult });
          break;
        }

        case "e2eeMessage": {
          var payload = Buffer.from(message.data, "base64");
          var payloadPtr = alloc(payload);
          var result = wasm.encryptionKeysManager_processE2eeMessage(ekm, payloadPtr, payload.length, 0);
          wasm.free(payloadPtr);
          if (!result) { send({ t: "error", message: "processE2eeMessage returned null" }); break; }
          var messageResult = {
            statusCode: wasm.encryptionKeysManagerProcessE2eeMessageResult_getStatusCode(result),
            keyIndex: readString(
              wasm.encryptionKeysManagerProcessE2eeMessageResult_getKeyIndexDataPtr(result),
              wasm.encryptionKeysManagerProcessE2eeMessageResult_getKeyIndexSize(result)
            ),
            keyUpdateDelayInMS: wasm.encryptionKeysManagerProcessE2eeMessageResult_getKeyUpdateDelay(result)
          };
          wasm.encryptionKeysManagerProcessE2eeMessageResult_free(result);
          scheduleKeyIndex(messageResult.keyIndex, messageResult.keyUpdateDelayInMS);
          send({ t: "messageResult", result: messageResult });
          break;
        }

        case "setLocalE2eeId": {
          var localId = String(message.id || "");
          if (!localId) break;
          var localBuf = allocString(localId);
          wasm.encryptionKeysManager_setLocalE2eeId(ekm, localBuf, Buffer.byteLength(localId));
          wasm.free(localBuf);
          break;
        }

        case "setRemoteE2eeId":
          setRemoteE2eeId(String(message.id || ""));
          break;

        case "setEncryptionEnabled":
          encryptionEnabled = !!message.on;
          break;

        case "encrypt": {
          var encResult = encryptFrame(Buffer.from(message.data, "base64"));
          send({
            t: "frame", id: message.id, dir: "encrypt",
            errorCode: encResult.errorCode,
            data: encResult.data ? encResult.data.toString("base64") : null
          });
          break;
        }

        case "decrypt": {
          var decResult = decryptFrame(Buffer.from(message.data, "base64"));
          send({
            t: "frame", id: message.id, dir: "decrypt",
            errorCode: decResult.errorCode,
            data: decResult.data ? decResult.data.toString("base64") : null
          });
          break;
        }

        case "close":
          keyTimers.forEach(clearTimeout);
          Object.keys(timers).forEach(function(id) { clearTimeout(timers[id]); });
          process.exit(0);
          break;
      }
    } catch (e) {
      send({
        t: "error",
        message: (e && e.message ? e.message : String(e)) +
          " [after callback: " + lastCallback + "]" +
          (e && e.stack ? "\n" + e.stack.split("\n").slice(0, 8).join("\n") : "")
      });
    }
  });

  send({ t: "ready" });
}

var input;
try {
  input = JSON.parse(process.argv[2]);
} catch (e) {
  fail("invalid runner input");
}
if (input) run(input);
