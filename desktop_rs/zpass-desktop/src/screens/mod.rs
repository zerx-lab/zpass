//! Phase C 终态 7 屏：welcome / onboarding / unlock / vault / totp / generator / import_export。

mod generator;
mod import_export;
mod onboarding;
mod totp;
mod unlock;
mod vault;
mod welcome;

pub use generator::GeneratorView;
pub use import_export::ImportExportView;
pub use onboarding::OnboardingView;
pub use totp::TotpView;
pub use unlock::UnlockView;
pub use vault::VaultView;
pub use welcome::WelcomeView;

#[cfg(test)]
mod tests;
