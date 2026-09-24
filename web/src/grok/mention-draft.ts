/* An inline mention is a non-editable text run at a plain-text offset.
 * Keep its stable ID until send; never guess a historical author's identity
 * from a reused display name. Missing at means the legacy prefix position. */
export interface DraftMention {id:string;label:string;origin:'quote'|'manual';at?:number}
export interface MentionPerson {id:string;name:string}
export interface QuoteAuthor {sender:string;senderMemberId?:string}
export function mentionQueryAtCaret(text:string,cursor:number,names:readonly string[]):{start:number;end:number;query:string}|null {
 const before=text.slice(0,cursor),match=before.match(/(?:^|[\s(])@([^\n@]*)$/);
 if(!match||/^\s/u.test(match[1]))return null;
 const query=match[1].toLocaleLowerCase();
 if(/\s/u.test(query)&&!names.some(name=>name.toLocaleLowerCase().startsWith(query)))return null;
 if(/[，。；：！？、,.!?;:]/u.test(query)&&!names.some(name=>name.toLocaleLowerCase().includes(query)))return null;
 return {start:before.length-match[1].length-1,end:cursor,query:match[1]};
}

export function quoteMention(author:QuoteAuthor,username:string,members:readonly MentionPerson[],room:boolean):DraftMention|undefined {
  if(!room)return undefined;
  if(author.sender==='user'){
    if(!username.trim()||room&&(username==='all'||members.some(member=>member.name===username)))return undefined;
    return {id:'user',label:username,origin:'quote'};
  }
  if(!author.senderMemberId)return undefined;
  const member=members.find(person=>person.id===author.senderMemberId);
  return member&&member.name!=='all'?{id:member.id,label:member.name,origin:'quote'}:undefined;
}
export function withQuoteMention(mentions:readonly DraftMention[],next?:DraftMention):DraftMention[] {
  const manual=mentions.filter(mention=>mention.origin!=='quote');
  return next&&!manual.some(mention=>mention.id===next.id)?[next,...manual]:manual.slice();
}
export function withManualMention(mentions:readonly DraftMention[],next:DraftMention):DraftMention[] {
  const existing=mentions.find(mention=>mention.id===next.id);
  return existing?mentions.map(mention=>mention.id===next.id?{...next,origin:'manual'}:mention):[...mentions,{...next,origin:'manual'}];
}
export function mentionContent(text:string,mentions:readonly DraftMention[],username:string,members:readonly MentionPerson[],room:boolean):{content:string;unavailable:string[]} {
  const unavailable:string[]=[],placed:{at:number;label:string;index:number}[]=[];
  for(const [index,mention] of mentions.entries()){
    const label=mention.id==='user'?(room&&(username==='all'||members.some(member=>member.name===username))?undefined:username)
      :mention.id==='all'?(room?'all':undefined)
      :members.find(member=>member.id===mention.id)?.name;
    if(room&&mention.id!=='all'&&label==='all'){unavailable.push(mention.label);continue;}
    if(!label){unavailable.push(mention.label);continue;}
    placed.push({at:Math.max(0,Math.min(text.length,mention.at??0)),label:`@${label}`,index});
  }
  placed.sort((a,b)=>a.at-b.at||a.index-b.index);
  let content='',cursor=0;
  for(const [index,tag] of placed.entries()){
    const at=Math.max(cursor,tag.at);
    content+=text.slice(cursor,at)+tag.label;
    const next=placed[index+1],following=text.slice(at);
    if(next?.at===at||following&&!/^[\s，。；：！？、,.!?;:）)\]}]/u.test(following))content+=' ';
    cursor=at;
  }
  content+=text.slice(cursor);
  return {content,unavailable};
}
