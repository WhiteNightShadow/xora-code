#!/usr/bin/env node
import { once } from "node:events";
import { FakeAcpAgent } from "./agent.js";

const agent = new FakeAcpAgent(async (line) => {
  if (!process.stdout.write(line, "utf8")) await once(process.stdout, "drain");
});

agent.run(process.stdin).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`fake-acp-agent: ${message}\n`);
  process.exitCode = 1;
});
