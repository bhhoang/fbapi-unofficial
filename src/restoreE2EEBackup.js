"use strict";

// Restore the account's encrypted-backup ("Secure Storage") state natively.
//
// This is the setup step that enables getThreadHistory / the E2EE client to
// read end-to-end encrypted chat history from Facebook's backup:
//
//   1. derive the virtual device keys from the 40-character recovery code,
//   2. fetch the virtual device's encrypted secrets and decrypt them,
//   3. derive the epoch keys with the Labyrinth wasm reactor,
//   4. persist everything (device id, mailbox tokens, epoch keys) in the E2EE
//      device file so later calls work offline.
//
// Options (backupState overrides mostly exist for testing and advanced use):
//   recoveryCode      - the 40-character recovery code (required).
//   virtualDeviceInfo - pre-fetched fetch_virtual_device_info_for_device_addition_v2
//                       payload; fetched from the server when omitted.
//   deviceId          - server device entity id to use for reads; discovered
//                       from the backup ids query when omitted.
//   mailboxRootKey, ocmfClientState, epochs - overrides for the decrypted
//                       values (Buffers or base64 strings).
//   wasmPath          - cache path for the Labyrinth_REPL wasm module.

var log = require("npmlog");
var backup = require("./e2ee/backup");
var DeviceStore = require("./e2ee/store").DeviceStore;

function toBase64(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value.toString("base64");
  return String(value);
}

module.exports = function(defaultFuncs, api, ctx) {
  return function restoreE2EEBackup(options, callback) {
    if (!callback) callback = function() {};
    options = options || {};
    if (!options.recoveryCode) {
      return callback({ error: "restoreE2EEBackup: need options.recoveryCode" });
    }

    var keys;
    try {
      keys = backup.deriveVirtualDeviceKeys(options.recoveryCode, ctx.userID);
    } catch (deriveError) {
      return callback({ error: "restoreE2EEBackup: " + deriveError.message });
    }

    var store = DeviceStore.fromFile(ctx.globalOptions.e2eeDevicePath);

    function finish(data) {
      var secrets = backup.decryptSecretValues(
        data.encrypted_secret_values,
        keys.virtualDeviceDecryptionKey
      );
      var mailboxRootKey = options.mailboxRootKey || secrets.encrypted_mailbox_root_key_blob;
      var ocmfClientState = options.ocmfClientState || secrets.encrypted_ocmf_client_state;
      if (
        !mailboxRootKey ||
        mailboxRootKey.error ||
        !ocmfClientState ||
        ocmfClientState.error
      ) {
        return callback({
          error:
            "restoreE2EEBackup: could not decrypt the mailbox secrets (wrong " +
            "recovery code, or the virtual device does not belong to this account)."
        });
      }

      var deriveOptions = {};
      if (options.wasmPath) deriveOptions.wasmPath = options.wasmPath;
      backup.deriveAddDeviceEpochs(data, keys.virtualDeviceDecryptionKey, deriveOptions, function(deriveError, epochs) {
        if (deriveError) {
          log.error("restoreE2EEBackup", deriveError);
          return callback(deriveError);
        }
        if (options.epochs && options.epochs.length) {
          options.epochs.forEach(function(extra) {
            var epochRootKey = extra.epochRootKey;
            epochs.push({
              epochId: String(extra.epochId),
              epochAnonId: Buffer.isBuffer(extra.epochAnonId)
                ? extra.epochAnonId
                : Buffer.from(String(extra.epochAnonId), "utf8"),
              epochRootKey: Buffer.isBuffer(epochRootKey)
                ? epochRootKey
                : Buffer.from(String(epochRootKey), "base64"),
              isOpen: extra.isOpen === true,
              epochStoragePrivateKey: extra.epochStoragePrivateKey || null
            });
          });
        }

        function persist(deviceId, backupId, deviceKeys) {
          store.backup = {
            backupId: backupId != null ? String(backupId) : null,
            deviceId: String(deviceId),
            mailboxRootKey: toBase64(mailboxRootKey),
            ocmfClientState: toBase64(ocmfClientState),
            virtualDeviceId: keys.virtualDeviceId.toString("hex"),
            deviceRegistrationId: options.deviceRegistrationId || null,
            epochs: epochs.map(function(epoch) {
              return {
                epochId: String(epoch.epochId),
                epochAnonId: epoch.epochAnonId.toString(),
                epochRootKey: epoch.epochRootKey.toString("base64")
              };
            }),
            savedAt: Date.now()
          };
          if (deviceKeys) {
            store.backup.deviceKeys = {
              device: {
                priv: deviceKeys.device.priv.toString("base64"),
                pub: deviceKeys.device.pub.toString("base64")
              },
              storage: {
                priv: deviceKeys.storage.priv.toString("base64"),
                pub: deviceKeys.storage.pub.toString("base64")
              },
              auth: {
                priv: deviceKeys.auth.priv.toString("base64"),
                pub: deviceKeys.auth.pub.toString("base64")
              }
            };
          }
          store.save();
          callback(null, {
            backupId: store.backup.backupId,
            deviceId: store.backup.deviceId,
            epochs: store.backup.epochs.length
          });
        }

        if (options.deviceId) return persist(options.deviceId, options.backupId);

        backup.fetchBackupState(defaultFuncs, ctx, ctx.jar, function(stateError, state) {
          if (stateError) {
            log.error("restoreE2EEBackup", stateError);
            return callback(stateError);
          }
          if (!options.autoAddDevice) {
            var deviceId = state.deviceIds.length ? state.deviceIds[0] : null;
            if (deviceId == null) {
              return callback({
                error:
                  "restoreE2EEBackup: the backup has no device entity to read " +
                  "history through; pass options.deviceId or options.autoAddDevice."
              });
            }
            return persist(deviceId, state.backupId);
          }

          var virtualDevice = state.virtualDevices[0];
          if (!virtualDevice || !virtualDevice.clientGeneratedId) {
            return callback({
              error: "restoreE2EEBackup: the backup has no virtual device to add a device under."
            });
          }
          var lastEpoch = epochs[epochs.length - 1];
          var ocmf = require("./e2ee/ocmf");
          var evolved;
          try {
            evolved = ocmf.clientEvolve(ocmfClientState);
          } catch (evolveError) {
            return callback({ error: "restoreE2EEBackup: " + evolveError.message });
          }
          var deviceRegistrationId =
            options.deviceRegistrationId || String(Date.now()) + "001";
          backup.buildAddDeviceInfo({
            backupId: state.backupId,
            virtualDeviceId: Buffer.from(virtualDevice.clientGeneratedId, "base64"),
            deviceRegistrationId: deviceRegistrationId,
            traceId: require("./e2ee/store").randomUUID(),
            epoch: {
              epochId: lastEpoch.epochId,
              epochAnonId: lastEpoch.epochAnonId.toString(),
              epochRootKey: lastEpoch.epochRootKey
            },
            identity: {
              privateKey: Buffer.from(store.identityKeyPair.priv),
              publicKey: Buffer.from(store.identityKeyPair.pub)
            },
            ocmfRotationToken: evolved.evolveToken
          }, function(buildError, built) {
            if (buildError) {
              log.error("restoreE2EEBackup", buildError);
              return callback(buildError);
            }
            backup.submitAddDevice(defaultFuncs, ctx, ctx.jar, built.deviceInfo, require("./e2ee/store").randomUUID(), function(addError, added) {
              if (addError) {
                log.error("restoreE2EEBackup", addError);
                return callback(addError);
              }
              options.deviceRegistrationId = deviceRegistrationId;
              persist(added.deviceId, state.backupId, built.keys);
            });
          });
        });
      });
    }

    if (options.virtualDeviceInfo) {
      finish(options.virtualDeviceInfo);
      return;
    }
    backup.fetchVirtualDeviceInfo(
      defaultFuncs,
      ctx,
      ctx.jar,
      keys.virtualDeviceId,
      require("./e2ee/store").randomUUID(),
      function(fetchError, data) {
        if (fetchError) {
          log.error("restoreE2EEBackup", fetchError);
          return callback(fetchError);
        }
        finish(data);
      }
    );
  };
};
