import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import { HYPERGATE_ICON_64_PNG_BASE64 } from './icon-data.js';

/** The app icon as a `data:` URI, so it shows even where the client can't reach the daemon's address. */
export const HYPERGATE_ICON_DATA_URI = `data:image/png;base64,${HYPERGATE_ICON_64_PNG_BASE64}`;

/**
 * How the gateway introduces itself in `initialize`. `title` and `icons` are
 * what MCP clients show in their connections list; `name` stays the stable
 * identifier existing configs and logs already use.
 */
export function gatewayIdentity(version: string): Implementation {
  return {
    name: 'hypergate-gateway',
    title: 'Hypergate',
    version,
    websiteUrl: 'https://hypergate.app',
    icons: [{ src: HYPERGATE_ICON_DATA_URI, mimeType: 'image/png', sizes: ['64x64'] }],
  };
}
