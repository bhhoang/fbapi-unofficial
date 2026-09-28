"use strict";
/* global BigInt */

// OCMF (Oblivious Consistent Mapping Function) client evolution.
//
// The backup's ocmf client state is a ristretto255 scalar. Adding a device
// evolves it with a fresh random scalar:
//
//   newClientState = clientState * n   (mod l)
//   evolveToken    = n^-1              (mod l)
//
// where l is the ristretto255 group order. The server stores the new state and
// verifies the token's shape; the token is sent as `ocmf_rotation_token` when
// adding a device. Mirrors Meta's ObliviousConsistentMappingFunction.clientEvolve.

var crypto = require("crypto");

var GROUP_ORDER = BigInt("7237005577332262213973186563042994240857116359379907606001950938285454250989");

function bytesToBigIntLE(buffer) {
  var value = BigInt(0);
  for (var i = buffer.length - 1; i >= 0; i--) {
    value = (value << BigInt(8)) + BigInt(buffer[i]);
  }
  return value;
}

function bigIntToBytesLE(value) {
  var out = Buffer.alloc(32);
  var remaining = value;
  for (var i = 0; i < 32; i++) {
    out[i] = Number(remaining & BigInt(255));
    remaining = remaining >> BigInt(8);
  }
  return out;
}

function mod(value, modulus) {
  var result = value % modulus;
  return result < BigInt(0) ? result + modulus : result;
}

function modPow(base, exponent, modulus) {
  var result = BigInt(1);
  var b = mod(base, modulus);
  var e = exponent;
  while (e > BigInt(0)) {
    if (e & BigInt(1)) result = mod(result * b, modulus);
    b = mod(b * b, modulus);
    e = e >> BigInt(1);
  }
  return result;
}

// clientState: 32-byte little-endian scalar (non-zero, less than the group order).
function clientEvolve(clientState) {
  var state = Buffer.from(clientState);
  if (state.length !== 32) {
    throw new Error("OCMF client state must be 32 bytes, got " + state.length + ".");
  }
  var value = bytesToBigIntLE(state);
  if (value === BigInt(0)) {
    throw new Error("OCMF client state is zero.");
  }
  if (value >= GROUP_ORDER) {
    throw new Error("OCMF client state is greater than or equal to the group order.");
  }
  var random;
  do {
    random = mod(bytesToBigIntLE(crypto.randomBytes(32)), GROUP_ORDER);
  } while (random === BigInt(0));
  return {
    newClientState: bigIntToBytesLE(mod(value * random, GROUP_ORDER)),
    evolveToken: bigIntToBytesLE(modPow(random, GROUP_ORDER - BigInt(2), GROUP_ORDER))
  };
}

module.exports = {
  clientEvolve: clientEvolve
};
