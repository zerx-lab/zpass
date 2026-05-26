//! Manifest diff + [`MergePlan`] generation.
//!
//! Given the local and remote manifests, [`plan_merge`] produces a structured
//! plan describing:
//!   - what to pull from the peer and apply locally (`pull_apply`)
//!   - what to push to the peer (`push`)
//!   - per-item conflicts that require human decision (`conflicts`)
//!
//! The algorithm is intentionally symmetric: calling `plan_merge(local, remote)`
//! on one side and `plan_merge(remote, local)` on the other side identifies
//! the same set of conflicts, so the desktop side can render the UI no matter
//! which peer initiated.
//!
//! ### Decision matrix (`local` vs `remote`, by `(updated_at, deleted_at)`)
//!
//! | local present? | remote present? | rule                                            |
//! |---|---|---|
//! | no | no  | impossible                                       |
//! | no | yes | pull (or do nothing if remote is tombstone)      |
//! | yes| no  | push (or do nothing if local is tombstone)       |
//! | yes| yes | see "both present" matrix below                  |
//!
//! Both present:
//!
//! | updated_at | content_hash | action                                       |
//! |---|---|---|
//! | equal      | equal        | skip (identical)                             |
//! | equal      | different    | **conflict** (concurrent edit, same clock)   |
//! | different  | equal        | apply newer side (metadata-only change)      |
//! | different  | different    | **conflict** unless one side is tombstone    |
//!
//! Tombstone-vs-edit:
//!   - newer side tombstone → apply tombstone (the peer must have known the
//!     contents before deleting); we still surface this as a conflict so the
//!     user has a chance to undelete.
//!   - older side tombstone, newer side edit → treat as "restore" conflict —
//!     the user may want to keep their delete or take the new edit.
//!
//! Rust guideline compliant 2026-02-21

use std::collections::HashMap;

use crate::sync::proto::ManifestEntryWire;

/// Public summary of one item's pre-merge state on either side.
///
/// Mirrors [`ManifestEntryWire`] but only with the fields merge cares about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestEntry {
    pub id: String,
    pub updated_at: i64,
    /// 0 = not deleted
    pub deleted_at: i64,
    /// Empty string when sender omitted the hash.
    pub content_hash: String,
    pub revision: i64,
}

impl From<ManifestEntryWire> for ManifestEntry {
    fn from(w: ManifestEntryWire) -> Self {
        Self {
            id: w.id,
            updated_at: w.updated_at,
            deleted_at: w.deleted_at,
            content_hash: w.content_hash,
            revision: w.revision,
        }
    }
}

impl From<&ManifestEntryWire> for ManifestEntry {
    fn from(w: &ManifestEntryWire) -> Self {
        Self {
            id: w.id.clone(),
            updated_at: w.updated_at,
            deleted_at: w.deleted_at,
            content_hash: w.content_hash.clone(),
            revision: w.revision,
        }
    }
}

impl ManifestEntry {
    pub fn is_tombstone(&self) -> bool {
        self.deleted_at > 0
    }
}

/// What kind of conflict was detected, used by the UI for grouping.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConflictKind {
    /// Both sides edited the same item with the same `updated_at`.
    ConcurrentEdit,
    /// `updated_at` differs but content_hash differs too — last-write-wins
    /// would lose information, so we ask the user.
    DivergentContent,
    /// One side deleted while the other side edited.
    DeleteVsEdit {
        local_deleted: bool,
        remote_deleted: bool,
    },
}

/// A single conflict requiring human resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PerItemConflict {
    pub id: String,
    pub kind: ConflictKind,
    pub local: ManifestEntry,
    pub remote: ManifestEntry,
    /// The side `plan_merge` would have chosen under last-write-wins.
    /// `true` = remote, `false` = local. The UI uses this for default
    /// radio selection.
    pub suggested_remote: bool,
}

/// Action to apply on either side (in `MergePlan.pull_apply` / `push`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyAction {
    /// Insert a brand-new row.
    Insert,
    /// Overwrite existing row's payload (and possibly clear tombstone).
    Replace,
    /// Tombstone an existing row (set deleted_at).
    Delete,
}

/// One step in a merge plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanStep {
    pub id: String,
    pub action: ApplyAction,
}

/// Output of [`plan_merge`].
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MergePlan {
    /// Items the local side must pull (fetch ciphertext from remote) and apply.
    pub pull_apply: Vec<PlanStep>,
    /// Items the local side must push to the remote.
    pub push: Vec<PlanStep>,
    /// Items requiring a human decision before either side can commit.
    pub conflicts: Vec<PerItemConflict>,
    /// IDs that are already in sync (no action needed).
    pub identical: Vec<String>,
}

impl MergePlan {
    pub fn is_empty(&self) -> bool {
        self.pull_apply.is_empty() && self.push.is_empty() && self.conflicts.is_empty()
    }
}

/// Compute a [`MergePlan`] from local & remote manifests.
///
/// Pure function — no IO, no allocation beyond the output. Safe to run in a
/// tight loop on both ends to verify they agree.
pub fn plan_merge(
    local: &[ManifestEntry],
    remote: &[ManifestEntry],
) -> MergePlan {
    let mut by_id_local: HashMap<&str, &ManifestEntry> =
        local.iter().map(|e| (e.id.as_str(), e)).collect();
    let mut by_id_remote: HashMap<&str, &ManifestEntry> =
        remote.iter().map(|e| (e.id.as_str(), e)).collect();

    let mut plan = MergePlan::default();

    // First pass: ids on remote, optionally also on local.
    for r in remote {
        let local_opt = by_id_local.remove(r.id.as_str());
        by_id_remote.remove(r.id.as_str());
        match local_opt {
            None => {
                if !r.is_tombstone() {
                    plan.pull_apply.push(PlanStep {
                        id: r.id.clone(),
                        action: ApplyAction::Insert,
                    });
                }
                // remote-only tombstone with no local row: no-op (nothing to
                // tombstone locally either)
            }
            Some(l) => decide_both_present(l, r, &mut plan),
        }
    }

    // Second pass: ids only on local.
    for l in local {
        if !by_id_local.contains_key(l.id.as_str()) {
            continue;
        }
        if l.is_tombstone() {
            // Pure local-only tombstone — peer never knew about it; once we
            // push the tombstone the peer will hold it as a no-op. Still
            // push so future syncs see consistent state.
            plan.push.push(PlanStep {
                id: l.id.clone(),
                action: ApplyAction::Insert,
            });
        } else {
            plan.push.push(PlanStep {
                id: l.id.clone(),
                action: ApplyAction::Insert,
            });
        }
    }

    plan
}

fn decide_both_present(local: &ManifestEntry, remote: &ManifestEntry, plan: &mut MergePlan) {
    let same_ts = local.updated_at == remote.updated_at;
    let same_hash = !local.content_hash.is_empty()
        && !remote.content_hash.is_empty()
        && local.content_hash == remote.content_hash;

    if same_ts && same_hash {
        plan.identical.push(local.id.clone());
        return;
    }

    // Tombstone-vs-edit: surface as conflict so the user can choose.
    if local.is_tombstone() != remote.is_tombstone() {
        let newer_remote = remote.updated_at > local.updated_at;
        plan.conflicts.push(PerItemConflict {
            id: local.id.clone(),
            kind: ConflictKind::DeleteVsEdit {
                local_deleted: local.is_tombstone(),
                remote_deleted: remote.is_tombstone(),
            },
            local: local.clone(),
            remote: remote.clone(),
            suggested_remote: newer_remote,
        });
        return;
    }

    if same_ts {
        // Same clock, different content → concurrent edit conflict.
        plan.conflicts.push(PerItemConflict {
            id: local.id.clone(),
            kind: ConflictKind::ConcurrentEdit,
            local: local.clone(),
            remote: remote.clone(),
            // Tie-breaker for default UI selection: prefer the longer revision
            // (more writes ⇒ likely the more-actively-edited side).
            suggested_remote: remote.revision > local.revision,
        });
        return;
    }

    // Different timestamp, both tombstones or both active. If hashes match,
    // metadata-only change → silently take the newer side. Otherwise the
    // content actually differs and we ask the user.
    if same_hash {
        if remote.updated_at > local.updated_at {
            plan.pull_apply.push(PlanStep {
                id: local.id.clone(),
                action: if remote.is_tombstone() {
                    ApplyAction::Delete
                } else {
                    ApplyAction::Replace
                },
            });
        } else {
            plan.push.push(PlanStep {
                id: local.id.clone(),
                action: if local.is_tombstone() {
                    ApplyAction::Delete
                } else {
                    ApplyAction::Replace
                },
            });
        }
        return;
    }

    // Content actually different → conflict.
    plan.conflicts.push(PerItemConflict {
        id: local.id.clone(),
        kind: ConflictKind::DivergentContent,
        local: local.clone(),
        remote: remote.clone(),
        suggested_remote: remote.updated_at > local.updated_at,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, updated: i64, deleted: i64, hash: &str) -> ManifestEntry {
        ManifestEntry {
            id: id.into(),
            updated_at: updated,
            deleted_at: deleted,
            content_hash: hash.into(),
            revision: 1,
        }
    }

    #[test]
    fn empty_manifests_yield_empty_plan() {
        let p = plan_merge(&[], &[]);
        assert!(p.is_empty());
    }

    #[test]
    fn remote_only_active_item_pulls() {
        let p = plan_merge(&[], &[entry("a", 100, 0, "h")]);
        assert_eq!(p.pull_apply.len(), 1);
        assert_eq!(p.pull_apply[0].action, ApplyAction::Insert);
        assert!(p.push.is_empty());
    }

    #[test]
    fn remote_only_tombstone_is_noop() {
        let p = plan_merge(&[], &[entry("a", 100, 99, "h")]);
        assert!(p.is_empty());
    }

    #[test]
    fn local_only_pushes() {
        let p = plan_merge(&[entry("a", 100, 0, "h")], &[]);
        assert_eq!(p.push.len(), 1);
    }

    #[test]
    fn identical_skipped() {
        let p = plan_merge(
            &[entry("a", 100, 0, "h")],
            &[entry("a", 100, 0, "h")],
        );
        assert_eq!(p.identical, vec!["a".to_string()]);
        assert!(p.pull_apply.is_empty());
        assert!(p.push.is_empty());
    }

    #[test]
    fn same_ts_different_hash_is_concurrent_conflict() {
        let p = plan_merge(
            &[entry("a", 100, 0, "h1")],
            &[entry("a", 100, 0, "h2")],
        );
        assert_eq!(p.conflicts.len(), 1);
        assert!(matches!(p.conflicts[0].kind, ConflictKind::ConcurrentEdit));
    }

    #[test]
    fn newer_remote_with_matching_hash_auto_applies() {
        let p = plan_merge(
            &[entry("a", 100, 0, "h")],
            &[entry("a", 200, 0, "h")],
        );
        assert_eq!(p.pull_apply.len(), 1);
        assert_eq!(p.pull_apply[0].action, ApplyAction::Replace);
    }

    #[test]
    fn different_hash_different_ts_is_divergent_conflict() {
        let p = plan_merge(
            &[entry("a", 100, 0, "h1")],
            &[entry("a", 200, 0, "h2")],
        );
        assert_eq!(p.conflicts.len(), 1);
        assert!(matches!(
            p.conflicts[0].kind,
            ConflictKind::DivergentContent
        ));
        assert!(p.conflicts[0].suggested_remote);
    }

    #[test]
    fn local_active_remote_tombstone_is_delete_vs_edit() {
        let p = plan_merge(
            &[entry("a", 100, 0, "h")],
            &[entry("a", 200, 200, "h")],
        );
        assert_eq!(p.conflicts.len(), 1);
        match &p.conflicts[0].kind {
            ConflictKind::DeleteVsEdit { local_deleted, remote_deleted } => {
                assert!(!*local_deleted);
                assert!(*remote_deleted);
            }
            other => panic!("unexpected kind: {other:?}"),
        }
        assert!(p.conflicts[0].suggested_remote);
    }

    #[test]
    fn empty_content_hash_treats_as_unknown_not_match() {
        // both sides omit the hash → should NOT short-circuit to identical
        // (different updated_at remains a divergence).
        let p = plan_merge(
            &[entry("a", 100, 0, "")],
            &[entry("a", 200, 0, "")],
        );
        // updated_at differs, no hash match → conflict
        assert_eq!(p.conflicts.len(), 1);
    }

    #[test]
    fn many_items_partitioned_correctly() {
        let local = vec![
            entry("identical", 1, 0, "h"),
            entry("local-newer", 5, 0, "h"),
            entry("remote-newer", 1, 0, "h"),
            entry("local-only", 1, 0, "h"),
            entry("concurrent", 3, 0, "h1"),
        ];
        let remote = vec![
            entry("identical", 1, 0, "h"),
            entry("local-newer", 1, 0, "h"),
            entry("remote-newer", 5, 0, "h"),
            entry("remote-only", 1, 0, "h"),
            entry("concurrent", 3, 0, "h2"),
        ];
        let p = plan_merge(&local, &remote);
        assert!(p.identical.contains(&"identical".to_string()));
        assert!(p.push.iter().any(|s| s.id == "local-newer"));
        assert!(p.push.iter().any(|s| s.id == "local-only"));
        assert!(p.pull_apply.iter().any(|s| s.id == "remote-newer"));
        assert!(p.pull_apply.iter().any(|s| s.id == "remote-only"));
        assert!(p.conflicts.iter().any(|c| c.id == "concurrent"));
    }
}
