import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/subtitles.ts',import.meta.url),'utf8');
const compiled = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {parseSubtitles,serializeSubtitles} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const asTitles = (cues) => cues.map((cue,index)=>({...cue,id:String(index),kind:'caption'}));

test('SRT imports BOM, CRLF, multiline Unicode, overlap and signed offsets', () => {
  const result=parseSubtitles('\uFEFF1\r\n00:00:01,125 --> 00:00:03,200\r\nCafé &amp; tea\r\n你好 👋\r\n\r\n2\r\n00:00:02,000 --> 00:00:04,000\r\nSecond\r\n','srt',-125000);
  assert.deepEqual(result.cues,[{text:'Café & tea\n你好 👋',startUs:1000000,durationUs:2075000},{text:'Second',startUs:1875000,durationUs:2000000}]);
  assert.deepEqual(result.warnings,[]);
});
test('WebVTT preserves cue text while reporting styles it cannot preserve', () => {
  const result=parseSubtitles('WEBVTT\n\nNOTE example\ncomment\n\nSTYLE\n::cue { color: red }\n\nopening\n00:01.000 --> 00:02.500 align:start\n<v Alice><b>Hello</b> &lt;world&gt; &#x1F44B;\n\n00:03.000 --> 00:04.000\nBye','vtt');
  assert.deepEqual(result.cues[0],{text:'Hello <world> 👋',startUs:1000000,durationUs:1500000});
  assert.equal(result.cues.length,2);
  assert.equal(result.warnings.length,3);
});
test('subtitle serialization excludes titles and round-trips literal markup and Unicode', () => {
  const cues=[{text:'<b>Literal</b> & multilingual café\nمرحبا 你好 👋',startUs:3600000123000,durationUs:1500000},{text:'Overlap',startUs:3600000500000,durationUs:900000}];
  for(const format of ['srt','vtt']) {
    const output=serializeSubtitles([...asTitles(cues),{kind:'title',text:'Ordinary title',startUs:0,durationUs:1000000}],format);
    assert.equal(output.count,2);
    assert.deepEqual(parseSubtitles(output.content,format).cues,cues);
    assert.ok(!output.content.includes('Ordinary title'));
  }
});
test('malformed cues, unsafe times, empty input and excessive text are rejected without partial results', () => {
  for(const content of ['', '1\n00:00:02,000 --> 00:00:01,000\nBackwards','1\n00:99:00,000 --> 01:00:00,000\nBad minutes','1\n00:00:00,000 --> 00:00:01,000\nFine\n\n2\ninvalid\nBad','1\n00:00:00,000 --> 00:00:01,000\n'+'你'.repeat(1400)]) assert.throws(()=>parseSubtitles(content,'srt'));
  assert.throws(()=>parseSubtitles('WEBVTT\n00:00.000 --> 00:01.000\nMissing blank','vtt'));
  assert.throws(()=>parseSubtitles('1\n00:00:00,000 --> 00:00:01,000\nText','srt',-1));
  assert.throws(()=>parseSubtitles('1\n99999999999:00:00,000 --> 99999999999:00:01,000\nText','srt'));
});
test('sub-millisecond caption exports keep a positive duration', () => {
  const output=serializeSubtitles(asTitles([{text:'One frame',startUs:999,durationUs:1}]),'vtt');
  assert.equal(parseSubtitles(output.content,'vtt').cues[0].durationUs,1000);
});
