"use strict";

var js = require("@eslint/js");
var globals = require("globals");

module.exports = [
  {
    ignores: ["node_modules/**", ".omc/**"]
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: Object.assign({}, globals.node)
    },
    rules: {
      "linebreak-style": ["error", "unix"],
      semi: ["error", "always"],
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }]
    }
  },
  {
    files: ["test/**/*.js"],
    languageOptions: {
      globals: Object.assign({}, globals.mocha)
    }
  }
];
