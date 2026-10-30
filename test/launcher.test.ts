import { describe, expect, it } from "vitest";
import { type CursorSdk, createCursorLauncher } from "../src/launcher.js";

function fakeSdk({ sendError }: { sendError?: Error } = {}) {
  const calls = { create: [] as unknown[], sent: [] as string[], closed: 0 };
  const sdk: CursorSdk = {
    Agent: {
      async create(options) {
        calls.create.push(options);
        return {
          agentId: "bc-123",
          async send(message) {
            calls.sent.push(message);
            if (sendError) throw sendError;
            return { id: "run-456" };
          },
          close() {
            calls.closed += 1;
          },
        };
      },
    },
  };
  return { sdk, calls };
}

describe("createCursorLauncher", () => {
  it("creates a cloud agent on the GitHub repo from the starting ref, then sends the prompt", async () => {
    const { sdk, calls } = fakeSdk();
    const launcher = createCursorLauncher("key-1", async () => sdk);
    const result = await launcher.launch({ repo: "acme/app", startingRef: "main", prompt: "do it" });
    expect(calls.create).toEqual([
      {
        apiKey: "key-1",
        cloud: { repos: [{ url: "https://github.com/acme/app", startingRef: "main" }], autoCreatePR: true },
      },
    ]);
    expect(calls.sent).toEqual(["do it"]);
    expect(result).toEqual({ agentId: "bc-123", runId: "run-456", agentUrl: "https://cursor.com/agents/bc-123" });
  });

  it("passes the model, with params only when there are some", async () => {
    const { sdk, calls } = fakeSdk();
    const launcher = createCursorLauncher("k", async () => sdk);
    await launcher.launch({ repo: "a/b", startingRef: "main", prompt: "p", model: { id: "m1", params: [] } });
    await launcher.launch({
      repo: "a/b",
      startingRef: "main",
      prompt: "p",
      model: { id: "m2", params: [{ id: "effort", value: "low" }] },
    });
    expect(calls.create.map((c) => (c as { model?: unknown }).model)).toEqual([
      { id: "m1" },
      { id: "m2", params: [{ id: "effort", value: "low" }] },
    ]);
  });

  it("closes the local handle after sending, whether or not send succeeds", async () => {
    const ok = fakeSdk();
    await createCursorLauncher("k", async () => ok.sdk).launch({ repo: "a/b", startingRef: "main", prompt: "p" });
    expect(ok.calls.closed).toBe(1);

    const failing = fakeSdk({ sendError: new Error("boom") });
    await expect(
      createCursorLauncher("k", async () => failing.sdk).launch({ repo: "a/b", startingRef: "main", prompt: "p" }),
    ).rejects.toThrow("boom");
    expect(failing.calls.closed).toBe(1);
  });
});
