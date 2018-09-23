'use strict';

const ALPHA = [...range(ord('a'), ord('z')), ...range(ord('A'), ord('Z'))];
const DIGIT = range(ord('0'), ord('9'));

module.exports = {
  ALPHA,
  DIGIT,
  ord,
  char,
};

/**
 * @param {number} from
 * @param {number} to
 * @returns {number[]}
 */
function range(from, to) {
  const list = new Array(to - from + 1);

  for (let i = 0; i < list.length; i += 1) {
    list[i] = from + i;
  }
  return list;
}

/**
 * @param {string} ch
 * @returns {number}
 */
function ord(ch) {
  return ch.toString().charCodeAt(0);
}

/**
 * @param {number} code
 * @returns {string}
 */
function char(code) {
  return String.fromCharCode(code);
}
