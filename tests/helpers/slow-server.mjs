// The toy CRM, after a pause: a server that takes a while to start, as an npx
// server does while npx resolves its package.
const delay = Number(process.env.SLOW_SERVER_MS ?? "800");
setTimeout(() => {
  void import(new URL("../../dist/toy-crm.js", import.meta.url).href);
}, delay);
