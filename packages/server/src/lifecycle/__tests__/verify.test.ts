import { describe, it, expect, vi } from "vitest";
import { verifyProviderKey, getVerifyConfig } from "../verify.js";

describe("getVerifyConfig", () => {
  it("returns Bearer auth for openai", () => {
    const cfg = getVerifyConfig("openai", "https://api.openai.com/v1");
    expect(cfg.endpoint).toBe("https://api.openai.com/v1/models");
    expect(cfg.authType).toBe("bearer");
  });

  it("returns x-api-key for anthropic", () => {
    const cfg = getVerifyConfig("anthropic", "https://api.anthropic.com/v1");
    expect(cfg.authType).toBe("x-api-key");
  });

  it("returns query param for google", () => {
    const cfg = getVerifyConfig("google", "https://generativelanguage.googleapis.com");
    expect(cfg.authType).toBe("query");
  });

  it("defaults to bearer with /v1/models for unknown provider with baseUrl", () => {
    const cfg = getVerifyConfig("custom-llm", "https://my-llm.example.com/v1");
    expect(cfg.endpoint).toBe("https://my-llm.example.com/v1/models");
    expect(cfg.authType).toBe("bearer");
  });

  it("returns null for unknown provider without baseUrl", () => {
    const cfg = getVerifyConfig("unknown", "");
    expect(cfg).toBeNull();
  });
});

describe("verifyProviderKey", () => {
  it("returns valid when curl returns 200", async () => {
    const exec = { exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "200", stderr: "" }) };
    const result = await verifyProviderKey(exec as any, "openai", "sk-test", "https://api.openai.com/v1");
    expect(result.status).toBe("valid");
  });

  it("returns invalid when curl returns 401", async () => {
    const exec = { exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "401", stderr: "" }) };
    const result = await verifyProviderKey(exec as any, "openai", "sk-test", "https://api.openai.com/v1");
    expect(result.status).toBe("invalid");
  });

  it("returns unknown when curl times out", async () => {
    const exec = { exec: vi.fn().mockResolvedValue({ exitCode: 28, stdout: "000", stderr: "timeout" }) };
    const result = await verifyProviderKey(exec as any, "openai", "sk-test", "https://api.openai.com/v1");
    expect(result.status).toBe("unknown");
    expect(result.error).toContain("timeout");
  });

  it("returns null config for provider without baseUrl", async () => {
    const exec = { exec: vi.fn() };
    const result = await verifyProviderKey(exec as any, "unknown", "key", "");
    expect(result.status).toBe("unknown");
    expect(exec.exec).not.toHaveBeenCalled();
  });
});
