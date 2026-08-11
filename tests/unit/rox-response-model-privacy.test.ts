import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveClientModelEcho,
  assembleStreamingPipeline,
} from "../../open-sse/handlers/chatCore/streamingPipeline.ts";
import {
  createModelEchoTransform,
  echoModelInObject,
} from "../../open-sse/services/responseModelEcho.ts";

const ROX_PUBLIC_MODEL = "rox/standard";
const RESOLVED_UPSTREAM_MODEL = "provider/private-fallback";

test("ROX JSON responses project the requested public model instead of the resolved target", () => {
  const echoModel = resolveClientModelEcho(ROX_PUBLIC_MODEL, null);
  const response = { model: RESOLVED_UPSTREAM_MODEL, choices: [] };

  echoModelInObject(response, echoModel);

  assert.equal(response.model, ROX_PUBLIC_MODEL);
  assert.notEqual(response.model, RESOLVED_UPSTREAM_MODEL);
});

test("ROX SSE responses project the requested public model instead of the resolved target", async () => {
  const echoModel = resolveClientModelEcho(ROX_PUBLIC_MODEL, null);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ model: RESOLVED_UPSTREAM_MODEL })}\n\n`)
      );
      controller.close();
    },
  });
  const output = input.pipeThrough(createModelEchoTransform(echoModel));
  let text = "";
  for await (const chunk of output as unknown as AsyncIterable<Uint8Array>) {
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();

  assert.match(text, /"model":"rox\/standard"/);
  assert.doesNotMatch(text, /provider\/private-fallback/);
});

test("non-ROX requests retain the existing no-echo behavior", () => {
  const echoModel = resolveClientModelEcho("alias/private", null);
  const response = { model: RESOLVED_UPSTREAM_MODEL, choices: [] };

  echoModelInObject(response, echoModel);

  assert.equal(echoModel, null);
  assert.equal(resolveClientModelEcho("rox/reasoning", null), null);
  assert.equal(response.model, RESOLVED_UPSTREAM_MODEL);
});

test("streaming pipeline receives the forced ROX echo only after normal transforms", () => {
  const transforms: string[] = [];
  const stream = {
    pipeThrough(transform: { name: string }) {
      transforms.push(transform.name);
      return stream;
    },
  };
  assembleStreamingPipeline(
    {
      providerResponse: {},
      transformStream: {},
      streamController: { signal: new AbortController().signal },
      createPiiTransform: undefined,
      clientRawRequestHeaders: null,
      clientResponseFormat: "openai",
      echoModel: resolveClientModelEcho(ROX_PUBLIC_MODEL, null),
      responseHeaders: {},
    } as Parameters<typeof assembleStreamingPipeline>[0],
    {
      wantsProgress: () => false,
      pipeWithDisconnect: () => stream,
      isFeatureFlagEnabled: () => false,
      createPiiSseTransform: () => ({ name: "pii" }),
      createProgressTransform: () => ({ name: "progress" }),
      createSseHeartbeatTransform: () => ({ name: "heartbeat" }),
      shapeForClientFormat: (format) => format,
      createModelEchoTransform: () => ({ name: "echo" }),
    } as Parameters<typeof assembleStreamingPipeline>[1]
  );

  assert.deepEqual(transforms, ["heartbeat", "echo"]);
});
