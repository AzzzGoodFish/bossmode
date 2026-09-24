import {describe,it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Markdown} from './ui';
import {diagramLabel,MAX_DIAGRAM_SOURCE} from './mermaid-safe';

describe('chat Mermaid source boundary',()=>{
 it('recognizes the two diagram families in the supplied content',()=>{
  expect(diagramLabel('classDiagram\n  Member <|-- User')).toBe('类图');
  expect(diagramLabel('flowchart LR\n  U[用户] --> C[聊天]')).toBe('流程图');
 });
 it('leaves directives, links, CSS, unknown types and oversized sources as readable code',()=>{
  for(const source of ['%%{init: {securityLevel: "loose"}}%%\nflowchart LR\nA-->B','flowchart LR\nclick A "https://elsewhere.example"','classDiagram\nclassDef custom fill:red','sequenceDiagram\nAlice->>Bob: hi','flowchart LR\n'+'A'.repeat(MAX_DIAGRAM_SOURCE)])expect(diagramLabel(source)).toBeNull();
 });
 it('keeps source available in server rendering, without a remote image or SVG injection',()=>{
  const html=renderToStaticMarkup(createElement(Markdown,{text:'```mermaid\nclassDiagram\n  Member <|-- User\n```'}));
  expect(html).toContain('Mermaid 类图');
  expect(html).toContain('mermaid 代码');
  expect(html).not.toContain('gc-mermaid-canvas');
  expect(html).not.toContain('<img');
 });
});
