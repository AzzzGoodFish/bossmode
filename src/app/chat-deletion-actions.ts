import {getDatabase} from '../data/database.js';
import {getBossmodeDir} from '../files/layout.js';
import {RoomDeletionService} from '../chat/room-deletion.js';
import {purgeConversationRows} from '../chat/deletion.js';
import {detachDocumentScope} from '../member/deletion.js';
import {cancelConversationInputs,quiesceConversation} from '../agent/controls.js';
function roomDeletions(){return new RoomDeletionService(getDatabase(),getBossmodeDir(),{
 cancelPending:cancelConversationInputs,
 purge:(scope,db)=>{detachDocumentScope(scope,db);purgeConversationRows(scope,db);},
 quiesce:quiesceConversation,
});}
export async function deleteRoomCompletely(id:string):Promise<boolean>{return roomDeletions().delete(id);}
export function recoverRoomDeletions():Promise<void>{return roomDeletions().recoverPending();}
