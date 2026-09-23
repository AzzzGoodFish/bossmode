import {markMentions} from "./mention-markup";
import { useEffect, useId, useLayoutEffect, useRef, useState, isValidElement, createContext, useContext, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
Object.entries({javascript,typescript,tsx,jsx,python,bash,json,yaml,sql,markup,css,diff}).forEach(([name,grammar])=>SyntaxHighlighter.registerLanguage(name,grammar));
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
const AppearanceContext = createContext<Record<string,{avatarColor?:string|null;avatarShape?:string|null}>>({});
export const AvatarAppearanceProvider = AppearanceContext.Provider;
export function Avatar({id,name,size=36,status='idle',color:givenColor,shape:givenShape,animated=false,followPointer=false}:{id:string;name?:string;size?:number;status?:string;color?:string|null;shape?:string|null;animated?:boolean;followPointer?:boolean}) {
  const appearance=useContext(AppearanceContext)[id];
  const [reduced,setReduced]=useState(()=>typeof window!=='undefined'&&!!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  useEffect(()=>{if(!window.matchMedia)return;const media=window.matchMedia('(prefers-reduced-motion: reduce)'),update=()=>setReduced(media.matches);media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
  const color = resolvePersonaColor(id,givenColor??appearance?.avatarColor), shape = resolvePersonaShape(id,givenShape??appearance?.avatarShape);
  const state = ['working','thinking','searching','sleeping'].includes(status) ? status : 'idle';
  return <span className="gr-avatar" data-color={color} data-shape={shape} style={{'--gr-avatar-size':`${size}px`} as CSSProperties} title={name}>
    <OnboardingCharacter sourceId={id} color={color} shape={shape} sizePx={size} state={state} paused={reduced||!animated&&state==='idle'} isFollowingPointer={followPointer&&!reduced}/>
  </span>;
}
export function GroupAvatar({members,size=36,username='user'}:{members:string[];size?:number;username?:string}) {
  if(!members.length)return <span className="gr-group-avatar gc-empty-group" style={{width:size,height:size}}><span className="gr-user-avatar" style={{width:size,height:size,fontSize:size*.24,left:0,top:0}}>{username.slice(0,2)}</span></span>;
  return <span className="gr-group-avatar" style={{width:size,height:size}}><span className="gr-user-avatar" style={{width:size*19/36,height:size*19/36,left:size*10/36,fontSize:size*5/36}}>{username.slice(0,2)}</span>{members.slice(0,2).map(id=><Avatar key={id} id={id} size={size*22/36}/>)}</span>;
}
export function Modal({title,onClose,children,className=''}:{title:string;onClose:()=>void;children:ReactNode;className?:string}) {
  const ref = useRef<HTMLDialogElement>(null), id = useId();
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  useEffect(()=>{ const el=ref.current!; const prev=document.activeElement as HTMLElement|null; el.showModal(); return ()=>{el.close();if(prev?.isConnected)prev.focus({preventScroll:true});}; },[]);
  return createPortal(<dialog ref={ref} className={`gr-small-dialog ${className}`} aria-labelledby={id} onCancel={e=>{e.preventDefault();onCloseRef.current();}} onClick={e=>{if(e.target!==e.currentTarget)return;const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)onCloseRef.current();}}><IconButton className="gr-dialog-close" icon="close" label={`关闭${title}`} onClick={onClose}/><div id="grDialogBody"><h1 id={id}>{title}</h1>{children}</div></dialog>,document.body);
}
export function Menu({x,y,onClose,onBack,children,label='菜单',width=228,trigger,placement}:{x:number;y:number;onClose:()=>void;onBack?:()=>void;children:ReactNode;label?:string;width?:number;trigger?:HTMLElement|null;placement?:'above'}) {
  const ref=useRef<HTMLDivElement>(null),closeRef=useRef(onClose),previousFocus=useRef(document.activeElement as HTMLElement|null),portal=useRef<HTMLElement>(previousFocus.current?.closest<HTMLDialogElement>('dialog[open]')??document.body);closeRef.current=onClose;
  useLayoutEffect(()=>{const el=ref.current!;if(typeof el.showPopover==='function'&&!el.matches(':popover-open'))el.showPopover();const place=()=>{const r=el.getBoundingClientRect(),anchor=placement==='above'&&trigger?.isConnected?trigger.getBoundingClientRect():null;const above=anchor?anchor.top-r.height-6:y,below=anchor?anchor.bottom+6:y;const top=anchor?(above>=8?above:below+r.height<=innerHeight-8?below:8):y;el.style.left=`${Math.max(8,Math.min(anchor?.left??x,innerWidth-r.width-8))}px`;el.style.top=`${Math.max(8,Math.min(top,innerHeight-r.height-8))}px`;};place();(el.querySelector<HTMLButtonElement>('button[data-return-focus="true"]:not(:disabled),button[aria-checked="true"]:not(:disabled),button[aria-selected="true"]:not(:disabled)')??el.querySelector<HTMLButtonElement>('button:not(:disabled)')??el).focus();const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(place);observer?.observe(el);window.addEventListener('resize',place);return()=>{observer?.disconnect();window.removeEventListener('resize',place);if(typeof el.hidePopover==='function'&&el.matches(':popover-open'))el.hidePopover();};},[x,y,trigger,placement]);
  useLayoutEffect(()=>{const el=ref.current!;if(document.activeElement===document.body)(el.querySelector<HTMLButtonElement>('button[data-return-focus="true"]:not(:disabled),button[aria-checked="true"]:not(:disabled),button[aria-selected="true"]:not(:disabled),button:not(:disabled)')??el).focus();},[children]);
  useLayoutEffect(()=>{const el=ref.current!;return()=>{const previous=previousFocus.current;if(previous?.isConnected&&previous.getClientRects().length&&(el.contains(document.activeElement)||document.activeElement===document.body))previous.focus({preventScroll:true});};},[]);
  useEffect(()=>{ const outside=(e:PointerEvent)=>{if(!ref.current?.contains(e.target as Node)&&!trigger?.contains(e.target as Node))closeRef.current();};document.addEventListener('pointerdown',outside); return ()=>document.removeEventListener('pointerdown',outside); },[trigger]);
  return createPortal(<div ref={ref} className="gr-popover gr-live-menu" role="menu" tabIndex={-1} popover="manual" aria-label={label} style={{left:x,top:y,width,right:'auto',bottom:'auto'}} onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f'){closeRef.current();return;}if((e.key==='Escape'||e.key==='ArrowLeft')&&onBack){e.preventDefault();e.stopPropagation();onBack();return;}if(e.key==='Escape'||e.key==='Tab'){e.preventDefault();e.stopPropagation();closeRef.current();return;}if(['ArrowUp','ArrowDown','Home','End'].includes(e.key)){e.preventDefault();e.stopPropagation();const items=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));const i=items.indexOf(document.activeElement as HTMLButtonElement);items[e.key==='Home'?0:e.key==='End'?items.length-1:i<0?(e.key==='ArrowUp'?items.length-1:0):(i+(e.key==='ArrowUp'?-1:1)+items.length)%items.length]?.focus();}}}>{children}</div>,portal.current);
}
export function MenuItem({icon,children,meta,...props}:{icon?:string;children:ReactNode;meta?:ReactNode}&ButtonHTMLAttributes<HTMLButtonElement>) {return <button type="button" className="gr-menu-item" role="menuitem" {...props}>{icon&&<Icon name={icon}/>}<span className="gr-menu-copy">{children}</span>{meta&&<span className="gr-menu-meta">{meta}</span>}</button>;}
export function Markdown({text,onLink,mentions=[]}:{text:string;onLink?:(href:string)=>void;mentions?:string[]}) {return <ReactMarkdown remarkPlugins={[remarkGfm,remarkCjkFriendly]} rehypePlugins={[[markMentions,{names:mentions}]]} skipHtml components={{a:({children,href,...props})=><a {...props} href={href} target={onLink?undefined:'_blank'} rel="noopener noreferrer" onClick={onLink?e=>{e.preventDefault();onLink(href??'');}:undefined}>{children}</a>,img:({alt})=><span className="gr-small">[图片：{alt||'请打开附件查看'}]</span>,pre:({children})=><CodeFigure>{children}</CodeFigure>,table:({children})=><div className="gc-table-scroll" tabIndex={0} aria-label="表格，可横向滚动"><table>{children}</table></div>}}>{text}</ReactMarkdown>;}
function CodeFigure({children}:{children:ReactNode}) {const [copied,setCopied]=useState(false);const props=isValidElement<{children?:string;className?:string}>(children)?children.props:{};const text=String(props.children??''),language=props.className?.replace('language-','')??'text';return <div className="gc-code-figure"><SyntaxHighlighter language={language} useInlineStyles={false} customStyle={{margin:0}} tabIndex={0} aria-label={`${language} 代码`}>{text}</SyntaxHighlighter><IconButton icon={copied?'check':'copy'} label={copied?'已复制代码':'复制代码'} onClick={()=>void copyText(text).then(ok=>{setCopied(ok);setTimeout(()=>setCopied(false),2000);})}/></div>;}
export function errorText(error:unknown) {return error instanceof Error ? error.message : String(error);}
export function bytes(size?:number) {return size==null?'':size<1024?`${size} B`:size<1024*1024?`${(size/1024).toFixed(1)} KB`:`${(size/1024/1024).toFixed(1)} MB`;}
export async function copyText(text:string):Promise<boolean> {
  try {if(navigator.clipboard&&isSecureContext)await navigator.clipboard.writeText(text);else{const field=document.createElement('textarea');field.value=text;field.style.cssText='position:fixed;opacity:0;left:0;top:0;width:1px;height:1px';const prev=document.activeElement as HTMLElement|null;(document.querySelector('dialog[open]')||document.body).append(field);field.select();const ok=document.execCommand('copy');field.remove();prev?.focus({preventScroll:true});if(!ok)throw Error('无法复制');}return true;}catch{return false;}
}
