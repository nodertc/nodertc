'use strict';

const { ALPHA, DIGIT, ord, char } = require('./grammar');

const iceChars = [...ALPHA, ...DIGIT, ord('+'), ord('/')].map(x => char(x));

module.exports = {
  createUsername,
  createPassword,
};

/**
 * @returns {string}
 */
function randomSymbol() {
  return iceChars[parseInt(Math.random() * iceChars.length, 10)];
}

/**
 * @param {number} length
 * @returns {string}
 */
function randomString(length) {
  return Array.from({ length })
    .map(() => randomSymbol())
    .join('');
}

/**
 * @returns {string}
 */
function createUsername() {
  return randomString(4);
}

/**
 * @returns {string}
 */
function createPassword() {
  return randomString(22);
}
