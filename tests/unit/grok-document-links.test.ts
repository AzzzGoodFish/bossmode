import {expect,it} from 'vitest';
import {resolveFileLink} from '../../web/src/grok/file-links';
import {markMentions} from '../../web/src/grok/mention-markup';
it('resolves reader sibling files and anchors, rejecting escapes, external URLs and ambiguous names',()=>{
 const files=[{name:'readme.md',path:'docs/readme.md'},{name:'preview.html',path:'docs/preview.html'},{name:'code.ts',path:'src/code.ts'}];
 expect(resolveFileLink(files,0,'./preview.html#介绍')).toEqual({index:1,hash:'介绍'});expect(resolveFileLink(files,0,'../src/code.ts')).toEqual({index:2,hash:''});expect(resolveFileLink(files,0,'#阅读约定')).toEqual({index:0,hash:'阅读约定'});
 for(const href of ['../../etc/passwd','https://example.com','//example.com','/%2e%2e/secret','%bad'])expect(resolveFileLink(files,0,href)).toBeNull();expect(resolveFileLink([{name:'same.md'},{name:'same.md'}],0,'same.md')).toBeNull();
});
it('highlights exact mention names without turning code or links into mentions',()=>{
 const tree={type:'root',children:[{type:'element',tagName:'p',children:[{type:'text',value:'@Ann @Anna @Annette'}]},{type:'element',tagName:'code',children:[{type:'text',value:'@Ann'}]}]};markMentions({names:['Ann','Anna']})(tree);expect(JSON.stringify(tree)).toContain('gc-mention');expect(tree.children[0].children.filter(n=>n.type==='element')).toHaveLength(2);expect(tree.children[1].children).toEqual([{type:'text',value:'@Ann'}]);
});
