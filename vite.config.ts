import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  server: { host: true, port: 5173 },
  build: {
    target: 'es2022',
    rolldownOptions: {
      output: {
        // Keep the game bootstrap independent from the two large, stable
        // rendering libraries. Browsers can fetch these chunks in parallel and
        // retain them in cache while gameplay code changes during development.
        // Rapier remains a separate dynamic chunk loaded behind the menu.
        codeSplitting: {
          groups: [
            {
              name: 'three',
              test: /node_modules[\\/]three[\\/]/,
              priority: 20,
            },
            {
              name: 'postprocessing',
              test: /node_modules[\\/]postprocessing[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
