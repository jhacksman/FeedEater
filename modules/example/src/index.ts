import type { NatsConnection, StringCodec } from "nats";
import { v4 as uuidv4 } from "uuid";

import { NormalizedMessageSchema, subjectFor } from "@feedeater/core";

export async function runExampleTick(params: { nats: NatsConnection; sc: StringCodec }) {
  const msg = NormalizedMessageSchema.parse({
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    source: { module: "example", stream: "scheduler" },
    content: { text: "Hello from FeedEater example module" },
    tags: { example: true },
  });

  params.nats.publish(subjectFor("example", "messageCreated"), params.sc.encode(JSON.stringify(msg)));
}

export { createModuleRuntime } from "./runtime.js";


