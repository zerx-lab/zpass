# 备用方案：nu 原生 http 失败时，走 curl
# 先把 payload 写成临时 json 文件（用 to json 可正确转义 HTML 内的引号 / 换行），
# 然后 curl --data-binary @file 提交，避免命令行长度限制与转义地狱。

def push [name: string, subject: string, file: string, tmp: string] {
  let body = (open --raw $file)
  let payload = { name: $name, type: "tx", subject: $subject, body: $body }
  $payload | to json | save --force $tmp
  let out = (
    ^curl -sS
      -u "zpass_website:LwtNpxGclhjPkTI1qmgF0tDOIcKEmZMC"
      -H "Content-Type: application/json"
      -X POST
      --data-binary $"@($tmp)"
      https://subscription.zerx.dev/api/templates
  )
  let r = ($out | from json)
  if ($r | get -i data | is-empty) {
    print $"[FAIL] ($name): ($out)"
  } else {
    print $"[OK]   id=($r.data.id)  ($r.data.name)"
  }
  rm --force $tmp
}

push "ZPass – Confirm subscription" "Confirm your ZPass subscription" confirm-subscription.html _p1.json
push "ZPass – Welcome aboard"       "You're on the ZPass list"        welcome.html              _p2.json
