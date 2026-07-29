import { describe, expect, it } from 'vitest';

import { gatewaySetupPageUrl } from './gateway-setup-page';

function decodeSetupPage(locale: string): string {
  const url = gatewaySetupPageUrl(locale);
  return decodeURIComponent(url.slice(url.indexOf(',') + 1));
}

describe('gateway setup page', () => {
  it('renders Simplified Chinese copy for Chinese locales', () => {
    const html = decodeSetupPage('zh-CN');

    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('无法连接到 Nanobot Gateway');
    expect(html).toContain('Gateway 地址');
    expect(html).toContain('保存并连接');
  });

  it('renders English copy for other locales', () => {
    const html = decodeSetupPage('en-US');

    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Cannot connect to Nanobot Gateway');
    expect(html).toContain('Gateway URL');
    expect(html).toContain('Save and connect');
  });
});
