import {lstatSync,rmSync} from 'node:fs';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
export function statIfPresent(path:string){try{return lstatSync(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
/** Never follow an owned-root symlink into another member or an external workspace. */
export function checkedAssetPath(root:string,relativePath:string):string {
 const base=resolve(root),full=resolve(base,relativePath),rel=relative(base,full);
 if(isAbsolute(relativePath)||relativePath.includes('\\')||relativePath.includes('\0')||rel==='..'||rel.startsWith(`..${sep}`)||relativePath.split('/').includes('..'))throw Error('invalid_asset_path');
 let current=base;for(const segment of ['',...rel.split(sep)]){if(segment)current=join(current,segment);if(statIfPresent(current)?.isSymbolicLink())throw Error('archive_symlink_conflict');}return full;
}
export function removeOwnedDirectory(root:string,path:string,device:string|null,inode:string|null):void {
 const full=checkedAssetPath(root,path),info=statIfPresent(full);if(!info)return;
 if(!info.isDirectory()||device!==null&&(String(info.dev)!==device||String(info.ino)!==inode))throw Error('deletion_asset_identity_conflict');
 rmSync(full,{recursive:true,force:true});
}
