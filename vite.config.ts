import { defineConfig, type Plugin } from 'vite';

/**
 * Baseline CSP for the production build (ticket T5). Injected only for
 * `vite build` so dev-mode HMR (inline modules, websockets) keeps working.
 * The app's scripts, styles and the scheduler Worker are all same-origin.
 */
const contentSecurityPolicy: Plugin = {
  name: 'inject-content-security-policy',
  apply: 'build',
  transformIndexHtml(html) {
    const policy = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "worker-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "media-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; ');
    return html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
    );
  },
};

export default defineConfig({
  plugins: [contentSecurityPolicy],
  server: {
    host: 'localhost',
    port: 5173,
  },
  build: {
    target: 'es2020',
  },
});
