import {useEffect,useRef,useState,type ReactNode} from 'react';
import {diagramLabel,MAX_DIAGRAM_SOURCE,safeDiagramSvg} from './mermaid-safe';
type Mode='light'|'dark';
let sequence=0,renderQueue:Promise<void>=Promise.resolve();
function queuedDiagram(source:string,theme:Mode):Promise<string> {
 const render=async()=>{
  const {default:mermaid}=await import('mermaid');
  const dark=theme==='dark';
  mermaid.initialize({
   startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,
   htmlLabels:false,maxTextSize:MAX_DIAGRAM_SOURCE,theme:'base',logLevel:'error',
   flowchart:{useMaxWidth:false,htmlLabels:false},
   themeVariables:dark?{
    background:'#282c34',primaryColor:'#383e49',primaryTextColor:'#e1e6ee',primaryBorderColor:'#8190a2',
    secondaryColor:'#2d323b',tertiaryColor:'#363b45',lineColor:'#b9c3d1',textColor:'#e1e6ee',
   }:{
    background:'#fcfcfc',primaryColor:'#f0f0f0',primaryTextColor:'#141414',primaryBorderColor:'#777777',
    secondaryColor:'#f7f7f7',tertiaryColor:'#e8e8e8',lineColor:'#777777',textColor:'#141414',
   },
  });
  if(!await mermaid.parse(source,{suppressErrors:true}))throw Error('Invalid diagram source');
  return (await mermaid.render(`gr-mermaid-${++sequence}`,source)).svg;
 };
 const task=renderQueue.then(render,render);
 renderQueue=task.then(()=>undefined,()=>undefined);
 return task;
}
export function MermaidFigure({source,fallback,onCopy}:{source:string;fallback:ReactNode;onCopy:()=>Promise<boolean>}) {
 const name=diagramLabel(source),ref=useRef<HTMLDivElement>(null),[near,setNear]=useState(false),[theme,setTheme]=useState<Mode>(()=>typeof document!=='undefined'&&document.documentElement.dataset.theme==='cursor-dark'?'dark':'light'),[view,setView]=useState<'diagram'|'source'>('diagram'),[status,setStatus]=useState<'loading'|'ready'|'failed'>(name?'loading':'failed'),[image,setImage]=useState<{url:string;width:number}|null>(null),[copied,setCopied]=useState(false),[scrollHint,setScrollHint]=useState(false);
 useEffect(()=>{const node=ref.current;if(!node)return;if(!('IntersectionObserver'in window)){setNear(true);return;}const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){setNear(true);observer.disconnect();}},{rootMargin:'400px'});observer.observe(node);return()=>observer.disconnect();},[]);
 useEffect(()=>{const update=()=>setTheme(document.documentElement.dataset.theme==='cursor-dark'?'dark':'light');const observer=new MutationObserver(update);observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});return()=>observer.disconnect();},[]);
 useEffect(()=>{if(!name||!near)return;let live=true,objectUrl:string|null=null;setStatus('loading');setImage(null);setScrollHint(false);
  void queuedDiagram(source,theme).then(svg=>{const safe=safeDiagramSvg(svg);objectUrl=URL.createObjectURL(new Blob([safe.markup],{type:'image/svg+xml;charset=utf-8'}));if(live){setImage({url:objectUrl,width:safe.width});setStatus('ready');}else URL.revokeObjectURL(objectUrl);}).catch(()=>{if(live){setStatus('failed');setView('source');}});
  return()=>{live=false;if(objectUrl)URL.revokeObjectURL(objectUrl);};
 },[source,theme,near,name]);
 const showSource=view==='source'||status!=='ready'||!image;
 return <div className="gc-mermaid" ref={ref} aria-label={`Mermaid ${name??'源码'}`}>
  <div className="gc-mermaid-bar"><span>{name??'Mermaid 源码'}{scrollHint?' · 可滚动':''}</span><div className="gc-mermaid-actions"><button type="button" aria-pressed={!showSource} disabled={!name||status==='failed'} onClick={()=>setView('diagram')}>图示</button><button type="button" aria-pressed={showSource} onClick={()=>setView('source')}>源码</button>{!showSource&&<button type="button" onClick={()=>void onCopy().then(ok=>{setCopied(ok);setTimeout(()=>setCopied(false),1800);})}>{copied?'已复制':'复制源码'}</button>}</div></div>
  {showSource?<>{name&&status==='loading'&&<p className="gc-mermaid-note" role="status">正在绘制，源码可先阅读。</p>}{status==='failed'&&<p className="gc-mermaid-note" role="status">{name?'暂时无法绘制，已保留源码。':'此类图示暂不支持，已保留源码。'}</p>}{fallback}</>:<div className="gc-mermaid-canvas" tabIndex={0} aria-label={`${name}，可横向滚动查看`}><img src={image.url} alt={`${name}，源码可通过上方按钮查看`} style={{width:image.width}} onLoad={event=>{const parent=event.currentTarget.parentElement;if(parent)setScrollHint(parent.scrollWidth>parent.clientWidth+2||parent.scrollHeight>parent.clientHeight+2);}} onError={()=>{setStatus('failed');setView('source');}}/></div>}
 </div>;
}
