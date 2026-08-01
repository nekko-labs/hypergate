#!/usr/bin/env node
// The Hypergate daemon, as installed from npm.
//
// The daemon proper is a single bundled file next to this one; all this wrapper
// does is point it at the web UI that ships in the same package, since the
// repo-relative path it uses in development (`apps/web/dist`) does not exist here.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
process.env.HYPERGATE_UI_DIR ||= join(here, '..', 'web');

// pathToFileURL, because a bare Windows path is not a valid import specifier.
await import(pathToFileURL(join(here, '..', 'lib', 'hypergated.mjs')).href);
