"use strict";
/* global WebAssembly */

// Labyrinth REPL ("Labyrinth_REPL") WASM reactor.
//
// Meta ships the epoch-derivation / backup crypto code as a WASI module that
// exchanges protobuf messages through two files in its preopened directory:
//
//   - the host writes the encoded LabyrinthCommand to a file named "input"
//     and truncates a file named "output",
//   - the host calls exports.execute_command(),
//   - the module reads "input", writes "output" and returns.
//
// The module is fetched from Meta's CDN (same URL the web client resolves via
// its asset map, bx("32099")) and cached on disk. Running WASI requires
// Node.js 18+; older runtimes get a clear error from runLabyrinthCommand.

var fs = require("fs");
var os = require("os");
var path = require("path");
var https = require("https");
var ebproto = require("./ebproto");
var cryptoUtils = require("./crypto");

var LABYRINTH_WASM_URL = "https://static.xx.fbcdn.net/rsrc.php/yv/r/nP6A6oQydcT.wasm";
var DEFAULT_WASM_FILE = path.join(os.tmpdir(), "labyrinth-repl.wasm");
var MAX_REDIRECTS = 5;

var reactorCache = null;

function loadWasi() {
  var wasiModule;
  try {
    wasiModule = require("node:wasi");
  } catch (nodePrefixedError) {
    try {
      wasiModule = require("wasi");
    } catch (plainError) {
      throw new Error(
        "Labyrinth backups need the Node.js WASI module (Node 18+); " +
          "this runtime does not provide it."
      );
    }
  }
  if (!wasiModule || typeof wasiModule.WASI !== "function") {
    throw new Error("The installed Node.js WASI module does not export WASI.");
  }
  return wasiModule.WASI;
}

function download(url, targetPath, redirectsLeft, callback) {
  var request = https.get(url, function(response) {
    var status = response.statusCode || 0;
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      if (redirectsLeft <= 0) {
        callback(new Error("Too many redirects while downloading the Labyrinth module."));
        return;
      }
      download(response.headers.location, targetPath, redirectsLeft - 1, callback);
      return;
    }
    if (status !== 200) {
      response.resume();
      callback(new Error("Failed to download the Labyrinth module (HTTP " + status + ")."));
      return;
    }
    var temporaryPath = targetPath + ".tmp";
    var file = fs.createWriteStream(temporaryPath);
    response.pipe(file);
    file.on("finish", function() {
      file.close(function(closeError) {
        if (closeError) {
          callback(closeError);
          return;
        }
        try {
          fs.renameSync(temporaryPath, targetPath);
        } catch (renameError) {
          callback(renameError);
          return;
        }
        callback(null, targetPath);
      });
    });
    file.on("error", function(writeError) {
      callback(writeError);
    });
  });
  request.on("error", function(requestError) {
    callback(requestError);
  });
}

// options:
//   wasmBuffer - use these bytes directly (no disk cache involved)
//   wasmPath   - cache file for the module (default: os.tmpdir()/labyrinth-repl.wasm)
//   wasmUrl    - override the download URL
function ensureWasm(options, callback) {
  var settings = options || {};
  if (settings.wasmBuffer) {
    callback(null, settings.wasmBuffer);
    return;
  }
  var wasmPath = settings.wasmPath || DEFAULT_WASM_FILE;
  fs.readFile(wasmPath, function(readError, bytes) {
    if (!readError && bytes && bytes.length > 0) {
      callback(null, bytes);
      return;
    }
    var wasmUrl = settings.wasmUrl || LABYRINTH_WASM_URL;
    try {
      fs.mkdirSync(path.dirname(wasmPath), { recursive: true });
    } catch (mkdirError) {
      callback(mkdirError);
      return;
    }
    download(wasmUrl, wasmPath, MAX_REDIRECTS, function(downloadError) {
      if (downloadError) {
        callback(downloadError);
        return;
      }
      fs.readFile(wasmPath, callback);
    });
  });
}

function createReactor(wasmBytes) {
  var WASI = loadWasi();
  var workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fca-labyrinth-"));
  var preopens = {};
  preopens["."] = workingDirectory;
  var wasi = new WASI({
    version: "preview1",
    args: ["Labyrinth_REPL"],
    env: {},
    preopens: preopens,
    returnOnExit: true
  });
  var module = new WebAssembly.Module(wasmBytes);
  var instance = new WebAssembly.Instance(module, wasi.getImportObject());
  if (instance.exports._initialize) {
    wasi.initialize(instance);
  } else {
    try {
      wasi.initialize(instance);
    } catch (initializeError) {
      try {
        wasi.start(instance);
      } catch (startError) {
        // Reactor-style modules do not need _start; the failed attempts above
        // still mark the WASI instance as started, which is what imports check.
      }
    }
  }
  process.once("exit", function() {
    try {
      fs.rmSync(workingDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      // best effort only
    }
  });
  return {
    instance: instance,
    workingDirectory: workingDirectory
  };
}

function getReactor(wasmBytes) {
  var cacheKey = cryptoUtils.sha256(wasmBytes).toString("hex");
  if (reactorCache && reactorCache.key === cacheKey) return reactorCache.reactor;
  var reactor = createReactor(wasmBytes);
  reactorCache = { key: cacheKey, reactor: reactor };
  return reactor;
}

// Runs one LabyrinthCommand and returns the decoded
// AddDeviceEpochDerivationOutput message.
function runLabyrinthCommand(input, options, callback) {
  ensureWasm(options || {}, function(wasmError, wasmBytes) {
    if (wasmError) {
      callback(wasmError);
      return;
    }
    try {
      var reactor = getReactor(wasmBytes);
      var encoded = ebproto.encode("LabyrinthCommand", input);
      var inputPath = path.join(reactor.workingDirectory, "input");
      var outputPath = path.join(reactor.workingDirectory, "output");
      fs.writeFileSync(inputPath, encoded);
      fs.writeFileSync(outputPath, Buffer.alloc(0));
      reactor.instance.exports.execute_command();
      var output = fs.readFileSync(outputPath);
      if (!output || output.length === 0) {
        callback(new Error("The Labyrinth module returned no output for the command."));
        return;
      }
      callback(null, ebproto.decode("AddDeviceEpochDerivationOutput", output));
    } catch (commandError) {
      callback(commandError);
    }
  });
}

module.exports = {
  LABYRINTH_WASM_URL: LABYRINTH_WASM_URL,
  ensureWasm: ensureWasm,
  runLabyrinthCommand: runLabyrinthCommand
};
