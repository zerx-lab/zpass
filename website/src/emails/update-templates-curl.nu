# 将已上传的两个模板更新为最新文件内容
# 用法: nu --no-config-file update-templates-curl.nu

def update [id: int, name: string, subject: string, file: string, tmp: string] {
  let body = (open --raw $file)
  let payload = { name: $name, type: "tx", subject: $subject, body: $body }
  $payload | to json | save --force $tmp
  let out = (
    ^curl -sS
      -u "zpass_website:LwtNpxGclhjPkTI1qmgF0tDOIcKEmZMC"
      -H "Content-Type: application/json"
      -X PUT
      --data-binary $"@($tmp)"
      $"https://subscription.zerx.dev/api/templates/($id)"
  )
  let r = ($out | from json)
  if ($r | get --optional data | is-empty) {
    print $"[FAIL] id=($id) ($name): ($out)"
  } else {
    print $"[OK]   id=($r.data.id)  ($r.data.name)"
  }
  rm --force $tmp
}

update 5 "ZPass – Confirm subscription" "Confirm your ZPass subscription" confirm-subscription.html _u1.json
update 6 "ZPass – Welcome aboard"       "You're on the ZPass list"        welcome.html              _u2.json
