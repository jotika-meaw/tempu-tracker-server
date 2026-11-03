import type { Express } from "express";
import { bootstrap } from "./bootstrap.js";

// Zero-configuration Express entrypoint for Vercel: the framework preset
// detects this file and serves the default-exported app as a single
// Function. Local dev keeps using index.ts (tsx watch, app.listen);
// shared startup lives in bootstrap.ts and the factory in create-app.ts.
const { app }: { app: Express } = await bootstrap();

export default app;
