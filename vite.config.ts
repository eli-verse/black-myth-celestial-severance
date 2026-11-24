import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    dedupe: ['three'],
  },
  assetsInclude: [
    '**/*.glb',
    '**/*.gltf',
    '**/*.hdr',
    '**/*.exr',
    '**/*.mp3',
    '**/*.wav',
    '**/*.ogg',
    '**/*.m4a',
  ],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
