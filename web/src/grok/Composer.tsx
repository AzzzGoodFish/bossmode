import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent } from 'react';
import {createPortal} from 'react-dom';
import { uploadWithProgress } from '../api/upload-client';
import { apiFetch, type RoomContact, type RoomMessage } from '../api/client';
import { postMessage } from './api';
import { newDraftFileId, getDraft, getDraftGeneration, patchFile, updateDraft, useDraft, type PendingFile } from './drafts';
import { Icon, IconButton, bytes, errorText } from './ui';
import { type ViewFile } from './Files';
import {mentionContent,mentionQueryAtCaret,withQuoteMention,type DraftMention} from './mention-draft';
import {readInlineDraft,writeInlineDraft,plainCaret,placePlainCaret,placeAfterMention,insertPlainText,replacePlainRangeWithMention,deleteAdjacentMention} from './inline-mention-editor';
const jobs=new Map<string,symbol>();
export function Composer({scope,title,contacts,username='user',connected,onSent,onFile,onNeedRecipient}:{scope:string;title:string;username?:string;contacts:RoomContact[];connected:boolean;onSent:(scope:string,message:RoomMessage)=>void;onFile:(files:ViewFile[],index:number)=>void;onNeedRecipient:()=>void}) {
  const draft=useDraft(scope),ref=useRef<HTMLDivElement>(null),wrap=useRef<HTMLDivElement>(null),popupRef=useRef<HTMLUListElement>(null),composing=useRef(false),fileInput=useRef<HTMLInputElement>(null),[mention,setMention]=useState<{start:number;end:number;query:string}|null>(null),[mentionIndex,setMentionIndex]=useState(0),[popupPosition,setPopupPosition]=useState<{left:number;top:number;width:number;maxHeight:number}|null>(null);
  const beforeInput=useCallback((event:InputEvent)=>{const el=event.currentTarget as HTMLDivElement;if(getDraft(scope).busy||composing.current)return;
    if(event.inputType==='insertParagraph'||event.inputType==='insertLineBreak'){event.preventDefault();insertPlainText(el,'\n');const next=readInlineDraft(el);updateDraft(scope,{text:next.text,mentions:next.mentions,error:undefined});setMention(null);return;}
    if(event.inputType==='deleteContentBackward'||event.inputType==='deleteContentForward'){
      if(deleteAdjacentMention(el,event.inputType==='deleteContentBackward'?'backward':'forward')){event.preventDefault();const next=readInlineDraft(el);updateDraft(scope,{text:next.text,mentions:next.mentions,error:undefined});setMention(null);}
    }
  },[scope]);
  const bindInput=useCallback((node:HTMLDivElement|null)=>{ref.current?.removeEventListener('beforeinput',beforeInput);ref.current=node;node?.addEventListener('beforeinput',beforeInput);},[beforeInput]);
  useEffect(()=>{setMention(null);},[scope]);
  useLayoutEffect(()=>{const el=ref.current;if(!el)return;
    const labelFor=(tag:DraftMention)=>tag.id==='user'?username:tag.id==='all'?'all':contacts.find(member=>member.id===tag.id)?.name??tag.label;
    const current=readInlineDraft(el),expected=[...draft.mentions].sort((a,b)=>(a.at??0)-(b.at??0));
    const same=current.text===draft.text&&current.mentions.length===expected.length&&current.mentions.every((tag,i)=>tag.id===expected[i].id&&tag.origin===expected[i].origin&&tag.at===(expected[i].at??0)&&tag.label===labelFor(expected[i]));
    if(same)return;
    const focused=document.activeElement===el,cursor=focused?plainCaret(el):0;
    const newQuote=draft.mentions.find(tag=>tag.origin==='quote'&&!current.mentions.some(before=>before.origin==='quote'&&before.id===tag.id));
    writeInlineDraft(el,draft.text,draft.mentions,labelFor);
    if(newQuote){el.focus({preventScroll:true});placeAfterMention(el,newQuote.id);}else if(focused)placePlainCaret(el,Math.min(cursor,draft.text.length));
  },[scope,draft.text,draft.mentions,contacts,username]);
  useLayoutEffect(()=>{
    const node=wrap.current,root=node?.closest('.gr-chat') as HTMLElement|null,composer=node?.querySelector<HTMLElement>('.gr-composer');if(!node||!root||!composer)return;
    const update=()=>{if(!node.getClientRects().length)return;const box=node.getBoundingClientRect();root.style.setProperty('--gr-compose-height',`${box.height}px`);
      if(!mention){setPopupPosition(null);return;}
      // A portal escapes the short-screen compose wrapper's overflow:auto.
      const anchor=composer.getBoundingClientRect(),width=Math.min(320,Math.max(160,box.width-(innerWidth<=620?20:32)),innerWidth-16),left=Math.max(8,Math.min(box.left+(innerWidth<=620?10:16),innerWidth-width-8));
      const topEdge=Math.min(box.top,anchor.top),above=Math.max(0,topEdge-16),below=Math.max(0,innerHeight-anchor.bottom-16),placeAbove=above>=72||above>=below,available=placeAbove?above:below,maxHeight=Math.min(250,Math.max(40,available)),height=Math.min(popupRef.current?.scrollHeight??maxHeight,maxHeight),top=placeAbove?Math.max(8,topEdge-8-height):Math.min(innerHeight-height-8,anchor.bottom+8);
      setPopupPosition(previous=>previous&&previous.left===left&&previous.top===top&&previous.width===width&&previous.maxHeight===maxHeight?previous:{left,top,width,maxHeight});
    };
    const observer=new ResizeObserver(update);observer.observe(node);observer.observe(composer);if(popupRef.current)observer.observe(popupRef.current);window.addEventListener('resize',update);window.addEventListener('scroll',update,true);update();return()=>{observer.disconnect();window.removeEventListener('resize',update);window.removeEventListener('scroll',update,true);};
  },[scope,!!mention]);
  useEffect(()=>{if(!mention)return;const close=(e:PointerEvent)=>{if(e.target instanceof Node&&!ref.current?.contains(e.target)&&!document.getElementById('grLiveMentions')?.contains(e.target))setMention(null);};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[!!mention]);
  useEffect(()=>{const followCaret=()=>{const el=ref.current;if(!el||document.activeElement!==el||composing.current)return;const next=scope.startsWith('room:')?mentionQueryAtCaret(readInlineDraft(el).text,plainCaret(el),[...contacts.map(m=>m.name),'all']):null;if(next?.start!==mention?.start||next?.end!==mention?.end||next?.query!==mention?.query){setMention(next);setMentionIndex(0);}};document.addEventListener('selectionchange',followCaret);return()=>document.removeEventListener('selectionchange',followCaret);},[scope,mention,contacts]);
  // Native beforeinput also covers soft keyboards without keydown. Bind it to
  // the current inline editor when switching chats or quoted layouts.
  const add=(files:File[])=>{if(getDraft(scope).busy)return;const valid=files.filter(f=>f.size<=1024*1024*1024);updateDraft(scope,{files:[...getDraft(scope).files,...valid.map(file=>({id:newDraftFileId(),file,url:URL.createObjectURL(file),status:'pending' as const,progress:0}))],error:valid.length===files.length?undefined:'超过 1 GB 的文件未添加。'});ref.current?.focus();};
  useEffect(()=>{const handler=(event:Event)=>add((event as CustomEvent<File[]>).detail);const el=document.getElementById('grChat');el?.addEventListener('grok:files',handler);return()=>el?.removeEventListener('grok:files',handler);},[scope]);
  const remove=(file:PendingFile)=>{file.controller?.abort();URL.revokeObjectURL(file.url);updateDraft(scope,{files:getDraft(scope).files.filter(f=>f.id!==file.id)});};
  const cancel=()=>{jobs.delete(scope);for(const f of getDraft(scope).files)f.controller?.abort();updateDraft(scope,{busy:false,error:'上传已取消，文字和附件已保留。',files:getDraft(scope).files.map(f=>f.status==='uploading'?{...f,status:'cancelled'}:f)});};
  const send=async()=>{
    const saved=getDraft(scope);if(saved.busy)return;if(!saved.text.trim()&&!saved.mentions.length&&!saved.files.length)return;if(scope==='new'){onNeedRecipient();return;}const prepared=mentionContent(saved.text,saved.mentions,username,roster,scope.startsWith('room:'));if(prepared.unavailable.length){updateDraft(scope,{error:`点名对象已不在当前会话，请移除 @${prepared.unavailable[0]} 后重试。`});return;}if(!connected){updateDraft(scope,{error:'连接不可用，未发送内容已保留。'});return;}
    const ticket=Symbol(),generation=getDraftGeneration(scope);jobs.set(scope,ticket);updateDraft(scope,{busy:true,posting:false,error:undefined});setMention(null);
    try {for(const file of saved.files){if(jobs.get(scope)!==ticket||generation!==getDraftGeneration(scope))return;if(file.uploaded)continue;const controller=new AbortController();patchFile(scope,file.id,{status:'uploading',progress:0,controller,error:undefined});try{const uploaded=await uploadWithProgress(scope,file.file,{signal:controller.signal,onProgress:(done,total)=>{if(jobs.get(scope)===ticket&&generation===getDraftGeneration(scope))patchFile(scope,file.id,{progress:Math.round(done/total*100)});}});if(jobs.get(scope)!==ticket||generation!==getDraftGeneration(scope))return;patchFile(scope,file.id,{status:'ready',progress:100,uploaded,controller:undefined});}catch(error){if(jobs.get(scope)!==ticket||generation!==getDraftGeneration(scope))return;patchFile(scope,file.id,{status:'error',error:errorText(error),controller:undefined});if((error as {status?:number}).status===401)await apiFetch('/api/chats');throw error;}}
      if(jobs.get(scope)!==ticket||generation!==getDraftGeneration(scope))return;
      const uploaded=getDraft(scope).files.map(f=>f.uploaded!);
      updateDraft(scope,{posting:true});
      const message=await postMessage(scope,prepared.content,uploaded,saved.quote?.seq?{seq:saved.quote.seq}:undefined);
      if(jobs.get(scope)!==ticket||generation!==getDraftGeneration(scope))return;
      for(const f of saved.files)URL.revokeObjectURL(f.url);
      updateDraft(scope,{text:'',mentions:[],files:[],quote:undefined,error:undefined,busy:false});onSent(scope,message);ref.current?.focus();
    }catch(error){if(jobs.get(scope)===ticket&&generation===getDraftGeneration(scope))updateDraft(scope,{busy:false,error:`未能确认发送成功：${errorText(error)}。内容已保留，请核对聊天记录后重试。`});}finally{if(jobs.get(scope)===ticket){jobs.delete(scope);if(generation===getDraftGeneration(scope))updateDraft(scope,{busy:false,posting:false});}}
  };
  const room=scope.startsWith('room:'),roster=room?[...contacts,{id:'all',name:'all',title:''}]:[];
  const candidates=mention?roster.filter(m=>m.name.toLocaleLowerCase().includes(mention.query.toLocaleLowerCase())):[];
  const updateMention=(text:string,cursor:number)=>{setMention(room&&!composing.current?mentionQueryAtCaret(text,cursor,roster.map(m=>m.name)):null);setMentionIndex(0);};
  const syncEditor=(showCandidates=true)=>{const el=ref.current;if(!el)return;const next=readInlineDraft(el);updateDraft(scope,{text:next.text,mentions:next.mentions,error:undefined});if(showCandidates)updateMention(next.text,plainCaret(el));};
  const insertMention=(person:{id:string;name:string})=>{if(!mention||!ref.current)return;const el=ref.current;for(const token of el.querySelectorAll<HTMLElement>('[data-mention-id]'))if(token.dataset.mentionId===person.id)token.remove();const chosen:DraftMention={id:person.id,label:person.name,origin:'manual',at:mention.start};replacePlainRangeWithMention(el,mention.start,mention.end,chosen,person.name);setMention(null);syncEditor(false);};
  const paste=(e:ClipboardEvent<HTMLDivElement>)=>{e.preventDefault();const text=e.clipboardData.getData('text/plain'),files=[...e.clipboardData.files];if(text&&ref.current){insertPlainText(ref.current,text);syncEditor();}if(files.length)add(files);};
  const editor=<div ref={bindInput} id="grDraft" role="textbox" aria-multiline="true" aria-label="消息草稿" data-placeholder={draft.quote?'回复…':`给 ${title} 发消息`} data-short-placeholder={draft.quote?'回复…':'发消息…'} contentEditable={!draft.busy} suppressContentEditableWarning onPaste={paste} onCompositionStart={()=>{composing.current=true;setMention(null);}} onCompositionEnd={e=>{composing.current=false;const el=e.currentTarget;updateMention(readInlineDraft(el).text,plainCaret(el));}} onBlur={e=>{if(!document.getElementById('grLiveMentions')?.contains(e.relatedTarget as Node|null))setMention(null);}} aria-expanded={!!mention} aria-controls={mention?'grLiveMentions':undefined} aria-activedescendant={mention&&candidates.length?`grMention-${mentionIndex%candidates.length}`:undefined} onInput={()=>syncEditor()} onKeyDown={e=>{if(e.nativeEvent.isComposing||e.keyCode===229)return;if(mention){if(e.key==='Tab'){setMention(null);return;}if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();e.stopPropagation();if(candidates.length)setMentionIndex(v=>(v+(e.key==='ArrowDown'?1:-1)+candidates.length)%candidates.length);return;}if(e.key==='Enter'){e.preventDefault();e.stopPropagation();if(candidates.length)insertMention(candidates[mentionIndex%candidates.length]);return;}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setMention(null);return;}}if(e.key==='Enter'){e.preventDefault();if(e.shiftKey){insertPlainText(e.currentTarget,'\n');syncEditor(false);}else void send();}}}/>;
  const quoteLabel=draft.quote?`${draft.quote.sender==='user'?username:contacts.find(c=>c.id===draft.quote?.senderMemberId)?.name??draft.quote.sender} · ${draft.quote.content||'附件消息'}`:'';
  const entry=<div className="gr-compose-entry">{editor}</div>;
  const plus=<button type="button" className="gr-round gr-compose-plus" aria-label="添加附件" title="添加附件" disabled={draft.busy} onClick={()=>fileInput.current?.click()}><Icon name="add"/></button>;
  return <div ref={wrap} className="gr-compose-wrap">
    {draft.files.length>0&&<div className="gr-attachments">{draft.files.map((f,i)=><div className="ga-draft-file" data-state={f.status} key={f.id}><button className="ga-draft-open" aria-label={`预览 ${f.file.name}`} onClick={()=>onFile(draft.files.map(f=>({name:f.file.name,blob:f.file,mimeType:f.file.type,size:f.file.size})),i)}>{f.file.type.startsWith('image/')?<img className="ga-thumb" src={f.url} alt=""/>:<span className="ga-file-icon"><Icon name="file"/></span>}<span className="ga-file-copy"><strong>{f.file.name}</strong><small>{f.status==='uploading'?`上传中 ${f.progress}%`:f.status==='error'?'上传失败':f.status==='cancelled'?'已取消':f.status==='ready'?'已上传 · '+bytes(f.file.size):bytes(f.file.size)}</small></span></button><IconButton icon="close" label={`移除附件 ${f.file.name}`} disabled={draft.busy} onClick={()=>remove(f)}/>{f.status==='uploading'&&<div className="ga-progress" role="progressbar" aria-label={`${f.file.name} 上传进度`} aria-valuenow={f.progress} aria-valuemin={0} aria-valuemax={100}><span style={{width:`${f.progress}%`}}/></div>}</div>)}</div>}
    {draft.error&&<div className="ga-send-error" role="alert"><span>{draft.error}</span><button disabled={draft.busy||!connected} onClick={()=>void send()}>重试</button></div>}
    <div className={`gr-composer ${draft.quote?'ga-replying':''}`} aria-busy={draft.busy}>
      {draft.quote&&<div className="ga-quote" aria-label="引用的消息"><span className="ga-quote-lead"><Icon name="arrow-u-up-right"/></span><span className="ga-quote-text" title={quoteLabel}>{quoteLabel}</span><IconButton icon="close" label="移除引用" disabled={draft.busy} onClick={()=>updateDraft(scope,{quote:undefined,mentions:withQuoteMention(draft.mentions)})}/></div>}
      {draft.quote?<>{entry}{plus}</>:<>{plus}{entry}</>}
      <button className="gr-round gr-primary" aria-label={draft.posting?'正在发送':draft.busy?'取消上传':'发送消息'} disabled={draft.posting||!draft.busy&&(!connected||(!draft.text.trim()&&!draft.mentions.length&&!draft.files.length))} onClick={()=>draft.busy?cancel():void send()}><Icon name={draft.busy?'stop':'arrow-up'}/></button>
    </div>
    {mention&&createPortal(<ul ref={popupRef} id="grLiveMentions" className="gc-mentions gr-live-mentions" role="listbox" aria-label="点名成员" style={{position:'fixed',left:popupPosition?.left??0,top:popupPosition?.top??0,bottom:'auto',width:popupPosition?.width??320,maxHeight:popupPosition?.maxHeight??250,visibility:popupPosition?'visible':'hidden'}}>{candidates.length?candidates.map((m,i)=><li key={m.id} role="presentation"><button id={`grMention-${i}`} className="gc-mention-option" role="option" aria-selected={i===mentionIndex} onClick={()=>insertMention(m)}><span className="gc-mention-name" title={m.id==='all'?'所有成员':m.name}>{m.id==='all'?'所有成员':m.name}</span>{m.title&&<small>{m.title}</small>}</button></li>):<li className="gc-mention-empty" role="status">没有匹配的成员</li>}</ul>,document.body)}
    <input ref={fileInput} type="file" hidden multiple onChange={e=>{add([...e.target.files??[]]);e.target.value='';}}/>
  </div>;
}
