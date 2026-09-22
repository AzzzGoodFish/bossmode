import { useEffect, useId, useLayoutEffect, useRef, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import icons from './icons.json';
import { OnboardingCharacter, resolvePersonaColor, resolvePersonaShape } from './vendor/character-study';
import { buildRuntimeThemeCss } from './vendor/theme';

export function applyTheme(mode: 'light'|'dark') {
  document.documentElement.dataset.theme = `cursor-${mode}`;
  document.documentElement.classList.toggle('dark', mode === 'dark');
  document.documentElement.style.colorScheme = mode;
  localStorage.setItem('bossmode_theme', mode);
  let style = document.getElementById('gr-theme');
  if (!style) { style = document.createElement('style'); style.id = 'gr-theme'; document.head.append(style); }
  style.textContent = buildRuntimeThemeCss(mode);
}
export function Icon({name}: {name:string}) {
  const item = (icons as Record<string,{viewBox:string;transform:string;d:string}>)[name] ?? icons['info'];
  return <svg className="gr-icon" viewBox={item.viewBox} aria-hidden="true" focusable="false"><path transform={item.transform} d={item.d}/></svg>;
}
export function IconButton({icon,label,className='',...props}: {icon:string;label:string}&ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`gr-iconbtn ${className}`} aria-label={label} title={label} {...props}><Icon name={icon}/></button>;
}
export function Avatar({id,name,size=36,status='idle'}:{id:string;name?:string;size?:number;status?:string}) {
  const color = resolvePersonaColor(id), shape = resolvePersonaShape(id);
  const state = ['working','thinking','searching','sleeping'].includes(status) ? status : 'idle';
  return <span className="gr-avatar" data-color={color} data-shape={shape} style={{'--gr-avatar-size':`${size}px`} as CSSProperties} title={name}>
    <OnboardingCharacter sourceId={id} color={color} shape={shape} sizePx={size} state={state} paused={state==='idle'}/>
  </span>;
}
export function GroupAvatar({members,size=36,username='user'}:{members:string[];size?:number;username?:string}) {
  return <span className="gr-group-avatar" style={{width:size,height:size}}><span className="gr-user-avatar" style={{width:size*19/36,height:size*19/36,left:size*10/36,fontSize:size*5/36}}>{username.slice(0,2)}</span>{members.slice(0,2).map(id=><Avatar key={id} id={id} size={size*22/36}/>)}</span>;
}
export function Modal({title,onClose,children,className=''}:{title:string;onClose:()=>void;children:ReactNode;className?:string}) {
  const ref = useRef<HTMLDialogElement>(null), id = useId();
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  useEffect(()=>{ const el=ref.current!; const prev=document.activeElement as HTMLElement|null; el.showModal(); return ()=>{el.close();if(prev?.isConnected)prev.focus({preventScroll:true});}; },[]);
  return createPortal(<dialog ref={ref} className={`gr-small-dialog ${className}`} aria-labelledby={id} onCancel={e=>{e.preventDefault();onCloseRef.current();}} onClick={e=>{if(e.target!==e.currentTarget)return;const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)onCloseRef.current();}}><IconButton className="gr-dialog-close" icon="close" label={`关闭${title}`} onClick={onClose}/><div id="grDialogBody"><h1 id={id}>{title}</h1>{children}</div></dialog>,document.body);
}
export function Menu({x,y,onClose,children,label='菜单'}:{x:number;y:number;onClose:()=>void;children:ReactNode;label?:string}) {
  const ref=useRef<HTMLDivElement>(null),closeRef=useRef(onClose);closeRef.current=onClose;
  useLayoutEffect(()=>{ const el=ref.current!; const r=el.getBoundingClientRect(); el.style.left=`${Math.max(8,Math.min(x,innerWidth-r.width-8))}px`;el.style.top=`${Math.max(32,Math.min(y,innerHeight-r.height-8))}px`;el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); },[x,y]);
  useEffect(()=>{ const outside=(e:PointerEvent)=>{if(!ref.current?.contains(e.target as Node))closeRef.current();};document.addEventListener('pointerdown',outside); return ()=>document.removeEventListener('pointerdown',outside); },[]);
  return createPortal(<div ref={ref} className="gr-popover gr-live-menu" role="menu" aria-label={label} style={{left:x,top:y}} onKeyDown={e=>{if(e.key==='Escape'||e.key==='Tab'){e.preventDefault();closeRef.current();return;}if(['ArrowUp','ArrowDown','Home','End'].includes(e.key)){e.preventDefault();const items=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));const i=items.indexOf(document.activeElement as HTMLButtonElement);items[e.key==='Home'?0:e.key==='End'?items.length-1:(i+(e.key==='ArrowUp'?-1:1)+items.length)%items.length]?.focus();}}}>{children}</div>,document.body);
}
export function MenuItem({icon,children,...props}:{icon?:string;children:ReactNode}&ButtonHTMLAttributes<HTMLButtonElement>) {return <button type="button" className="gr-menu-item" role="menuitem" {...props}>{icon&&<Icon name={icon}/>}<span className="gr-menu-copy">{children}</span></button>;}
export function Markdown({text}:{text:string}) {return <ReactMarkdown remarkPlugins={[remarkGfm,remarkCjkFriendly]} skipHtml components={{a:({children,...props})=><a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,img:({alt})=><span className="gr-small">[图片：{alt||'请打开附件查看'}]</span>,pre:({children})=><pre className="gr-codeblock">{children}</pre>}}>{text}</ReactMarkdown>;}
export function errorText(error:unknown) {return error instanceof Error ? error.message : String(error);}
export function bytes(size?:number) {return size==null?'':size<1024?`${size} B`:size<1024*1024?`${(size/1024).toFixed(1)} KB`:`${(size/1024/1024).toFixed(1)} MB`;}
export async function copyText(text:string):Promise<boolean> {
  try {if(navigator.clipboard&&isSecureContext)await navigator.clipboard.writeText(text);else{const field=document.createElement('textarea');field.value=text;field.style.cssText='position:fixed;opacity:0;left:0;top:0;width:1px;height:1px';const prev=document.activeElement as HTMLElement|null;(document.querySelector('dialog[open]')||document.body).append(field);field.select();const ok=document.execCommand('copy');field.remove();prev?.focus({preventScroll:true});if(!ok)throw Error('无法复制');}return true;}catch{return false;}
}
