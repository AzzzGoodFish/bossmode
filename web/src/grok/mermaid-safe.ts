/* Diagram input is untrusted chat text. Only the two diagram families requested
 * for chat are rendered; everything else remains readable as source. */
export const MAX_DIAGRAM_SOURCE=12_000;
export function diagramLabel(source:string):'类图'|'流程图'|null {
 if(source.length>MAX_DIAGRAM_SOURCE||/[\u0000]/u.test(source)||/%%\s*\{|^\s*(?:click|classDef|style|linkStyle)\b/im.test(source))return null;
 const first=source.trimStart().split(/\r?\n/,1)[0].trim();
 if(/^classDiagram(?:-v2)?$/i.test(first))return '类图';
 if(/^(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)$/i.test(first))return '流程图';
 return null;
}

/** Render as an SVG *image* Blob, never inject generated markup into the app.
 * Strip resource/link elements as defense-in-depth, even in strict Mermaid. */
export function safeDiagramSvg(svg:string):{markup:string;width:number} {
 if(svg.length>750_000)throw Error('Diagram output too large');
 const document=new DOMParser().parseFromString(svg,'image/svg+xml'),root=document.documentElement;
 if(root.localName!=='svg'||document.querySelector('parsererror'))throw Error('Invalid diagram output');
 const forbidden=new Set(['script','foreignObject','image','iframe','object','embed','animate','set','animateTransform']);
 for(const element of [root,...root.querySelectorAll('*')]){
  if(forbidden.has(element.localName)){element.remove();continue;}
  if(element.localName==='a'){
   const parent=element.parentNode;if(parent){while(element.firstChild)parent.insertBefore(element.firstChild,element);element.remove();}
   continue;
  }
  if(element.localName==='style'&&/@import|url\s*\(\s*(?!['"]?#)/i.test(element.textContent??''))throw Error('External diagram style blocked');
  for(const attribute of [...element.attributes]){
   const name=attribute.name.toLowerCase(),value=attribute.value;
   if(name.startsWith('on')||name==='href'||name==='xlink:href'||name==='src'||/\b(?:https?:|data:|javascript:)/i.test(value)||name==='style'&&/url\s*\(\s*(?!['"]?#)/i.test(value))element.removeAttribute(attribute.name);
  }
 }
 const viewBox=(root.getAttribute('viewBox')??'').split(/[\s,]+/).map(Number),declared=parseFloat(root.getAttribute('width')??'');
 const width=Number.isFinite(viewBox[2])&&viewBox[2]>0?viewBox[2]:Number.isFinite(declared)&&declared>0?declared:640;
 return {markup:new XMLSerializer().serializeToString(root),width:Math.max(160,Math.min(1800,width))};
}
