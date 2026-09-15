const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

function sandbox(t, content, denyRead = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbm-first-install-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const file = path.join(dir, 'state.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  let writes = 0;
  const io = {...fs,
    readFileSync(name, ...args) {
      if (name === file && (denyRead || !fs.existsSync(name))) {
        // Same error shape as the real Komari report: no error.code.
        throw new Error('GoError: lstat ' + name + (denyRead ? ': permission denied' : ': no such file or directory'));
      }
      return fs.readFileSync(name, ...args);
    },
    writeFileSync(...args) {writes++; return fs.writeFileSync(...args);},
  };
  const server = {getConfig:async()=>({}), static(){}, route(){}, cron(){}};
  const context = vm.createContext({console, __storageDir__:dir,
    __dirname:path.resolve(__dirname,'../plugin'),
    require:name=>name==='fs'?io:name==='server'?server:require(name),
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../plugin/script.js'),'utf8'), context);
  return {context, file, writes:()=>writes};
}

test('empty storage loads with Go-style missing-file errors, then persists and reloads', async t=>{
  const f=sandbox(t);
  await f.context.load();
  f.context.unload();
  assert.equal(JSON.parse(fs.readFileSync(f.file,'utf8')).schema,1);
  await f.context.load();
});

for(const content of ['{broken', 'null', '[]']) {
  test('invalid state is preserved, including unload after failed load: '+content, async t=>{
    const f=sandbox(t,content);
    await assert.rejects(f.context.load());
    f.context.unload();
    assert.equal(f.writes(),0);
    assert.equal(fs.readFileSync(f.file,'utf8'),content);
  });
}

test('permission error does not reset existing state', async t=>{
  const content='{"schema":1,"nodes":{},"daily":{"2026-09-01":{}}}';
  const f=sandbox(t,content,true);
  await assert.rejects(f.context.load(),/permission denied/);
  f.context.unload();
  assert.equal(f.writes(),0);
  assert.equal(fs.readFileSync(f.file,'utf8'),content);
});
