interface Node {type:string;tagName?:string;value?:string;properties?:Record<string,unknown>;children?:Node[]}
export function markMentions(options:{names:string[]}) {
 const names=[...new Set(options.names)].filter(Boolean).sort((a,b)=>b.length-a.length);
 return (tree:Node)=>{const walk=(node:Node)=>{if(['code','pre','a'].includes(node.tagName??'')||!node.children)return;const children:Node[]=[];
  for(const child of node.children){if(child.type!=='text'||!child.value){walk(child);children.push(child);continue;}const value=child.value;let pos=0;while(pos<value.length){const at=value.indexOf('@',pos);if(at<0){children.push({type:'text',value:value.slice(pos)});break;}if(at>pos)children.push({type:'text',value:value.slice(pos,at)});const name=names.find(n=>value.startsWith(n,at+1)&&(!value[at+1+n.length]||!/[\p{L}\p{N}_]/u.test(value[at+1+n.length])));if(name){children.push({type:'element',tagName:'span',properties:{className:['gc-mention']},children:[{type:'text',value:'@'+name}]});pos=at+name.length+1;}else{children.push({type:'text',value:'@'});pos=at+1;}}}
  node.children=children;};walk(tree);};
}
