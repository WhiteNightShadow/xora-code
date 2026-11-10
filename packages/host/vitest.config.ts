import { defineConfig } from 'vitest/config';

// Many of these tests run real engine turns and team runs against the mock model: on a slow machine (Windows CI)
// one takes several seconds, past vitest's default of five.
export default defineConfig({ test: { testTimeout: 30_000 } });
