import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Supervisor } from './supervisor.js';
import { createGateway } from './gateway.js';
import { gatewayIdentity, HYPERGATE_ICON_DATA_URI } from './identity.js';
import { HYPERGATE_ICON_64_PNG_BASE64 } from './icon-data.js';

describe('gateway identity', () => {
  it('embeds exactly the committed 64x64 PNG', () => {
    const png = readFileSync(new URL('./icon-64.png', import.meta.url));
    expect(HYPERGATE_ICON_64_PNG_BASE64).toBe(png.toString('base64'));
    // PNG signature, then IHDR width and height.
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(64);
    expect(png.readUInt32BE(20)).toBe(64);
  });

  it('introduces itself with a title and icon in initialize', async () => {
    const gateway = createGateway(new Supervisor(), gatewayIdentity('9.9.9'));
    const [gwSide, clientSide] = InMemoryTransport.createLinkedPair();
    await gateway.connect(gwSide);
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    await client.connect(clientSide);
    const info = client.getServerVersion();
    expect(info).toMatchObject({ name: 'hypergate-gateway', title: 'Hypergate', version: '9.9.9' });
    expect(info?.icons?.[0]).toEqual({ src: HYPERGATE_ICON_DATA_URI, mimeType: 'image/png', sizes: ['64x64'] });
    await client.close();
  });
});
