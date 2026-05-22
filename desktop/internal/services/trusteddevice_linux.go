//go:build linux

package services

// Linux Secret Service 实现 ——「信任设备」自动解锁能力
// ---------------------------------------------------------------------------
// 用 freedesktop Secret Service (org.freedesktop.secrets) 通过 D-Bus 把 DEK
// 交给桌面 keyring daemon (gnome-keyring / kwallet / KeePassXC secret-service
// 等) 保管。daemon 在用户登录态下解锁 collection，登出 / 锁屏后再次访问需
// 重新解锁 —— 与 Windows DPAPI 的安全模型严格对齐：
//
//   ✓ 攻击者拷走 vault.db 到另一台机器/另一个 Linux 用户 → 无法解密
//     （我们存的 blob 仅是 secret item 路径；真 DEK 在另一台机器的 daemon
//      数据库里，且即便拷走 daemon 数据也无 master password）
//   ✓ 攻击者偷走整台机器但不知 Linux 登录密码 → 无法解密
//     （keyring master password 通常与 login password 绑定 → PAM 自动解锁；
//      不知道 login 也就解不开 keyring）
//   ✓ 同 Linux 用户下其它进程读 vault.db → blob 只是路径，没有 DEK
//     （其它进程要拿 DEK 必须通过 secret-service 用我们的 attributes
//      查 —— 与「猜出 DPAPI entropy 常量」对称的攻击面）
//
//   ✗ 同 Linux 用户下能跑代码的恶意 app → 能查到 secret
//     （但若能在用户态跑代码也能直接 ptrace ZPass 进程读 s.dek 内存，
//      这一条不是本方案新引入的攻击面）
//
// ---------------------------------------------------------------------------
// 为什么走 D-Bus 而不是 cgo libsecret-1
//
//   1. 零 CGO —— Electron Forge 打包跨发行版友好，不需要在每个目标
//      系统装 libsecret-1-dev。
//   2. Secret Service 1.0 spec 是稳定接口，gnome-keyring / kwallet /
//      KeePassXC 都实现。直接调 D-Bus 反而比 libsecret 多一层 wrapper
//      更可控（例如能精确处理 Unlock prompt 路径而不是黑盒等待）。
//   3. godbus/dbus v5 是纯 Go，与 wails 项目里已经有的依赖风格一致。
//
// ---------------------------------------------------------------------------
// blob 设计
//
// vault_trusted_device.blob 存 secret item 的 ObjectPath（UTF-8 字节），
// 不存 DEK 本身。真 DEK 由 daemon 加密落盘到自家数据库。
//
//   优点：
//     - DB 文件被拷走也拿不到 DEK（daemon 数据库在另一处）
//     - Disable 时直接 Item.Delete() 清理 daemon 端记录，不留垃圾
//     - 重复 Enable 时按 attributes 搜到旧 item 先删，避免堆积
//
//   缺点：
//     - 比 DPAPI 多一次 syscall（D-Bus round-trip 通常 < 2ms）
//     - daemon 不在 / collection 被锁 → Unprotect 失败，回退主密码模式
//
// attributes 作为查询主键，必须每次 Enable 都用同一组：
//   application=zpass, purpose=trusted-device, version=v1
//
// version=v1 留给未来 schema 演进 —— 与 DPAPI entropy v1 同思路。
//
// ---------------------------------------------------------------------------
// Available 探测
//
// 仅当下面三条都满足时才返回 true：
//   1. session bus 能连（DBUS_SESSION_BUS_ADDRESS 有效 / autolaunch 成功）
//   2. org.freedesktop.secrets 已注册到 bus（daemon 在跑）
//   3. Ping(/) 不报错
//
// 任何一步失败都返回 false —— Settings 开关置灰，与 unsupported 平台体验
// 一致。Headless / SSH-without-X / 最小化 WM 用户看到的就是「此平台暂不
// 支持」而不是错误对话框。

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/godbus/dbus/v5"
)

// Secret Service spec 常量
//
// 完整 spec：https://specifications.freedesktop.org/secret-service/latest/
//
// 不导出 —— 仅本文件用。命名沿用 freedesktop 文档写法以便对照查阅。
const (
	ssBusName    = "org.freedesktop.secrets"
	ssObjectPath = dbus.ObjectPath("/org/freedesktop/secrets")

	ssIfaceService    = "org.freedesktop.Secret.Service"
	ssIfaceCollection = "org.freedesktop.Secret.Collection"
	ssIfaceItem       = "org.freedesktop.Secret.Item"
	ssIfacePrompt     = "org.freedesktop.Secret.Prompt"

	// 默认 collection alias —— gnome-keyring / kwallet 都把用户 login
	// collection 注册到这个 alias。不要硬编码 collection path（不同
	// daemon 命名不同：gnome-keyring 是 .../collection/login，kwallet
	// 是 .../collection/kdewallet）。
	ssDefaultCollection = dbus.ObjectPath("/org/freedesktop/secrets/aliases/default")

	// "plain" transport：secret value 不再加一层 D-Bus session 加密
	// （Secret Service spec 支持 DH 协商，但本机 unix socket 已隔离
	// 进程 + kernel 保证，再加一层 DH 是仪式开销 0 收益）
	ssAlgorithmPlain = "plain"

	// secret content-type —— 写「我们不解释这块字节」最显式的选择
	// （而非 "text/plain"，避免有些 daemon UI 当作字符串显示乱码）
	ssContentType = "application/octet-stream"

	// Prompt 等待上限。CreateItem / Unlock 通常立刻完成；只有当 daemon
	// 决定弹 UI 让用户输 master password 时才会真正等。5s 足够。
	ssPromptTimeout = 5 * time.Second
)

// trustedDeviceAttributes 是 secret item 的查询主键
//
// 每次 Protect / Unprotect 都用同一组 attributes 查找。**不要**修改
// 这几个键值，否则历史 item 都会成孤儿（Available 仍 true，但用户开关
// 看起来「没启用」—— 等同神秘重置）。
//
// 真要改：bump version=v2，并在 Protect 时按 v1 attributes 搜旧 item 删除。
var trustedDeviceAttributes = map[string]string{
	"application": "zpass",
	"purpose":     "trusted-device",
	"version":     "v1",
}

// secretStruct 是 Secret Service 规定的 (o, ay, ay, s) 结构
//
// 字段顺序 + 标签必须与 spec 一致 —— godbus 用反射按 tag 编解码。
type secretStruct struct {
	Session     dbus.ObjectPath
	Parameters  []byte
	Value       []byte
	ContentType string
}

// linuxSecretServiceProtector 是 TrustedDeviceProtector 的 Linux 实现
//
// 字段说明：
//   - availableOnce / available：Available() 探测结果只算一次，避免
//     Settings 页面反复读触发多次 D-Bus round-trip
//   - 不持久化 D-Bus 连接 —— godbus 的 SessionBus() 内部已经是 shared
//     conn，每次拿都是 O(1)；持久化反而要处理重连
type linuxSecretServiceProtector struct {
	availableOnce sync.Once
	available     bool
}

// init 注入 Linux 实现为进程单例
//
// 与 trusteddevice_unsupported.go / trusteddevice_windows.go 互斥
// （build tag 保证同一构建只编译一个）。
func init() {
	trustedDeviceProtector = &linuxSecretServiceProtector{}
}

// Available 探测 Secret Service 是否可用
//
// 结果会被缓存 —— 首次启动时探测一次，结果用到进程结束。daemon 中途
// 挂掉的极端情况：Protect / Unprotect 会以错误形式失败，调用方负责清行。
func (p *linuxSecretServiceProtector) Available() bool {
	p.availableOnce.Do(func() {
		p.available = probeSecretService()
	})
	return p.available
}

// Method 返回写入 vault_trusted_device.method 的标识
//
// 永远是 TrustedDeviceMethodLibsecret 常量（命名沿用「Linux 上 keyring
// 抽象层」的事实标准 libsecret，即便我们实际走 D-Bus 而非 libsecret.so）。
func (p *linuxSecretServiceProtector) Method() string {
	return TrustedDeviceMethodLibsecret
}

// Protect 把 plaintext 存到 secret-service，返回 item path 字节作为 blob
//
// 流程：
//  1. 连 bus + OpenSession（plain transport）
//  2. 按 attributes 搜旧 item，全部 Delete 清理（避免重复启用堆积）
//  3. Unlock 默认 collection（KDE Wallet 默认锁；gnome-keyring 通常已解）
//  4. CreateItem(properties, secret, replace=true) 写入新 item
//  5. 返回 item path 的 UTF-8 字节
//
// 错误：
//   - bus / daemon 不可用 → 返回错误（调用方判定为 enable 失败）
//   - collection 解锁失败（用户取消 prompt / 输错 master password）→ 错误
//   - CreateItem 失败 → 错误
//
// 不返回 ErrTrustedDeviceUnsupported —— Available 已经做过预检；走到这里
// 说明运行时出了意外，错误信息应当上抛便于诊断。
func (p *linuxSecretServiceProtector) Protect(plaintext []byte) ([]byte, error) {
	if len(plaintext) == 0 {
		return nil, fmt.Errorf("secret-service protect: plaintext is empty")
	}

	conn, err := dbus.SessionBus()
	if err != nil {
		return nil, fmt.Errorf("secret-service protect: connect session bus: %w", err)
	}

	session, err := openSession(conn)
	if err != nil {
		return nil, fmt.Errorf("secret-service protect: open session: %w", err)
	}
	defer closeSession(conn, session)

	// 清理旧 item —— 用户可能重复启用 / 之前异常残留 item
	// 失败不致命（最坏情况是 daemon 里堆冗余 item，不影响功能）
	if err := deleteItemsByAttributes(conn); err != nil {
		// 仅日志级别，不阻断 enable 流程
		_ = err
	}

	if err := unlockDefaultCollection(conn); err != nil {
		return nil, fmt.Errorf("secret-service protect: unlock collection: %w", err)
	}

	itemPath, err := createItem(conn, session, plaintext)
	if err != nil {
		return nil, fmt.Errorf("secret-service protect: create item: %w", err)
	}

	return []byte(itemPath), nil
}

// Unprotect 用 blob (item path) 从 secret-service 读回 plaintext
//
// 任何失败包装为 ErrTrustedDeviceUnprotect —— 调用方 (vaultservice) 据此
// 静默清行回退主密码模式，与 Windows DPAPI 路径行为对齐。
//
// 典型失败原因：
//   - daemon 没起来（用户切换桌面环境后 daemon 路径变了）
//   - collection 锁住且 unlock 失败（用户取消 prompt）
//   - item 已被用户手动从 seahorse / kwalletmanager 里删了
//   - 跨机器拷 vault.db 过来（item path 在新机器上不存在）
func (p *linuxSecretServiceProtector) Unprotect(blob []byte) ([]byte, error) {
	if len(blob) == 0 {
		return nil, fmt.Errorf("%w: blob is empty", ErrTrustedDeviceUnprotect)
	}

	itemPath := dbus.ObjectPath(string(blob))
	if !itemPath.IsValid() {
		return nil, fmt.Errorf("%w: invalid item path", ErrTrustedDeviceUnprotect)
	}

	conn, err := dbus.SessionBus()
	if err != nil {
		return nil, fmt.Errorf("%w: connect session bus: %v", ErrTrustedDeviceUnprotect, err)
	}

	session, err := openSession(conn)
	if err != nil {
		return nil, fmt.Errorf("%w: open session: %v", ErrTrustedDeviceUnprotect, err)
	}
	defer closeSession(conn, session)

	// item 所在 collection 可能被锁 —— 先 unlock item（spec 允许直接
	// 传 item path 给 Unlock，daemon 内部解所在 collection）
	if err := unlockObjects(conn, []dbus.ObjectPath{itemPath}); err != nil {
		return nil, fmt.Errorf("%w: unlock item: %v", ErrTrustedDeviceUnprotect, err)
	}

	item := conn.Object(ssBusName, itemPath)
	var secret secretStruct
	if err := item.Call(ssIfaceItem+".GetSecret", 0, session).Store(&secret); err != nil {
		return nil, fmt.Errorf("%w: get secret: %v", ErrTrustedDeviceUnprotect, err)
	}

	// 拷贝一份返回 —— secret.Value 由 godbus 管理，不应当被调用方持有
	out := make([]byte, len(secret.Value))
	copy(out, secret.Value)
	return out, nil
}

// probeSecretService 检测 Secret Service 是否真的可用
//
// 三步检查：
//  1. SessionBus() —— 拿 shared 连接（没 DBUS_SESSION_BUS_ADDRESS 会失败）
//  2. NameHasOwner —— 确认 org.freedesktop.secrets 已注册（daemon 在跑）
//  3. Ping —— 确认 daemon 真的能响应（注册了但 hang 死的极端情况）
//
// 任何一步失败都返回 false，永不 panic。
func probeSecretService() bool {
	conn, err := dbus.SessionBus()
	if err != nil {
		return false
	}

	var hasOwner bool
	err = conn.BusObject().Call(
		"org.freedesktop.DBus.NameHasOwner", 0, ssBusName,
	).Store(&hasOwner)
	if err != nil || !hasOwner {
		return false
	}

	// Ping —— 内置接口，所有 D-Bus 服务都必须响应
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err = conn.Object(ssBusName, ssObjectPath).
		CallWithContext(ctx, "org.freedesktop.DBus.Peer.Ping", 0).Err
	return err == nil
}

// openSession 与 Secret Service 建立 plain transport 会话
//
// 返回 session ObjectPath；调用方用完应 closeSession 释放。
//
// "plain" algorithm 的输入是空 variant —— spec 要求传 Variant("")。
func openSession(conn *dbus.Conn) (dbus.ObjectPath, error) {
	svc := conn.Object(ssBusName, ssObjectPath)

	var output dbus.Variant
	var session dbus.ObjectPath
	err := svc.Call(ssIfaceService+".OpenSession", 0,
		ssAlgorithmPlain, dbus.MakeVariant("")).Store(&output, &session)
	if err != nil {
		return "", err
	}
	_ = output // plain transport 下 output 是空 variant，忽略
	return session, nil
}

// closeSession 释放 OpenSession 拿到的 session
//
// daemon 端会在连接断开时自动清理，所以失败可以忽略 —— 仅作为良好习惯。
func closeSession(conn *dbus.Conn, session dbus.ObjectPath) {
	_ = conn.Object(ssBusName, session).
		Call(ssIfaceSessionClose, 0).Err
}

// ssIfaceSessionClose 是 Session.Close 方法的全限定名
//
// 单独拎出来是因为 Close 名字太通用、容易在 grep 时跟其他 Close 混淆。
const ssIfaceSessionClose = "org.freedesktop.Secret.Session.Close"

// unlockDefaultCollection 解锁默认 collection
//
// 大多数 daemon 在用户登录后 collection 已经解锁，这里调用是 no-op
// （Unlock 返回的 unlocked 列表立即包含我们的 path）。KDE Wallet 等
// 默认锁的 daemon 会弹出 prompt，我们用 waitForPrompt 等待用户输入
// master password。
func unlockDefaultCollection(conn *dbus.Conn) error {
	return unlockObjects(conn, []dbus.ObjectPath{ssDefaultCollection})
}

// unlockObjects 解锁任意一组 collection / item
//
// Unlock 同步返回已解锁列表 + prompt path。prompt path = "/" 表示
// 无需 UI 交互（已解锁或 daemon 不要求确认）；否则启动 prompt 流程
// 等待用户输入。
//
// 返回 nil 表示 objects 全部解锁；否则带具体错误。
func unlockObjects(conn *dbus.Conn, objects []dbus.ObjectPath) error {
	svc := conn.Object(ssBusName, ssObjectPath)

	var unlocked []dbus.ObjectPath
	var prompt dbus.ObjectPath
	err := svc.Call(ssIfaceService+".Unlock", 0, objects).Store(&unlocked, &prompt)
	if err != nil {
		return err
	}

	if prompt == "/" {
		return nil
	}

	// 走 prompt 流程 —— daemon 会弹 UI，我们等结果
	return waitForPrompt(conn, prompt)
}

// waitForPrompt 处理需要用户交互的 Prompt
//
// Secret Service 的 Prompt 模型：
//  1. 订阅 Completed signal
//  2. 调 Prompt.Prompt("") 触发 UI
//  3. 等 signal 回来 —— dismissed=true 表示用户取消
//
// 超时 ssPromptTimeout 防止 prompt 永不返回（罕见 daemon bug）。
func waitForPrompt(conn *dbus.Conn, prompt dbus.ObjectPath) error {
	// 订阅 Completed signal
	matchOpts := []dbus.MatchOption{
		dbus.WithMatchObjectPath(prompt),
		dbus.WithMatchInterface(ssIfacePrompt),
		dbus.WithMatchMember("Completed"),
	}
	if err := conn.AddMatchSignal(matchOpts...); err != nil {
		return fmt.Errorf("add match signal: %w", err)
	}
	defer func() { _ = conn.RemoveMatchSignal(matchOpts...) }()

	ch := make(chan *dbus.Signal, 4)
	conn.Signal(ch)
	defer conn.RemoveSignal(ch)

	// 触发 prompt —— 第二参数是 windowID（X11/Wayland 用），传 "" 让
	// daemon 用自己的策略放置 prompt 窗口
	if err := conn.Object(ssBusName, prompt).
		Call(ssIfacePrompt+".Prompt", 0, "").Err; err != nil {
		return fmt.Errorf("trigger prompt: %w", err)
	}

	timer := time.NewTimer(ssPromptTimeout)
	defer timer.Stop()

	for {
		select {
		case sig := <-ch:
			if sig == nil || sig.Path != prompt {
				continue
			}
			// Completed signal payload: (dismissed bool, result variant)
			if len(sig.Body) < 1 {
				return errors.New("prompt: malformed signal")
			}
			dismissed, _ := sig.Body[0].(bool)
			if dismissed {
				return errors.New("prompt: user dismissed")
			}
			return nil
		case <-timer.C:
			return errors.New("prompt: timeout")
		}
	}
}

// createItem 在默认 collection 创建 secret item
//
// replace=true：若 daemon 端按 attributes 匹配到已存在 item 就覆盖。
// 我们 Protect 之前已经显式 deleteItemsByAttributes，replace 是双保险。
//
// label 仅作 UI 展示（seahorse / kwalletmanager 列表里看到的名字），
// 不影响检索。
func createItem(conn *dbus.Conn, session dbus.ObjectPath, value []byte) (dbus.ObjectPath, error) {
	collection := conn.Object(ssBusName, ssDefaultCollection)

	properties := map[string]dbus.Variant{
		ssIfaceItem + ".Label":      dbus.MakeVariant("ZPass trusted device key"),
		ssIfaceItem + ".Attributes": dbus.MakeVariant(trustedDeviceAttributes),
	}

	secret := secretStruct{
		Session:     session,
		Parameters:  []byte{},
		Value:       value,
		ContentType: ssContentType,
	}

	var itemPath, promptPath dbus.ObjectPath
	err := collection.Call(ssIfaceCollection+".CreateItem", 0,
		properties, secret, true).Store(&itemPath, &promptPath)
	if err != nil {
		return "", err
	}

	// CreateItem 可能返回 prompt（极少见，通常 daemon 直接完成）
	if promptPath != "/" {
		if err := waitForPrompt(conn, promptPath); err != nil {
			return "", fmt.Errorf("create item prompt: %w", err)
		}
		// prompt 完成后 daemon 把 result 写回 item，但 spec 没规定从
		// prompt result 取 path —— 用 SearchItems 找一遍是稳妥做法
		path, err := findItemByAttributes(conn)
		if err != nil {
			return "", fmt.Errorf("create item: locate after prompt: %w", err)
		}
		return path, nil
	}

	return itemPath, nil
}

// findItemByAttributes 用 attributes 查找首个匹配 item
//
// 用于 CreateItem 走 prompt 流程后定位实际 item path。正常路径下
// CreateItem 直接返回 itemPath，不会走到这里。
func findItemByAttributes(conn *dbus.Conn) (dbus.ObjectPath, error) {
	svc := conn.Object(ssBusName, ssObjectPath)

	var unlocked, locked []dbus.ObjectPath
	err := svc.Call(ssIfaceService+".SearchItems", 0,
		trustedDeviceAttributes).Store(&unlocked, &locked)
	if err != nil {
		return "", err
	}

	if len(unlocked) > 0 {
		return unlocked[0], nil
	}
	if len(locked) > 0 {
		return locked[0], nil
	}
	return "", errors.New("not found")
}

// deleteItemsByAttributes 删除所有匹配 attributes 的 item
//
// Protect 前调用 —— 清理重复启用时的孤儿 item。每个 Item.Delete 可能
// 返回 prompt（gnome-keyring 默认不弹；kwallet 可能问一下），统一走
// waitForPrompt 处理。
//
// 失败不致命 —— 最坏情况是 daemon 里堆冗余 item（不影响功能，仅占空间）。
func deleteItemsByAttributes(conn *dbus.Conn) error {
	svc := conn.Object(ssBusName, ssObjectPath)

	var unlocked, locked []dbus.ObjectPath
	if err := svc.Call(ssIfaceService+".SearchItems", 0,
		trustedDeviceAttributes).Store(&unlocked, &locked); err != nil {
		return err
	}

	all := append(unlocked, locked...) //nolint:gocritic // append fine here
	for _, path := range all {
		var promptPath dbus.ObjectPath
		if err := conn.Object(ssBusName, path).
			Call(ssIfaceItem+".Delete", 0).Store(&promptPath); err != nil {
			continue
		}
		if promptPath != "/" {
			_ = waitForPrompt(conn, promptPath)
		}
	}
	return nil
}
