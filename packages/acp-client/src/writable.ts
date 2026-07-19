import type { Writable } from "node:stream";
import type { AcpWrite } from "./types.js";

/**
 * Adapts a Node writable (normally ChildProcess.stdin) to AcpWrite. The callback
 * fires only after the chunk has been handled, so callers naturally wait for
 * stream backpressure instead of accumulating unbounded writes.
 */
export function createNodeWritableSink(writable: Writable): AcpWrite {
  return (line) => new Promise<void>((resolve, reject) => {
    writable.write(line, "utf8", (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
