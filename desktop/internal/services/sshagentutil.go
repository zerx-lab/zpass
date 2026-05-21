// SSH agent 服务 —— 包级共享辅助
// ---------------------------------------------------------------------------
// 把 sshagent* 文件之间共享的小工具集中在此，避免散落各处导致重复
// 定义。当前主要内容：base64 编码器变量。

package services

import (
	b64 "encoding/base64"
)

// b64StdEncodingForGUI 是 main 包内 sshagent* 文件共用的 base64 编解码器
//
// 命名带「ForGUI」是为了与 cmd/zpass-agent 子包的同名变量明确区分 ——
// 两个 binary 各自一份，互不引用。
//
// 选用 StdEncoding 而非 URLEncoding：与 cmd/zpass-agent/agent.go 的
// b64StdEncoding 行为一致，让协议两端 encode/decode 的字符集完全一致。
//
// 也可以直接到处写 base64.StdEncoding，但抽出变量让导入更整洁，且未来
// 若改算法（极不可能）只需改一处。
var b64StdEncodingForGUI = b64.StdEncoding
