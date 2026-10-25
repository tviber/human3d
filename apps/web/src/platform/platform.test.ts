import {afterEach,describe,expect,it} from 'vitest';
import {webPlatform} from './platform';

const storageDescriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');

afterEach(()=>{
  if(storageDescriptor)Object.defineProperty(globalThis,'localStorage',storageDescriptor);
  else delete (globalThis as {localStorage?:unknown}).localStorage;
});

describe('webPlatform.storage',()=>{
  it('is null when the host has no localStorage',()=>{
    delete (globalThis as {localStorage?:unknown}).localStorage;
    expect(webPlatform.storage).toBeNull();
  });
  it('is null when localStorage access throws (restricted embeds) — boot must not fail',()=>{
    Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new Error('SecurityError');}});
    expect(webPlatform.storage).toBeNull();
  });
  it('exposes the host storage when accessible',()=>{
    const fake={getItem:()=>null,setItem:()=>{}};
    Object.defineProperty(globalThis,'localStorage',{configurable:true,value:fake});
    expect(webPlatform.storage).toBe(fake);
  });
});

describe('webPlatform.clipboardWrite',()=>{
  it('falls back to false when no clipboard exists (caller downloads instead)',async()=>{
    await expect(webPlatform.clipboardWrite('x')).resolves.toBe(false);
  });
});

describe('webPlatform.storageLock',()=>{
  it('refuses an unsafe write when the host has no Web Locks',async()=>{
    let wrote=false;
    const navigatorDescriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');
    try{
      Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});
      await expect(webPlatform.storageLock('library',()=>{wrote=true;})).rejects.toThrow('不支持安全的跨页面保存');
      expect(wrote).toBe(false);
    }finally{
      if(navigatorDescriptor)Object.defineProperty(globalThis,'navigator',navigatorDescriptor);
      else delete (globalThis as {navigator?:unknown}).navigator;
    }
  });
});
