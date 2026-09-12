import { Graphviz } from '@hpcc-js/wasm-graphviz';
const gv = await Graphviz.load();

// Test 1: does \\n in label string render as literal \n or as newline?
const d1 = `digraph{
  "n1" [label="line1\\nline2\\nline3", shape=box];
}`;
const s1 = gv.dot(d1,'svg');
const m1 = s1.match(/<text[^>]*>([^<]+)<\/text>/g);
console.log('Issue #1 — label text elements with \\n (escaped):');
m1?.slice(0,3).forEach(t=>console.log(' ',t));

// Test 2: real \n in label via actual newline escape in template
const d2 = `digraph{
  "n1" [label="line1\nline2\nline3", shape=box];
}`;
const s2 = gv.dot(d2,'svg');
const m2 = s2.match(/<text[^>]*>([^<]+)<\/text>/g);
console.log('\nIssue #1 — label text elements with \\n (real newline):');
m2?.slice(0,3).forEach(t=>console.log(' ',t));

// Test 3: edge title format with port specs
const d3 = `digraph{
  rankdir=TB; splines=ortho;
  "n1":s -> "n2":n [color="#28a745",label="Y"];
  "n1":e -> "n3":n [color="#dc3545",label="N"];
}`;
const s3 = gv.dot(d3,'svg');
const titles = s3.match(/<title>[^<]+<\/title>/g);
console.log('\nIssue #6 — edge titles with port specs:');
titles?.forEach(t=>console.log(' ',t));

// Test 4: taillabel for Y/N with fontcolor
const d4 = `digraph{
  rankdir=TB; splines=ortho;
  "n1" [label="x < 5", shape=diamond, fillcolor="#fff3cd", style=filled];
  "n2" [label="process", shape=box];
  "n3" [label="exit", shape=oval];
  "n1" -> "n2" [color="#28a745", fontcolor="#28a745", taillabel="Yes", labeldistance=1.5];
  "n1" -> "n3" [color="#dc3545", fontcolor="#dc3545", taillabel="No",  labeldistance=1.5];
}`;
const s4 = gv.dot(d4,'svg');
console.log('\nIssue #2/#3 — taillabel renders ok:', s4.includes('<svg'));
const lblTexts = s4.match(/<text[^>]*fill="[^"]+"[^>]*>[^<]+<\/text>/g);
console.log('Label text elements:', lblTexts?.slice(0,4));
