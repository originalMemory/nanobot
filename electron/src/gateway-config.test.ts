import { describe, expect, it } from 'vitest';

import {
  gatewaySecretForUrl,
  gatewayUrlFromArgv,
  normalizeGatewayUrl,
  resolveGatewayUrl,
} from './gateway-config';

describe('gateway URL config', () => {
  it.each([
    ['http://127.0.0.1:8765/', 'http://127.0.0.1:8765'],
    ['http://192.168.1.8:8765', 'http://192.168.1.8:8765'],
    ['https://nanobot.example.com/path?ignored=1', 'https://nanobot.example.com'],
  ])('accepts an explicit HTTP(S) gateway origin', (input, expected) => {
    expect(normalizeGatewayUrl(input)).toEqual({ ok: true, url: expected });
  });

  it.each([
    ['', 'empty'],
    ['nanobot.example.com', 'invalid'],
    ['file:///tmp/nanobot', 'unsupported'],
    ['https://user:secret@nanobot.example.com', 'credentials'],
  ] as const)('rejects unsafe gateway URL %s', (input, error) => {
    expect(normalizeGatewayUrl(input)).toEqual({ ok: false, error });
  });

  it("reads both gateway URL command-line forms", () => {
    expect(gatewayUrlFromArgv(["electron", ".", "--gateway-url", "https://cli.example"]))
      .toBe("https://cli.example");
    expect(gatewayUrlFromArgv(["electron", ".", "--gateway-url=https://inline.example"]))
      .toBe("https://inline.example");
  });

  it("resolves CLI, environment, stored, and default URLs in order", () => {
    expect(resolveGatewayUrl({
      argv: ["electron", ".", "--gateway-url=https://cli.example"],
      envUrl: "https://env.example",
      storedUrl: "https://stored.example",
    })).toEqual({ url: "https://cli.example", source: "cli" });
    expect(resolveGatewayUrl({
      argv: [],
      envUrl: "https://env.example",
      storedUrl: "https://stored.example",
    })).toEqual({ url: "https://env.example", source: "env" });
    expect(resolveGatewayUrl({
      argv: [],
      envUrl: "invalid",
      storedUrl: "https://stored.example/path",
    })).toEqual({ url: "https://stored.example", source: "stored" });
    expect(resolveGatewayUrl({ argv: [], envUrl: "", storedUrl: "" })).toEqual({
      url: "http://127.0.0.1:8765",
      source: "default",
    });
  });

  it("only returns a secret for its bound gateway origin", () => {
    expect(gatewaySecretForUrl({
      gatewayUrl: "https://nas.example",
      storedUrl: "https://nas.example",
      token: "secret",
    })).toBe("secret");
    expect(gatewaySecretForUrl({
      gatewayUrl: "https://other.example",
      storedUrl: "https://nas.example",
      tokenOrigin: "https://nas.example",
      token: "secret",
    })).toBe("");
    expect(gatewaySecretForUrl({
      gatewayUrl: "https://nas.example",
      storedUrl: "https://old.example",
      tokenOrigin: "https://nas.example",
      token: " secret ",
    })).toBe("secret");
  });
});
