"use strict";

// Labyrinth (Messenger encrypted backups / "Secure Storage") support.
//
// Stage 1 of native restore: recovery code -> virtual-device keys.
//
// Meta's web implementation (parseLSRecoveryCode / LSParseRecoveryCode_v2 /
// deriveLSKey / CreateDerivedKeys) derives the virtual device keys as:
//
//   entropy  = recoveryCode[2 .. 2 + (version === "1" ? 35 : 34)]
//   info     = "BackupRecoveryCode_v" + version + "_" + identifier + "_" + userId
//   hkdf     = HKDF-SHA256(ikm = utf8(entropy), salt = 10 zero bytes, info = utf8(info))
//   keys     = hkdf output split into [virtualDeviceId, virtualDeviceDecryptionKey]
//              where v1 uses 8 + 32 bytes and v2 uses 16 + 32 bytes.
//
// The rest of the restore flow (fetching the encrypted virtual device, epochs
// and mailbox records) is implemented in the following stages.
//
// Stage 2 of native restore: epoch derivation. The server hands out the
// virtual device's encrypted epoch secrets plus the epoch graph; the
// Labyrinth_REPL WASI module (see reactor.js) combines them with the
// recovery-code key and returns the derived epoch keys, including the epoch
// storage private key whose X25519 public key matches the server's
// epoch_storage_public_key.

var cryptoUtils = require("./crypto");
var reactor = require("./reactor");

var VERSION_LENGTHS = {
  "1": [8, 32],
  "2": [16, 32]
};

var HOMOGLYPHS = { B: "8", G: "C", I: "1", O: "0" };

// AADs used by the web client's
// LSDecryptVirtualDeviceSecretsForDeviceAdditionV2 stored procedure and by the
// Labyrinth epoch-derivation step (verified against the live server: the
// recovery-code key decrypts each blob with AAD "virtual_device:<field>").
var SECRET_AADS = {
  encrypted_ocmf_client_state: "virtual_device:ocmf_client_state",
  encrypted_mailbox_root_key_blob: "virtual_device:mailbox_root_key",
  encrypted_oblivious_validation_token_blob: "virtual_device:oblivious_validation_token",
  encrypted_epoch_anon_id: "virtual_device:epoch_anon_id",
  encrypted_epoch_root_key: "virtual_device:epoch_root_key",
  encrypted_epoch_storage_private_key: "virtual_device:epoch_storage_private_key",
  encrypted_orf_client_state_v2: "virtual_device:orf_client_state_v2"
};
var SECRET_FALLBACK_AAD = "secret_values_metadata";

function normalizeRecoveryCode(code) {
  return String(code)
    .toUpperCase()
    .replace(/[BGIO]/g, function(ch) {
      return HOMOGLYPHS[ch] || ch;
    })
    .replace(/[\s-]/g, "");
}

function parseRecoveryCode(code, userId) {
  var normalized = normalizeRecoveryCode(code);
  var version = normalized.substring(0, 1);
  if (normalized.length !== 40 || (version !== "1" && version !== "2")) {
    return null;
  }
  var marker = normalized.substring(1, 2);
  var entropy = normalized.substring(2, version === "1" ? 37 : 36);
  return {
    version: version,
    identifier: marker,
    entropy: entropy,
    info: "BackupRecoveryCode_v" + version + "_" + marker + "_" + String(userId)
  };
}

function deriveVirtualDeviceKeys(code, userId) {
  var parsed = parseRecoveryCode(code, userId);
  if (!parsed) {
    throw new Error("Invalid recovery code: expected 40 characters starting with version 1 or 2.");
  }
  var lengths = VERSION_LENGTHS[parsed.version];
  var total = lengths[0] + lengths[1];
  var derived = cryptoUtils.hkdf(
    Buffer.from(parsed.entropy, "utf8"),
    Buffer.alloc(10),
    Buffer.from(parsed.info, "utf8"),
    total
  );
  return {
    version: parsed.version,
    identifier: parsed.identifier,
    entropy: parsed.entropy,
    info: parsed.info,
    virtualDeviceId: derived.subarray(0, lengths[0]),
    virtualDeviceDecryptionKey: derived.subarray(lengths[0], total)
  };
}

function decryptSecretValues(encryptedSecretValues, decryptionKey) {
  var result = {};
  Object.keys(encryptedSecretValues || {}).forEach(function(field) {
    var encrypted = encryptedSecretValues[field];
    if (!encrypted) return;
    var aad = SECRET_AADS[field] || SECRET_FALLBACK_AAD;
    try {
      var plaintext = cryptoUtils.ebSymmetricDecrypt(decryptionKey, aad, encrypted);
      var text = plaintext.toString("utf8");
      result[field] = Buffer.from(text, "base64");
    } catch (err) {
      result[field] = { error: err.message };
    }
  });
  return result;
}

// fetch_virtual_device_info_for_device_addition_v2, doc_id 27078903168382564.
// Returns the raw GraphQL response's data object.
function fetchVirtualDeviceInfo(defaultFuncs, ctx, jar, virtualDeviceId, requestUuid, callback) {
  var variables = {
    request_uuid: requestUuid,
    virtual_device_id: Buffer.from(virtualDeviceId).toString("base64")
  };
  defaultFuncs
    .post("https://www.facebook.com/api/graphql/", jar, {
      doc_id: "27078903168382564",
      variables: JSON.stringify(variables),
      server_timestamps: "true"
    })
    .then(require("../../utils").parseAndCheckLogin(ctx, defaultFuncs))
    .then(function(data) {
      var payload = data && data.data && data.data.fetch_virtual_device_info_for_device_addition_v2;
      if (!payload) return callback({ error: "No virtual device info in GraphQL response.", res: data });
      if (payload.ok === false) {
        return callback({
          error:
            "Fetching virtual device info failed: " +
            (payload.error && payload.error.code ? payload.error.code : "unknown error")
        });
      }
      callback(null, payload.data);
    })
    .catch(function(err) {
      callback(err);
    });
}

// Stage 2: epoch derivation.
//
// Data flow (mirrors Meta's EBAddDeviceGraphQL):
//   virtualDeviceInfo = fetchVirtualDeviceInfo(...)
//   decryptionKey     = deriveVirtualDeviceKeys(recoveryCode, userId).virtualDeviceDecryptionKey
//   epochs            = deriveAddDeviceEpochs(virtualDeviceInfo, decryptionKey, options)

function toEpochId(value) {
  var number = Number(value);
  return Number.isSafeInteger(number) ? number : String(value);
}

function decodeBase64(value) {
  return Buffer.from(String(value), "base64");
}

function buildSyncEpochs(data) {
  var backwardEdges = {};
  (data.epoch_edges || []).forEach(function(edge) {
    if (
      edge &&
      edge.backward_edge != null &&
      edge.from_epoch &&
      edge.from_epoch.epoch_id != null
    ) {
      backwardEdges[edge.from_epoch.epoch_id] = decodeBase64(edge.backward_edge);
    }
  });
  return (data.sync_epochs || [])
    .filter(function(epoch) {
      return (
        epoch.epoch_id != null &&
        epoch.backup_id != null &&
        epoch.epoch_anon_id != null &&
        epoch.epoch_auth_public_key != null &&
        epoch.is_active_epoch != null
      );
    })
    .map(function(epoch) {
      var syncEpoch = {
        backupId: toEpochId(epoch.backup_id),
        epochAnonId: Buffer.from(String(epoch.epoch_anon_id), "utf8"),
        epochAuthPublicKey: decodeBase64(epoch.epoch_auth_public_key),
        epochId: toEpochId(epoch.epoch_id),
        isActiveEpoch: epoch.is_active_epoch === true
      };
      if (epoch.encrypted_epoch_key != null) {
        syncEpoch.encryptedEpochKey = decodeBase64(epoch.encrypted_epoch_key);
      }
      if (epoch.next_epoch_id != null) {
        syncEpoch.nextEpochId = toEpochId(epoch.next_epoch_id);
      }
      if (epoch.prev_epoch_id != null) {
        syncEpoch.prevEpochId = toEpochId(epoch.prev_epoch_id);
        var backwardEdge = backwardEdges[epoch.epoch_id];
        if (backwardEdge) syncEpoch.backwardEdge = backwardEdge;
      }
      return syncEpoch;
    });
}

function buildEpochDerivationInput(data, decryptionKey) {
  var secrets = data.encrypted_secret_values || {};
  return {
    addDeviceEpochDerivationInput: {
      blobDecryptionKey: decryptionKey,
      encryptedEpochRootKey: decodeBase64(secrets.encrypted_epoch_root_key),
      encryptedEpochAnonId: decodeBase64(secrets.encrypted_epoch_anon_id),
      encryptedEpochStoragePrivateKey:
        secrets.encrypted_epoch_storage_private_key != null
          ? decodeBase64(secrets.encrypted_epoch_storage_private_key)
          : null,
      baseEpochId: toEpochId(data.epoch_id),
      lastEpochId: toEpochId(data.last_epoch_id),
      epochStoragePublicKey: decodeBase64(data.epoch_storage_public_key),
      syncEpochs: buildSyncEpochs(data)
    }
  };
}

function deriveAddDeviceEpochs(data, decryptionKey, options, callback) {
  if (!data || data.epoch_id == null || data.last_epoch_id == null) {
    callback(new Error("Virtual device info is missing the epoch identifiers."));
    return;
  }
  var secrets = data.encrypted_secret_values || {};
  if (
    secrets.encrypted_epoch_root_key == null ||
    secrets.encrypted_epoch_anon_id == null ||
    data.epoch_storage_public_key == null
  ) {
    callback(new Error("Virtual device info is missing the encrypted epoch secrets."));
    return;
  }
  var input = buildEpochDerivationInput(data, decryptionKey);
  reactor.runLabyrinthCommand(input, options || {}, function(runError, output) {
    if (runError) {
      callback(runError);
      return;
    }
    if (output.error != null || (output.errorCode != null && output.errorCode !== 0)) {
      callback(
        new Error(
          "Epoch derivation failed" +
            (output.error != null ? ": " + output.error : " with error code " + output.errorCode) +
            "."
        )
      );
      return;
    }
    var epochs = (output.epochs || []).map(function(epoch) {
      return {
        epochId: epoch.epochId,
        epochAnonId: epoch.epochAnonId,
        epochRootKey: epoch.epochRootKey,
        isOpen: epoch.isOpen === true,
        epochStoragePrivateKey: epoch.epochStoragePrivateKey
      };
    });
    if (!epochs.length) {
      callback(new Error("Epoch derivation returned no epochs."));
      return;
    }
    var expectedPublicKey = decodeBase64(data.epoch_storage_public_key);
    var matchesServerKey = epochs.some(function(epoch) {
      return (
        epoch.epochStoragePrivateKey &&
        cryptoUtils.publicFromPrivate(epoch.epochStoragePrivateKey).equals(expectedPublicKey)
      );
    });
    if (expectedPublicKey.length === 32 && !matchesServerKey) {
      callback(
        new Error("The derived epoch storage key does not match the virtual device's public key.")
      );
      return;
    }
    callback(null, epochs);
  });
}

// Stage 3: fetching and decrypting backup messages.
//
// The server hands out raw backup messages through EBMessageRangeQueryForThreads
// (doc_id 27443670391974737). Each request carries the device context: the
// device id, the locally available epoch ids and the raw mailbox tokens
// (mailbox root key + ocmf client state) that were decrypted in stage 2.
// Message stanzas are decrypted in messages.js with keys derived from the
// epoch root keys recovered by the Labyrinth reactor.

function toBase64(value) {
  if (value == null) return value;
  if (Buffer.isBuffer(value)) return value.toString("base64");
  return String(value);
}

// params:
//   threads       - [{ threadId, serverThreadKey?, direction: "before"|"after",
//                     numMessages?, referenceTimestamp? }]
//   deviceId      - server device id (numeric string)
//   epochIds      - locally available epoch ids (from deriveAddDeviceEpochs)
//   mailboxRootKey, ocmfClientState - Buffers or base64 strings from
//                     decryptSecretValues
//   restoreType   - optional override ("INITIAL_RESTORE" | "RANGE_QUERY_RESTORE")
//   appId, source - optional
function fetchBackupMessageRanges(defaultFuncs, ctx, jar, params, callback) {
  var restorePayloads = (params.threads || []).map(function(thread) {
    var payload = {
      restore_context: {
        act_thread_id: String(thread.threadId),
        site: "www",
        source: params.source != null ? params.source : -1,
        tam_thread_subtype: 0
      },
      success: {
        device_context: {
          device_id: String(params.deviceId),
          locally_available_epochs: params.epochIds || [],
          raw_tokens: {
            mailbox_root_key: toBase64(params.mailboxRootKey),
            ocmf_client_state_blob: toBase64(params.ocmfClientState)
          }
        },
        direction: thread.direction === "after" ? 2 : 1,
        query_num_messages: thread.numMessages != null ? thread.numMessages : 50,
        reference_timestamp: thread.referenceTimestamp,
        server_thread_key: thread.serverThreadKey
      }
    };
    return JSON.stringify(payload);
  });
  var variables = {
    app_id: params.appId != null ? params.appId : "0",
    includeAttachmentData: false,
    restore_payload_strings: restorePayloads,
    restore_type: params.restoreType || "INITIAL_RESTORE"
  };
  defaultFuncs
    .post("https://www.facebook.com/api/graphql/", jar, {
      doc_id: "27443670391974737",
      variables: JSON.stringify(variables),
      server_timestamps: "true"
    })
    .then(require("../../utils").parseAndCheckLogin(ctx, defaultFuncs))
    .then(function(data) {
      var mailbox =
        data &&
        data.data &&
        data.data.viewer &&
        data.data.viewer.encrypted_backup &&
        data.data.viewer.encrypted_backup.mailbox;
      var results = mailbox && mailbox.messages_from_selected_threads;
      if (!results) return callback({ error: "No backup messages in GraphQL response.", res: data });
      callback(null, results);
    })
    .catch(function(err) {
      callback(err);
    });
}

// Stage 4: adding this device to the backup (xfb_eb_add_device).
//
// Mirrors Meta's LSEncryptedBackupsDecryptVirtualDeviceSecretsForDeviceAdditionV2
// stored procedure: fresh device signing / epoch storage / epoch auth keypairs
// are generated, signed with the device signing key, bound to the last derived
// epoch with an HMAC and submitted with the mutation. The signing formats follow
// Meta's X25519 module: signing keys are 0xff01/0xff02/0xff03 prefixed, epoch
// keys are raw 32-byte X25519 keys, signatures are XEdDSA.

var utils = require("../../utils");

var SIGN_PREFIX = {
  publicKey: 0xff01,
  privateKey: 0xff02,
  signature: 0xff03
};

function prefixed(prefix, payload) {
  return Buffer.concat([Buffer.from([prefix >> 8, prefix & 0xff]), payload]);
}

function signWithDeviceKey(devicePriv, aadByte, message) {
  var signature = cryptoUtils.xeddsaSign(devicePriv, Buffer.concat([Buffer.from([aadByte]), message]));
  return prefixed(SIGN_PREFIX.signature, signature);
}

// params:
//   backupId, virtualDeviceId (Buffer), deviceRegistrationId, traceId
//   epoch        - { epochId, epochAnonId, epochRootKey (Buffer) } (last derived)
//   identity     - { privateKey (32B), publicKey (32B raw) } - the E2EE identity
//   ocmfRotationToken (Buffer|null)
function buildAddDeviceInfo(params, callback) {
  var out = {};
  try {
    var devicePair = cryptoUtils.generateKeyPair();
    var storagePair = cryptoUtils.generateKeyPair();
    var authPair = cryptoUtils.generateKeyPair();

    var devicePublicBlob = prefixed(SIGN_PREFIX.publicKey, devicePair.pub);
    var epochStorageSig = signWithDeviceKey(devicePair.priv, 0x30, storagePair.pub);
    var epochAuthSig = signWithDeviceKey(devicePair.priv, 0x31, authPair.pub);
    var armadilloSignature = signWithDeviceKey(devicePair.priv, 0x33, prefixed(0x05, params.identity.publicKey));
    var labyrinthSignature = prefixed(
      SIGN_PREFIX.signature,
      cryptoUtils.xeddsaSign(params.identity.privateKey, devicePublicBlob)
    );

    var epochRootKey = params.epoch.epochRootKey;
    var fingerprint = cryptoUtils.hkdf(
      epochRootKey,
      Buffer.alloc(10),
      Buffer.from("meb/debug/fingerprint/MEBEpochRootKey", "utf8"),
      18
    );
    var hmacKeyInfo =
      "epoch_devices_" + Buffer.from(String(params.epoch.epochAnonId), "utf8").toString("base64");
    var hmacKey = cryptoUtils.hkdf(epochRootKey, Buffer.alloc(10), Buffer.from(hmacKeyInfo, "utf8"), 32);
    var deviceEpochHmac = cryptoUtils.hmacSha256(hmacKey, devicePublicBlob);

    out.deviceInfo = {
      armadillo_key_signature: armadilloSignature.toString("base64"),
      armadillo_public_key: prefixed(0x05, params.identity.publicKey).toString("base64"),
      backup_id: String(params.backupId),
      base_epoch_id: String(params.epoch.epochId),
      device_epoch_hmac: deviceEpochHmac.toString("base64"),
      device_public_key: devicePublicBlob.toString("base64"),
      device_registration_id: String(params.deviceRegistrationId),
      epoch_auth_pubkey: authPair.pub.toString("base64"),
      epoch_auth_pubkey_sig: epochAuthSig.toString("base64"),
      epoch_root_key_fingerprint: fingerprint.toString("base64"),
      epoch_storage_pubkey: storagePair.pub.toString("base64"),
      epoch_storage_pubkey_sig: epochStorageSig.toString("base64"),
      labyrinth_key_signature: labyrinthSignature.toString("base64"),
      occam_only_eligible: true,
      ocmf_rotation_token:
        params.ocmfRotationToken != null ? params.ocmfRotationToken.toString("base64") : "",
      trace_id: String(params.traceId)
    };
    // The debug token fields are validated by the server as debug-token JSON;
    // omit them unless real tokens are supplied.
    if (params.epochStorageDebugToken != null) {
      out.deviceInfo.epoch_storage_pvtkey_debug_token = params.epochStorageDebugToken;
    }
    if (params.ocmfClientStateDebugToken != null) {
      out.deviceInfo.ocmf_client_state_debug_token = params.ocmfClientStateDebugToken;
    }
    if (params.privateKeyDebugToken != null) {
      out.deviceInfo.private_key_debug_token = params.privateKeyDebugToken;
    }
    if (params.virtualDeviceId) {
      out.deviceInfo.virtual_device_id = Buffer.from(params.virtualDeviceId).toString("base64");
    }
    out.keys = {
      device: { priv: devicePair.priv, pub: devicePair.pub },
      storage: { priv: storagePair.priv, pub: storagePair.pub },
      auth: { priv: authPair.priv, pub: authPair.pub }
    };
  } catch (buildError) {
    callback(buildError);
    return;
  }
  callback(null, out);
}

function submitAddDevice(defaultFuncs, ctx, jar, deviceInfo, requestUuid, callback) {
  defaultFuncs
    .post("https://www.facebook.com/api/graphql/", jar, {
      doc_id: "26934669346130743",
      variables: JSON.stringify({
        input: {
          device_info: deviceInfo,
          family_device_id: "",
          ls_device_id: "",
          request_uuid: requestUuid
        }
      }),
      server_timestamps: "true"
    })
    .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
    .then(function(response) {
      var payload = response && response.data && response.data.xfb_eb_add_device;
      if (!payload) return callback({ error: "No add-device payload.", res: response });
      if (payload.device_id != null && payload.code == null) {
        return callback(null, { deviceId: String(payload.device_id) });
      }
      callback({
        error: "Add device failed: " + (payload.code || "null_device_id"),
        message: payload.message || null,
        isRetryable: payload.is_retryable === true
      });
    })
    .catch(function(err) {
      callback(err);
    });
}

// Backup overview: backup id, virtual devices and device entity ids
// (useMWEncryptedBackupsFetchBackupIdsV2Query, doc_id 25220416984279164).
function fetchBackupState(defaultFuncs, ctx, jar, callback) {
  defaultFuncs
    .post("https://www.facebook.com/api/graphql/", jar, {
      doc_id: "25220416984279164",
      variables: "{}",
      server_timestamps: "true"
    })
    .then(require("../../utils").parseAndCheckLogin(ctx, defaultFuncs))
    .then(function(data) {
      var payload = data && data.data && data.data.xfb_backup;
      if (!payload) return callback({ error: "No backup in FetchBackupIds response.", res: data });
      var edges = (payload.devices && payload.devices.edges) || [];
      callback(null, {
        backupId: payload.id != null ? String(payload.id) : null,
        virtualDevices: ((payload.virtual_devices) || []).map(function(device) {
          return {
            id: device.id != null ? String(device.id) : null,
            clientGeneratedId: device.client_generated_id || null,
            deviceType: device.device_type,
            createdOn: device.device_created_on || null
          };
        }),
        deviceIds: edges.map(function(edge) {
          return edge.node && edge.node.id != null ? String(edge.node.id) : null;
        }).filter(Boolean)
      });
    })
    .catch(function(err) {
      callback(err);
    });
}

module.exports = {
  normalizeRecoveryCode: normalizeRecoveryCode,
  parseRecoveryCode: parseRecoveryCode,
  deriveVirtualDeviceKeys: deriveVirtualDeviceKeys,
  decryptSecretValues: decryptSecretValues,
  fetchVirtualDeviceInfo: fetchVirtualDeviceInfo,
  deriveAddDeviceEpochs: deriveAddDeviceEpochs,
  fetchBackupMessageRanges: fetchBackupMessageRanges,
  fetchBackupState: fetchBackupState,
  buildAddDeviceInfo: buildAddDeviceInfo,
  submitAddDevice: submitAddDevice,
  SECRET_AADS: SECRET_AADS
};
