/* Composer mentions are prefix chips in the draft, not editable fragments of
 * a textarea. Preserve the author ID until send; never guess a historical
 * author's identity from a reused display name. */
export interface DraftMention {id:string;label:string;origin:'quote'|'manual'}
export interface MentionPerson {id:string;name:string}
export interface QuoteAuthor {sender:string;senderMemberId?:string}

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
  const unavailable:string[]=[],labels:string[]=[];
  for(const mention of mentions){
    const label=mention.id==='user'?(room&&(username==='all'||members.some(member=>member.name===username))?undefined:username)
      :mention.id==='all'?(room?'all':undefined)
      :members.find(member=>member.id===mention.id)?.name;
    if(room&&mention.id!=='all'&&label==='all'){unavailable.push(mention.label);continue;}
    if(!label){unavailable.push(mention.label);continue;}
    labels.push(`@${label}`);
  }
  return {content:[labels.join(' '),text].filter(Boolean).join(' '),unavailable};
}
