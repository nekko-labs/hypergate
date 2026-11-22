import { describe,it,expect } from 'vitest';
import { REGISTRY } from '@hypergate/core';
import { catalogIds, isSetup, type ManagedServerConfig } from '@hypergate/shared';
import { projectSetup } from './cloud-setup.ts';

describe('portable setup',()=>{
  it('only emits catalog ids, enabled flags and desktop choices, never raw server or setting fields',()=>{
    const s:ManagedServerConfig={id:'linear',name:'private',command:'',runtime:'remote',url:'https://mcp.linear.app/mcp',enabled:false,secrets:{KEY:'canary'},env:{NORMAL:'canary'},credentialRefs:{KEY:'canary'},clientSecret:'canary'};
    const settings={startMinimized:false,closeAction:'tray' as const,runOnStartup:true,ignored:'canary'};
    const snapshot=projectSetup(settings,[s,{...s,id:'custom'},{...s,id:'context7',url:'https://example.test/canary'}]);
    expect(snapshot).toEqual({version:1,startMinimized:false,closeAction:'tray',servers:[{catalogId:'linear',enabled:false}]});
    expect(isSetup(snapshot)).toBe(true);expect(isSetup({...snapshot,env:{KEY:'canary'}})).toBe(false);
    expect([...catalogIds].sort()).toEqual(REGISTRY.map(e=>e.id).sort());
  });
});
