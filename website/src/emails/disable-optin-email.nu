# 关掉 listmonk 默认 optin 邮件：
# 读取完整 settings → 把 app.send_optin_confirmation 改为 false → PUT 回去

let full = (^curl -sS -u "zpass_website:LwtNpxGclhjPkTI1qmgF0tDOIcKEmZMC" https://subscription.zerx.dev/api/settings | from json | get data)

# 修改目标字段
let patched = ($full | update "app.send_optin_confirmation" false)

# 存成临时文件
$patched | to json | save --force _settings_patch.json

# PUT 回去
let resp = (^curl -sS -u "zpass_website:LwtNpxGclhjPkTI1qmgF0tDOIcKEmZMC"
  -H "Content-Type: application/json"
  -X PUT
  --data-binary "@_settings_patch.json"
  https://subscription.zerx.dev/api/settings)

print $resp

rm --force _settings_patch.json

# 验证
let check = (^curl -sS -u "zpass_website:LwtNpxGclhjPkTI1qmgF0tDOIcKEmZMC" https://subscription.zerx.dev/api/settings | from json | get data | get "app.send_optin_confirmation")
print $"app.send_optin_confirmation = ($check)"
