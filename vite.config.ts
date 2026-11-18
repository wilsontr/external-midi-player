import { defineConfig, type Plugin } from 'vite';

/**
 * Baseline CSP for the production build (ticket T5). Injected only for
 * `vite build` so dev-mode HMR (inline modules, websockets) keeps working.
 * The app's scripts, styles, the scheduler Worker and the LCD font served from
 * `public/fonts/` are all same-origin (T11).
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
      "font-src 'self'",
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
  /**
   * Relative asset URLs (ticket T6): the build must run from a GitHub Pages
   * project subpath (`/external-midi-player/`), from a user page and from a
   * custom domain without hard-coding the repository name. There are no
   * client-side routes, so nothing needs an absolute base. `dev` and the
   * Playwright suite are unaffected; the public font URLs in `styles.css`
   * resolve to `../fonts/…` in the built stylesheet.
   */
  base: './',
  plugins: [contentSecurityPolicy],
  server: {
    host: 'localhost',
    port: 5173,
  },
  build: {
    target: 'es2020',
  },
});
