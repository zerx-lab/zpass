//! Phase B 的 4 屏：welcome / onboarding / unlock / vault。

mod onboarding;
mod unlock;
mod vault;
mod welcome;

pub use onboarding::OnboardingView;
pub use unlock::UnlockView;
pub use vault::VaultView;
pub use welcome::WelcomeView;

#[cfg(test)]
mod tests;
