/* GFM treats a bare URL followed immediately by CJK prose as one long link.
 * Trim only literal autolinks; explicit Markdown destinations are authored URLs
 * and must not be rewritten. Code and fenced diagrams have no link AST nodes. */
interface Point {offset?:number}
interface Node {
  type:string;
  url?:string;
  value?:string;
  children?:Node[];
  position?:{start:Point;end:Point};
}
const proseBoundary=/[，。；：！？、（【《「『]/u;

export function remarkBoundedUrls() {
  return (tree:Node,file:{value:unknown})=>{
    const source=String(file.value??'');
    function visit(parent:Node):void {
      if(!parent.children)return;
      for(let i=0;i<parent.children.length;i++){
        const node=parent.children[i],start=node.position?.start.offset,end=node.position?.end.offset;
        if(node.type==='link'&&typeof node.url==='string'&&typeof start==='number'&&typeof end==='number'){
          const raw=source.slice(start,end),text=node.children?.length===1?node.children[0]:null;
          // Source offsets distinguish GFM literals from [labels](destinations),
          // including explicit links whose visible label happens to be a URL.
          if(/^(?:https?:\/\/|www\.)/i.test(raw)&&text?.type==='text'&&text.value===raw){
            const boundary=raw.search(proseBoundary);
            if(boundary>0){
              let address=raw.slice(0,boundary);
              const tail=raw.slice(boundary),following=parent.children[i+1];
              // GFM may consume an opening ** after the URL, leaving its
              // matching closing ** as a text sibling after the prose.
              const boldTail=address.endsWith('**')&&following?.type==='text'&&following.value?.startsWith('**');
              if(boldTail)address=address.slice(0,-2);
              const href=raw.toLowerCase().startsWith('www.')?'http://'+address:address;
              try{
                const parsed=new URL(href);
                if(['http:','https:'].includes(parsed.protocol)&&parsed.hostname){
                  const prose:Node=boldTail?{type:'strong',children:[{type:'text',value:tail}]}:{type:'text',value:tail};
                  parent.children.splice(i,1,{type:'link',url:href,children:[{type:'text',value:address}]},prose);
                  if(boldTail&&following){following.value=following.value!.slice(2);if(!following.value)parent.children.splice(i+2,1);}
                  i++;
                  continue;
                }
              }catch{/* Keep the original visible text for malformed addresses. */}
            }
          }
        }
        visit(node);
      }
    }
    visit(tree);
  };
}
