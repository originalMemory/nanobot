import { describe, expect, it } from 'vitest';

import { nativeWindowHandleValue } from './windows-focus';

describe('Windows foreground handle conversion', () => {
  it('reads 64-bit and 32-bit Electron native handles', () => {
    const handle64 = Buffer.alloc(8);
    handle64.writeBigUInt64LE(42n);
    const handle32 = Buffer.alloc(4);
    handle32.writeUInt32LE(24);

    expect(nativeWindowHandleValue(handle64)).toBe('42');
    expect(nativeWindowHandleValue(handle32)).toBe('24');
    expect(nativeWindowHandleValue(Buffer.alloc(2))).toBeNull();
  });
});
