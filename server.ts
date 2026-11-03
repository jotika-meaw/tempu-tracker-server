import { bootstrap } from "./bootstrap.js";

// Zero-configuration Express entrypoint for Vercel: the framework preset
// detects this file (it imports the app, which imports express) and serves
// the default-exported app as a single Function. Local dev keeps using
// index.ts (tsx watch, app.listen).
const { app } = await bootstrap();

export default app;
