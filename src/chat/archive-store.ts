// Archive facts and summaries are SQL authority. This module performs no file IO.
import {getDatabase} from "../data/database.js";
import {MessageArchivesRepository} from "../data/repositories/message-archives.js";
import {readArchivedMessages} from "../data/repositories/message-repository.js";
import {executionScopeId} from "../data/repositories/execution-identity.js";
import type {RoomMessage} from "../kernel/types.js";
export function archiveMessages(scopeId:string,keepCount=50){return new MessageArchivesRepository(getDatabase()).archive(scopeId,keepCount);}
export function saveArchiveSummary(scopeId:string,summary:string,messages:RoomMessage[],timestamp:number):void{
 new MessageArchivesRepository(getDatabase()).saveSummary(scopeId,timestamp,{summary,archivedCount:messages.length,range:[messages[0]?.id??"",messages.at(-1)?.id??""],ts:timestamp});
}
export function listArchives(scopeId:string){return new MessageArchivesRepository(getDatabase()).list(scopeId);}
export function readArchiveMessages(scopeId:string,timestamp:number):RoomMessage[]{return readArchivedMessages(executionScopeId(scopeId),timestamp);}
export function readArchiveSummary(scopeId:string,timestamp:number){return new MessageArchivesRepository(getDatabase()).summary(scopeId,timestamp);}
