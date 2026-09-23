export function searchExcerpt(value:string,query:string):{before:string;match:string;after:string} {
  const text=value.replace(/\s+/g,' ').trim(),term=query.trim(),at=term?text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase()):-1,start=Math.max(0,at-28),end=Math.min(text.length,start+140),part=text.slice(start,end),lead=start?'…':'',tail=end<text.length?'…':'';
  if(at<0)return {before:lead+part+tail,match:'',after:''};
  const hit=at-start;return {before:lead+part.slice(0,hit),match:part.slice(hit,hit+term.length),after:part.slice(hit+term.length)+tail};
}
