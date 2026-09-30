const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const appSource = fs.readFileSync('assets/js/app.js', 'utf8');

test('SFTP 删除请求通过查询参数发送 token', () => {
  assert.match(
    appSource,
    /ftpApi\('POST', '\/api\/sftp\/delete\?token=' \+ encodeURIComponent\(state\.ftp\.token\), \{ path: path \}\)/
  );
});

test('SFTP 重命名请求通过查询参数发送 token', () => {
  assert.match(
    appSource,
    /ftpApi\('POST', '\/api\/sftp\/rename\?token=' \+ encodeURIComponent\(state\.ftp\.token\), \{ old: path, new: dir \+ newName \}\)/
  );
});

test('连接接口通过统一解析器处理非 JSON 响应', () => {
  assert.match(appSource, /function parseApiResponse\(res\)/);
  assert.match(appSource, /fetch\('\/api\/session',[\s\S]*?\.then\(parseApiResponse\)/);
  assert.match(appSource, /fetch\('\/api\/sftp\/connect',[\s\S]*?\.then\(parseApiResponse\)/);
});
