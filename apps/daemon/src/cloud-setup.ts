import { catalogIds, registryConnections, type DaemonSettings, type ManagedServerConfig, type PortableSetup } from '@hypergate/shared';
import { REGISTRY } from '@hypergate/core';

// A custom server sharing a catalog ID must not silently become a portable catalog entry.
export function projectSetup(settings: DaemonSettings, servers: ManagedServerConfig[]): PortableSetup {
  return { version: 1, startMinimized: settings.startMinimized, closeAction: settings.closeAction,
    servers: catalogIds.flatMap(catalogId => {
      const entry = REGISTRY.find(e=>e.id===catalogId), cfg = servers.find(s=>s.id===catalogId);
      if (!entry || !cfg || !registryConnections(entry).some(c=>c.runtime===cfg.runtime && (c.url??'')===(cfg.url??'') &&
        (c.image??'')===(cfg.image??'') && (c.command??'')===(cfg.command??'') && JSON.stringify(c.args??[])===JSON.stringify(cfg.args??[]))) return [];
      return [{catalogId, enabled:cfg.enabled===true}];
    }) };
}
