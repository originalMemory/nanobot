interface GatewaySetupCopy {
  title: string;
  description: string;
  gatewayLabel: string;
  connect: string;
  securityHint: string;
  errors: Record<string, string>;
}

const COPY: Record<'en' | 'zh', GatewaySetupCopy> = {
  en: {
    title: 'Cannot connect to Nanobot Gateway',
    description: 'Enter the Gateway address running on your NAS or another device. It will be saved on this device for the next launch.',
    gatewayLabel: 'Gateway URL',
    connect: 'Save and connect',
    securityHint: 'Remote HTTP connections are not encrypted. Use HTTPS for access over the public internet.',
    errors: {
      empty: 'Enter a Gateway URL.',
      invalid: 'Enter a valid address including http:// or https://.',
      unsupported: 'Only HTTP and HTTPS addresses are supported.',
      credentials: 'Do not include a username or password in the URL.',
      fallback: 'Could not save this address.',
    },
  },
  zh: {
    title: '无法连接到 Nanobot Gateway',
    description: '输入运行在 NAS 或其他设备上的 Gateway 地址。地址会保存在本机，下次启动继续使用。',
    gatewayLabel: 'Gateway 地址',
    connect: '保存并连接',
    securityHint: '远端 HTTP 连接未加密；通过公网访问时建议使用 HTTPS。',
    errors: {
      empty: '请输入 Gateway 地址。',
      invalid: '地址格式不正确，请包含 http:// 或 https://。',
      unsupported: '只支持 HTTP 或 HTTPS 地址。',
      credentials: '请不要把用户名或密码写在地址中。',
      fallback: '无法保存该地址。',
    },
  },
};

/** Gateway 不可达时生成不依赖远端资源的本地恢复页。 */
export function gatewaySetupPageUrl(locale: string): string {
  const copy = COPY[locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'];
  const messages = JSON.stringify(copy.errors);
  const gatewaySetupHtml = `<!doctype html>
<html lang="${locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <title>${copy.title}</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #101114; color: #f4f4f5; }
    main { width: min(440px, calc(100vw - 40px)); padding: 32px; border: 1px solid #303238; border-radius: 20px; background: #18191d; box-shadow: 0 24px 80px #0008; }
    h1 { margin: 0 0 10px; font-size: 22px; }
    p { margin: 0 0 22px; color: #a1a1aa; font-size: 14px; line-height: 1.6; }
    label { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 600; }
    input { width: 100%; height: 42px; padding: 0 14px; border: 1px solid #3f3f46; border-radius: 12px; background: #101114; color: inherit; font: inherit; outline: none; }
    input:focus { border-color: #8b5cf6; box-shadow: 0 0 0 3px #8b5cf633; }
    button { width: 100%; height: 42px; margin-top: 14px; border: 0; border-radius: 12px; background: #7c3aed; color: white; font: inherit; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: .6; cursor: wait; }
    #error { min-height: 20px; margin: 10px 0 0; color: #fb7185; font-size: 13px; }
    small { display: block; margin-top: 14px; color: #71717a; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>${copy.title}</h1>
    <p>${copy.description}</p>
    <form id="gateway-form">
      <label for="gateway-url">${copy.gatewayLabel}</label>
      <input id="gateway-url" name="gateway-url" type="url" required spellcheck="false" autocomplete="url" placeholder="http://192.168.1.8:8765">
      <button id="connect" type="submit">${copy.connect}</button>
      <div id="error" role="alert"></div>
      <small>${copy.securityHint}</small>
    </form>
  </main>
  <script>
    const form = document.getElementById('gateway-form');
    const input = document.getElementById('gateway-url');
    const button = document.getElementById('connect');
    const error = document.getElementById('error');
    const messages = ${messages};
    window.nanobotHost.gateway.getUrl().then((url) => { input.value = url; input.select(); });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      button.disabled = true;
      error.textContent = '';
      try {
        const result = await window.nanobotHost.gateway.setUrl(input.value);
        if (!result.ok) {
          error.textContent = messages[result.error] || messages.fallback;
          button.disabled = false;
        }
      } catch (cause) {
        error.textContent = cause instanceof Error ? cause.message : String(cause);
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;

  return `data:text/html;charset=UTF-8,${encodeURIComponent(gatewaySetupHtml)}`;
}
