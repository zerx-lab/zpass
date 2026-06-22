// Chrome Web Store 发布凭证:换取 refresh_token 的一次性脚本。
// -----------------------------------------------------------------------------
// CI 自动发布扩展(见 .github/workflows/desktop-build.yml 的 build-extension job)
// 需要 4 个 Secret:CWS_EXTENSION_ID / CWS_CLIENT_ID / CWS_CLIENT_SECRET /
// CWS_REFRESH_TOKEN。前三个在 Google Cloud Console 建「桌面应用」OAuth 客户端时
// 拿到,refresh_token 用本脚本换。
//
// 用法(在 extension/ 目录):
//   设好环境变量后运行——
//     CWS_CLIENT_ID=xxx CWS_CLIENT_SECRET=yyy node scripts/cws-get-refresh-token.mjs
//   或 PowerShell:
//     $env:CWS_CLIENT_ID="xxx"; $env:CWS_CLIENT_SECRET="yyy"; node scripts/cws-get-refresh-token.mjs
//
// 国内直连 Google 会超时,需走代理。脚本默认读 HTTPS_PROXY 并要求 Node 开启
// 环境代理(NODE_USE_ENV_PROXY=1)。Clash 默认端口示例:
//     $env:NODE_USE_ENV_PROXY="1"; $env:HTTPS_PROXY="http://127.0.0.1:7897"
//
// 流程:脚本起本地 :8080 服务 → 打印授权链接 → 浏览器用「扩展发布者账号」授权
//   → Google 回调到 localhost → 自动用 code 换 refresh_token 并打印。
//
// 前置要求:
//   1. OAuth 客户端类型必须是「桌面应用(Desktop app)」,且重定向含
//      http://localhost(桌面应用默认允许任意端口的 localhost)。
//   2. OAuth 同意屏幕(Auth Platform)建议「发布到生产」,否则 refresh_token
//      约 7 天过期(测试状态);测试状态下还须把发布者邮箱加为测试用户。
//   3. 已在 Google Cloud 启用 Chrome Web Store API。
//
// 拿到 refresh_token 后:填进 GitHub 仓库 Settings → Secrets and variables →
// Actions → CWS_REFRESH_TOKEN。
// -----------------------------------------------------------------------------
import http from 'node:http';

const CLIENT_ID = process.env.CWS_CLIENT_ID;
const CLIENT_SECRET = process.env.CWS_CLIENT_SECRET;
const PORT = Number(process.env.CWS_OAUTH_PORT || 8080);
const REDIRECT = `http://localhost:${PORT}`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('缺少环境变量:CWS_CLIENT_ID 和/或 CWS_CLIENT_SECRET。');
  console.error('示例(PowerShell):');
  console.error('  $env:CWS_CLIENT_ID="xxx.apps.googleusercontent.com"');
  console.error('  $env:CWS_CLIENT_SECRET="GOCSPX-xxxx"');
  console.error('  $env:NODE_USE_ENV_PROXY="1"; $env:HTTPS_PROXY="http://127.0.0.1:7897"');
  console.error('  node scripts/cws-get-refresh-token.mjs');
  process.exit(1);
}

if (process.env.HTTPS_PROXY && process.env.NODE_USE_ENV_PROXY !== '1') {
  console.warn('[warn] 检测到 HTTPS_PROXY 但未设 NODE_USE_ENV_PROXY=1,Node fetch 不会走代理,连 Google 可能超时。');
}

const authUrl = 'https://accounts.google.com/o/oauth2/auth?' + new URLSearchParams({
  response_type: 'code',
  scope: 'https://www.googleapis.com/auth/chromewebstore',
  access_type: 'offline',
  prompt: 'consent',
  redirect_uri: REDIRECT,
  client_id: CLIENT_ID,
}).toString();

console.log('\n==== 第一步:浏览器打开下面链接,用「扩展发布者账号」授权 ====\n');
console.log(authUrl);
console.log('\n(若提示 "Google 未验证此应用" -> 高级 -> 继续前往 -> 允许)');
console.log(`\n==== 正在 ${REDIRECT} 等待回调... (5 分钟超时) ====\n`);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  const code = u.searchParams.get('code');
  const err = u.searchParams.get('error');
  if (err) {
    res.end('Error: ' + err);
    console.error('授权失败:', err);
    server.close();
    process.exit(1);
    return;
  }
  if (!code) { res.end('waiting...'); return; }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<h2>授权成功,可关闭此页,回终端查看 refresh_token</h2>');
  console.log('拿到 code,正在换 token...\n');

  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT,
      }),
    });
    const j = await r.json();
    if (j.refresh_token) {
      console.log('==== 成功 ====');
      console.log('refresh_token 有效期(秒):', j.refresh_token_expires_in ?? '(生产状态:长期有效)');
      console.log('\n>>>> CWS_REFRESH_TOKEN =\n' + j.refresh_token + '\n');
      console.log('把它填进 GitHub 仓库 Settings → Secrets → CWS_REFRESH_TOKEN。');
    } else {
      console.log('!! 未拿到 refresh_token,响应如下:');
      console.log(JSON.stringify(j, null, 2));
      process.exitCode = 1;
    }
  } catch (e) {
    console.error('换 token 失败(多半是没走代理导致连 Google 超时):', e?.cause?.code || e?.message || e);
    process.exitCode = 1;
  }
  server.close();
  process.exit(process.exitCode || 0);
});

server.listen(PORT);
setTimeout(() => { console.log('超时未授权,退出。'); process.exit(1); }, 300000);
