import {describe,expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Markdown} from './ui.js';
const render=(text:string)=>renderToStaticMarkup(createElement(Markdown,{text}));
describe('chat Markdown URL boundaries',()=>{
 it('keeps the screenshot URL clickable without swallowing Chinese prose or adjacent bold markers',()=>{
  const html=render('仍是 http://192.0.2.1:42872/**，刷新可看；附明/暗两张截图。**');
  expect(html).toContain('href="http://192.0.2.1:42872/"');
  expect(html).toContain('>http://192.0.2.1:42872/</a><strong>，刷新可看；附明/暗两张截图。</strong>');
  expect(html).not.toContain('href="http://192.0.2.1:42872/**');
  expect(html).not.toContain('</a>**');
  expect(html).toContain('target="_blank" rel="noopener noreferrer"');
  expect(html).not.toContain('node="[object Object]"');
 });
 it('does not trim a literal wildcard path when no matching Markdown marker exists',()=>{
  const html=render('样例 https://example.org/**，继续');
  expect(html).toContain('href="https://example.org/**"');
  expect(html).toContain('</a>，继续');
 });
 it('retains valid Unicode path/query characters before sentence punctuation',()=>{
  const html=render('查阅 https://example.com/中文路径?章节=一，继续阅读。');
  expect(html).toContain('>https://example.com/中文路径?章节=一</a>，继续阅读。');
  expect(html).not.toContain('%EF%BC%8C');
 });
 it('handles multiple URLs including www, but leaves explicitly authored Markdown destinations alone',()=>{
  const html=render('访问 www.example.org/a，或 https://example.com/b。 [作者指定](https://example.com/a，b)');
  expect(html).toContain('href="http://www.example.org/a"');
  expect(html).toContain('href="https://example.com/b"');
  expect(html).toContain('href="https://example.com/a%EF%BC%8Cb"');
  expect(html).toContain('>作者指定</a>');
 });
 it('never linkifies fenced or inline code; preserves Mermaid source before drawing',()=>{
  const html=render('# 1. 对象关系与消息流\n\n`https://example.org/`\n\n```mermaid\nclassDiagram\n  Member <|-- User\n```\n\n![结构图](https://example.org/diagram.png)');
  expect(html).toContain('<h1>1. 对象关系与消息流</h1>');
  expect(html).toContain('aria-label="mermaid 代码"');
  expect(html).toContain('aria-label="复制代码"');
  expect(html).toContain('[图片：结构图]');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('<a');
 });
 it('does not make unsafe destinations into links',()=>{
  const html=render('[危险](javascript:alert(1)) [安全](https://example.org/)');
  expect(html).toContain('<span>危险</span>');
  expect(html).toContain('href="https://example.org/"');
  expect(html).not.toContain('javascript:');
 });
});
