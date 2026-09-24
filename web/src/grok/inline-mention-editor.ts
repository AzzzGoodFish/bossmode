import type {DraftMention} from './mention-draft';

/** The editor keeps native text nodes. Mentions are inline non-editable text,
 * not buttons outside the text flow. The model stores their plain-text offset. */
export function readInlineDraft(root:Node):{text:string;mentions:DraftMention[];units:(string|HTMLElement)[]} {
 let text='';const mentions:DraftMention[]=[],units:(string|HTMLElement)[]=[];
 const add=(value:string)=>{const normalized=value.replace(/\u00a0/g,' ');text+=normalized;for(let i=0;i<normalized.length;i++)units.push(normalized[i]);};
 const visit=(node:Node)=>{
  if(node.nodeType===Node.TEXT_NODE){add(node.textContent??'');return;}
  if(node instanceof HTMLElement&&node.hasAttribute('data-mention-id')){
   mentions.push({id:node.dataset.mentionId!,label:node.textContent?.replace(/^@/,'')??'',origin:node.dataset.mentionOrigin==='quote'?'quote':'manual',at:text.length});units.push(node);return;
  }
  if(node instanceof HTMLBRElement){add('\n');return;}
  for(const child of node.childNodes){
   if(child instanceof HTMLElement&&/^(DIV|P)$/i.test(child.tagName)&&text&&!text.endsWith('\n'))add('\n');
   visit(child);
  }
 };
 visit(root);
 // Chrome represents a trailing caret line as <div><br></div>; the final
 // <br> is a placeholder, not an extra authored newline.
 const last=root.lastChild;
 if(last instanceof HTMLElement&&/^(DIV|P)$/i.test(last.tagName)&&last.childNodes.length===1&&last.firstChild instanceof HTMLBRElement&&text.endsWith('\n')){text=text.slice(0,-1);units.pop();}
 return {text,mentions,units};
}
export function writeInlineDraft(root:HTMLElement,text:string,mentions:readonly DraftMention[],labelFor:(mention:DraftMention)=>string) {
 const doc=root.ownerDocument,fragment=doc.createDocumentFragment();let cursor=0;
 for(const mention of mentions.map((value,index)=>({value,index})).sort((a,b)=>(a.value.at??0)-(b.value.at??0)||a.index-b.index)){
  const at=Math.max(cursor,Math.min(text.length,mention.value.at??0));
  if(at>cursor)fragment.append(doc.createTextNode(text.slice(cursor,at)));
  const span=doc.createElement('span');span.className='gr-mention-inline';span.contentEditable='false';span.dataset.mentionId=mention.value.id;span.dataset.mentionOrigin=mention.value.origin;span.title='按退格可整段删除';span.textContent=`@${labelFor(mention.value)}`;fragment.append(span);cursor=at;
 }
 if(cursor<text.length)fragment.append(doc.createTextNode(text.slice(cursor)));
 root.replaceChildren(fragment);
}
function selectionInside(root:HTMLElement):Selection|null {
 const selection=root.ownerDocument.getSelection();return selection?.rangeCount&&selection.anchorNode&&root.contains(selection.anchorNode)?selection:null;
}
export function plainCaret(root:HTMLElement):number {
 const selection=selectionInside(root);if(!selection)return readInlineDraft(root).text.length;
 const range=root.ownerDocument.createRange();range.selectNodeContents(root);range.setEnd(selection!.anchorNode!,selection!.anchorOffset);
 return readInlineDraft(range.cloneContents()).text.length;
}
function pointAt(root:HTMLElement,position:number):{node:Node;offset:number} {
 let walked=0,last:Text|null=null;const walker=root.ownerDocument.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode(node){return (node.parentElement?.closest('[data-mention-id]')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT);}});
 while(walker.nextNode()){const node=walker.currentNode as Text;last=node;if(walked+node.length>=position)return {node,offset:Math.max(0,position-walked)};walked+=node.length;}
 return last?{node:last,offset:last.length}:{node:root,offset:root.childNodes.length};
}
export function placePlainCaret(root:HTMLElement,position:number){
 const point=pointAt(root,position),range=root.ownerDocument.createRange();range.setStart(point.node,point.offset);range.collapse(true);const selection=root.ownerDocument.getSelection();selection?.removeAllRanges();selection?.addRange(range);
}
export function placeAfterMention(root:HTMLElement,id:string){
 const mention=[...root.querySelectorAll<HTMLElement>('[data-mention-id]')].find(el=>el.dataset.mentionId===id);if(!mention)return;
 const range=root.ownerDocument.createRange();range.setStartAfter(mention);range.collapse(true);const selection=root.ownerDocument.getSelection();selection?.removeAllRanges();selection?.addRange(range);
}
export function insertPlainText(root:HTMLElement,value:string){
 const selection=selectionInside(root);if(!selection){root.focus();placePlainCaret(root,readInlineDraft(root).text.length);}
 const range=root.ownerDocument.getSelection()?.getRangeAt(0);if(!range)return;
 range.deleteContents();const text=root.ownerDocument.createTextNode(value);range.insertNode(text);range.setStart(text,value.length);range.collapse(true);const current=root.ownerDocument.getSelection();current?.removeAllRanges();current?.addRange(range);
}
export function replacePlainRangeWithMention(root:HTMLElement,start:number,end:number,mention:DraftMention,label:string){
 const from=pointAt(root,start),to=pointAt(root,end),range=root.ownerDocument.createRange();range.setStart(from.node,from.offset);range.setEnd(to.node,to.offset);
 const span=root.ownerDocument.createElement('span');span.className='gr-mention-inline';span.contentEditable='false';span.dataset.mentionId=mention.id;span.dataset.mentionOrigin=mention.origin;span.title='按退格可整段删除';span.textContent=`@${label}`;
 root.focus();const selection=root.ownerDocument.getSelection();selection?.removeAllRanges();selection?.addRange(range);
 // A native editing transaction lets Ctrl+Z restore the typed @query. Never
 // pass user HTML: serialize only the DOM node built from textContent above.
 if(!root.ownerDocument.execCommand('insertHTML',false,span.outerHTML)){range.deleteContents();range.insertNode(span);}
 placeAfterMention(root,mention.id);
}
export function deleteAdjacentMention(root:HTMLElement,direction:'backward'|'forward'):boolean {
 const selection=selectionInside(root);if(!selection?.isCollapsed)return false;
 const range=root.ownerDocument.createRange();range.selectNodeContents(root);range.setEnd(selection.anchorNode!,selection.anchorOffset);
 const index=readInlineDraft(range.cloneContents()).units.length,units=readInlineDraft(root).units;
 const target=units[direction==='backward'?index-1:index];if(!(target instanceof HTMLElement)||!target.hasAttribute('data-mention-id'))return false;
 const selected=root.ownerDocument.createRange();selected.selectNode(target);selection.removeAllRanges();selection.addRange(selected);
 if(!root.ownerDocument.execCommand('delete')){const cursor=root.ownerDocument.createRange();cursor.setStartBefore(target);cursor.collapse(true);target.remove();selection.removeAllRanges();selection.addRange(cursor);}
 return true;
}
