export function resolveFileLink(files:Array<{name:string;path?:string}>,current:number,href:string):{index:number;hash:string}|null {
 if(/^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i.test(href))return null;
 let path:string,hash:string;try{const at=href.indexOf('#');path=decodeURIComponent(at<0?href:href.slice(0,at));hash=at<0?'':decodeURIComponent(href.slice(at+1));}catch{return null;}
 if(!path)return {index:current,hash};
 const parts=(files[current].path??files[current].name).split('/').slice(0,-1).concat(path.split('/')),clean:string[]=[];
 for(const part of parts){if(!part||part==='.')continue;if(part==='..'){if(!clean.length)return null;clean.pop();}else clean.push(part);}
 const matches=files.flatMap((file,index)=>(file.path??file.name)===clean.join('/')?[index]:[]);return matches.length===1?{index:matches[0],hash}:null;
}
