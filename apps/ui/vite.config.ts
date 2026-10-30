import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The bundle is served from xora://app/ui/ by the bootstrap, so every asset URL must be relative.
export default defineConfig({
    base: './',
    plugins: [react()],
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2023',
        sourcemap: false,
        assetsInlineLimit: 0,
    },
});
