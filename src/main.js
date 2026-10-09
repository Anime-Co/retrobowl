// Entry point: create the app, register screens, start.
import { App } from './app.js';
import { registerScreens } from './ui/screens/index.js';

function boot() {
  const app = new App();
  registerScreens(app);
  const sandbox = new URLSearchParams(location.search).has('sandbox');
  app.start(sandbox ? 'sandbox' : 'title');
}

window.addEventListener('error', (e) => console.error('[uncaught]', e.message, e.filename, e.lineno));
window.addEventListener('unhandledrejection', (e) => console.error('[unhandled]', e.reason));

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
