import {afterEach,expect,it,vi} from 'vitest';
import {clearDrafts,getDraft,newDraftFileId,pauseUploads,updateDraft} from '../../web/src/grok/drafts.js';
afterEach(()=>{clearDrafts();vi.unstubAllGlobals();});
it('creates distinct draft file keys when randomUUID is unavailable on HTTP',()=>{
 const crypto=globalThis.crypto;vi.stubGlobal('crypto',{getRandomValues:crypto.getRandomValues.bind(crypto)});
 const ids=Array.from({length:40},newDraftFileId);expect(new Set(ids).size).toBe(40);expect(ids.every(id=>/^[a-f0-9]{32}$/.test(id))).toBe(true);
});
it('preserves unsent files, quotes and text while pausing an expired login',()=>{
 const file=new File(['# preserved'],'fixture.md',{type:'text/markdown'}),url=URL.createObjectURL(file),controller=new AbortController();
 updateDraft('room:fixture',{text:'unsent',quote:{id:'fixture-message',seq:1} as never,busy:true,files:[{id:newDraftFileId(),file,url,controller,status:'uploading',progress:25}]});pauseUploads();
 const draft=getDraft('room:fixture');expect(draft.text).toBe('unsent');expect(draft.quote?.id).toBe('fixture-message');expect(draft.files[0].file).toBe(file);expect(draft.files[0].status).toBe('cancelled');expect(controller.signal.aborted).toBe(true);expect(draft.busy).toBe(false);
});
