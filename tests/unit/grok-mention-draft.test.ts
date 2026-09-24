import {describe,expect,it} from 'vitest';
import {mentionContent,mentionQueryAtCaret,quoteMention,withManualMention,withQuoteMention} from '../../web/src/grok/mention-draft.js';
import {parseMentions} from '../../src/chat/delivery.js';
const current=[{id:'mem_current',name:'阿岚'},{id:'mem_new',name:'同名'}];
describe('atomic mention drafts',()=>{
 it('quotes a current member by stable ID and uses the current name, not the message label',()=>{
  expect(quoteMention({sender:'旧显示名',senderMemberId:'mem_current'},'fish',current,true)).toEqual({id:'mem_current',label:'阿岚',origin:'quote'});
  expect(mentionContent(' 你好', [{id:'mem_current',label:'旧显示名',origin:'quote'}],'fish',current,true).content).toBe('@阿岚 你好');
 });
 it('does not turn a deleted/left member into the same-name current member',()=>{
  expect(quoteMention({sender:'同名',senderMemberId:'mem_deleted'},'fish',current,true)).toBeUndefined();
  expect(quoteMention({sender:'同名'},'fish',current,true)).toBeUndefined();
  expect(mentionContent('hi',[{id:'mem_deleted',label:'同名',origin:'quote'}],'fish',current,true)).toEqual({content:'hi',unavailable:['同名']});
 });
 it('only auto-tags a human when a room member does not share the display name',()=>{
  expect(quoteMention({sender:'user'},'fish',current,true)).toEqual({id:'user',label:'fish',origin:'quote'});
  expect(quoteMention({sender:'user'},'同名',current,true)).toBeUndefined();
  expect(quoteMention({sender:'user'},'同名',current,false)).toBeUndefined();
  expect(quoteMention({sender:'阿岚',senderMemberId:'mem_current'},'fish',current,false)).toBeUndefined();
  expect(quoteMention({sender:'user'},'all',current,true)).toBeUndefined();
 });
 it('replaces only the quote token, leaving manually chosen chips alone',()=>{
  const manual={id:'mem_current',label:'阿岚',origin:'manual' as const};
  const old={id:'mem_old',label:'旧成员',origin:'quote' as const};
  expect(withQuoteMention([old,manual],{id:'mem_new',label:'同名',origin:'quote'})).toEqual([{id:'mem_new',label:'同名',origin:'quote'},manual]);
  expect(withQuoteMention([old,manual])).toEqual([manual]);
  expect(withQuoteMention([manual],{id:'mem_current',label:'阿岚',origin:'quote'})).toEqual([manual]);
 });
 it('choosing an existing quote target manually keeps it after removing the quote',()=>{
  const quoted={id:'mem_current',label:'阿岚',origin:'quote' as const};
  expect(withQuoteMention(withManualMention([quoted],quoted))).toEqual([{id:'mem_current',label:'阿岚',origin:'manual'}]);
 });
 it('the real room parser resolves the serialized current-name chip without misrouting the human',()=>{
  const recipients=mentionContent('回复', [{id:'mem_current',label:'旧显示名',origin:'quote'}],'fish',current,true);
  expect(parseMentions(recipients.content,current)).toEqual({labels:['阿岚'],memberIds:['mem_current']});
  expect(parseMentions(mentionContent('回复',[{id:'user',label:'fish',origin:'quote'}],'fish',current,true).content,current)).toEqual({labels:[],memberIds:[]});
 });
 it('only offers candidates while the caret is in the active @ expression',()=>{
  const names=['New Member','all'];
  expect(mentionQueryAtCaret('请 @New',6,names)).toEqual({start:2,end:6,query:'New'});
  expect(mentionQueryAtCaret('请 @New 后续正文',3,names)).toEqual({start:2,end:3,query:''});
  expect(mentionQueryAtCaret('请 @New 后续正文',11,names)).toBeNull();
  expect(mentionQueryAtCaret('会保留这些，@ 也已改成正文',18,names)).toBeNull();
  expect(mentionQueryAtCaret('请 @xyz，继续',9,names)).toBeNull();
 });
 it('serializes a mention-only message without inventing body text',()=>{
  expect(mentionContent('',[{id:'mem_current',label:'旧名',origin:'manual',at:0}],'fish',current,true).content).toBe('@阿岚');
  expect(mentionContent('',[{id:'all',label:'all',origin:'manual'}],'fish',[],true).content).toBe('@all');
 });
 it('places an atomic mention within the sentence and still routes by the current ID',()=>{
  const message=mentionContent('请 帮忙',[{id:'mem_current',label:'旧显示名',origin:'manual',at:2}],'fish',current,true);
  expect(message.content).toBe('请 @阿岚 帮忙');
  expect(parseMentions(message.content,current)).toEqual({labels:['阿岚'],memberIds:['mem_current']});
 });
 it('prefixes selected recipients once and never sends an unavailable identity',()=>{
  const selected=[{id:'mem_current',label:'阿岚',origin:'manual' as const},{id:'all',label:'all',origin:'manual' as const}];
  expect(mentionContent('继续正文',selected,'fish',current,true)).toEqual({content:'@阿岚 @all 继续正文',unavailable:[]});
  expect(mentionContent('正文',[{id:'mem_current',label:'阿岚',origin:'manual'}],'fish',[],true)).toEqual({content:'正文',unavailable:['阿岚']});
  expect(mentionContent('正文',[{id:'user',label:'all',origin:'quote'}],'all',current,true)).toEqual({content:'正文',unavailable:['all']});
  expect(quoteMention({sender:'all',senderMemberId:'mem_reserved'},'fish',[{id:'mem_reserved',name:'all'}],true)).toBeUndefined();
  expect(mentionContent('正文',[{id:'mem_reserved',label:'all',origin:'manual'}],'fish',[{id:'mem_reserved',name:'all'}],true)).toEqual({content:'正文',unavailable:['all']});
 });
});
