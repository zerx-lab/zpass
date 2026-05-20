//! ZPass SSH agent 守护进程（spec/08）。
//!
//! 启动流程：
//! 1. 加载 capability token（`<config_root>/agent.cap`，不存在则生成 0600）。
//! 2. 启动 SSH agent UDS listener（`$XDG_RUNTIME_DIR/zpass/agent.sock`）。
//! 3. 启动控制通道 client（connect to GUI's UDS server with backoff）。
//! 4. 主循环：accept ssh-client 连接 → 派一个 handler 线程。
//!
//! 当前 D2 sub-phase 只实现：
//! - agent_proto 模块（解码/编码 OpenSSH agent message）
//! - state 模块（共享状态）
//!
//! 实际的 listener / 控制通道 client / handler 三个并发组件在 D2 续作里加。

// D2 第一批：协议解析 + 共享状态。下一批 sub-phase 接入 listener / 控制通道 / handler
// 后会主动消费这些 API；先放宽 dead_code 以便单独提交。
#[allow(dead_code)]
mod agent_proto;
#[allow(dead_code)]
mod state;

fn main() {
    eprintln!(
        "zpass-agent: skeleton ready (D2 部分实现 — agent_proto + state)；\n\
         完整 listener / 控制通道 / handler 在后续 sub-phase 完成。"
    );
}

// 让 D1 测试链上 zpass-ssh-agent-proto 即使 main.rs 不直接引用它也保留 link。
#[allow(dead_code)]
fn _link_proto() {
    use zpass_ssh_agent_proto::AgentMessage;
    let _ = AgentMessage::Bye;
}
