const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nativeWindowHandleValue } = require('../windows-focus.cjs');

test('读取 64 位原生窗口句柄', () => {
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(9_007_199_254_740_993n);
  assert.equal(nativeWindowHandleValue(handle), '9007199254740993');
});

test('兼容 32 位原生窗口句柄并拒绝空句柄', () => {
  const handle = Buffer.alloc(4);
  handle.writeUInt32LE(4_294_967_295);
  assert.equal(nativeWindowHandleValue(handle), '4294967295');
  assert.equal(nativeWindowHandleValue(Buffer.alloc(0)), null);
});
